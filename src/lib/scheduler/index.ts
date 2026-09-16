/**
 * DevPulse background monitoring scheduler.
 *
 * Decouples data capture from the browser: the same server-side collectors the
 * API routes already use are driven on fixed cadences, so telemetry, website
 * checks, GitHub snapshots and alert evaluation keep happening while no
 * dashboard tab is open. The routes then serve the most recent collected
 * state, making the browser a consumer instead of the capture engine.
 *
 *   telemetry job    ~30s   collectTelemetry()          + persistSnapshot()
 *   websites job     ~60s   getWebsiteResults()         (persists internally)
 *   github job       ~90s   getGitHubResult()           + persistGithubSnapshots()
 *   alerts job       ~60s   evaluateAlerts()            + opportunistic retention
 *
 * Design constraints:
 * - The whole scheduler lives in this one Node process (V1 assumption: a
 *   persistent `next dev` / `next start` process, never serverless).
 * - Exactly one instance per process, enforced by a globalThis-backed store, so
 *   dev-mode hot reload cannot stack duplicate timers.
 * - Each job is isolated: a throw is recorded against that job and nothing else.
 * - Each job is single-flight: a fire that lands while the previous run is still
 *   in flight is skipped (counted), never queued.
 * - Timers are unref'd so they never hold the process open on shutdown.
 */
import { collectTelemetry } from "@/lib/telemetry";
import { persistSnapshot } from "@/lib/telemetry/storage";
import { getWebsiteResults } from "@/lib/monitoring/websites";
import { getGitHubResult } from "@/lib/monitoring/github";
import { persistGithubSnapshots } from "@/lib/monitoring/github-snapshots";
import { evaluateAlerts } from "@/lib/alerts/engine";
import { maybePruneExpired } from "@/lib/maintenance";
import { deriveCollectorState, sanitizeErrorMessage } from "./health";
import {
  JOB_CADENCE_MS,
  JOB_NAMES,
  JOB_STALE_AFTER_MS,
  type JobName,
  type JobStatus,
  type SchedulerStatus,
} from "./model";
import { getStore, type JobRuntime, type SchedulerStore } from "./store";

/**
 * Staggered first runs: the scheduler must never block boot, and firing every
 * job at once would put four collectors on the machine simultaneously.
 */
const START_DELAY_MS: Record<JobName, number> = {
  telemetry: 2_000,
  websites: 6_000,
  github: 10_000,
  alerts: 15_000,
};

type JobDef = {
  name: JobName;
  /** Collect/persist. Rejections are recorded as a failure for this job only. */
  run: (store: SchedulerStore) => Promise<void>;
  /**
   * Optional precondition. Returning a reason marks the job inactive for this
   * fire (recorded in status, skipped silently — no error, no log spam).
   */
  inactive?: () => string | null;
};

const JOBS: JobDef[] = [
  {
    name: "telemetry",
    async run(store) {
      const snapshot = await collectTelemetry();
      store.telemetry = { value: snapshot, at: Date.now() };
      const sys = snapshot.system;
      const net = snapshot.network;
      if (sys || net) {
        // Same persistence path the telemetry route used; storage keeps its own
        // ~30s guard, so this is at most one row per cadence.
        persistSnapshot({
          ts: snapshot.collectedAt,
          cpuPct: sys?.cpuUsagePct ?? null,
          usedMem: sys?.usedMem ?? null,
          availMem: sys?.availMem ?? null,
          rxRate: net?.rxRate ?? null,
          txRate: net?.txRate ?? null,
          rxTotal: net?.rxTotal ?? null,
          txTotal: net?.txTotal ?? null,
        });
      }
    },
  },
  {
    name: "websites",
    async run(store) {
      // Checks only currently-enabled targets and persists each result
      // independently; one failing site never blocks the others.
      const results = await getWebsiteResults();
      store.websites = { value: results, at: Date.now() };
    },
  },
  {
    name: "github",
    // Without a token every repo would degrade to a missing_token snapshot, so
    // the job is simply inactive rather than spending requests and logging.
    inactive: () =>
      process.env.GITHUB_TOKEN ? null : "GITHUB_TOKEN is not configured",
    async run(store) {
      const result = await getGitHubResult();
      store.github = { value: result, at: Date.now() };
      try {
        persistGithubSnapshots(result.repos);
      } catch {
        // Snapshot persistence is best-effort; the monitor run still counts.
      }
    },
  },
  {
    name: "alerts",
    async run() {
      // Deterministic rules over persisted/current source state — alert
      // evaluation performs no live external fetch of its own.
      await evaluateAlerts();
      // Opportunistic retention: cheap and self-throttled to ~once per day.
      maybePruneExpired();
    },
  },
];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Job definitions by name, for evaluating a precondition outside a fire. */
const JOBS_BY_NAME = new Map(JOBS.map((def) => [def.name, def]));

/**
 * Evaluate a job's inactive precondition defensively. `fallback` is what to
 * report if the precondition itself throws: a fire treats that as "carry on",
 * while status reporting keeps the last known reason.
 */
function evalInactive(def: JobDef | undefined, fallback: string | null): string | null {
  if (!def?.inactive) return null;
  try {
    return def.inactive();
  } catch {
    return fallback;
  }
}

/**
 * Configured credentials that must never reach the status payload. An upstream
 * error message can echo back the credential it was sent, so these values are
 * redacted verbatim on top of the generic token-shaped patterns.
 */
function secretValues(): string[] {
  return [process.env.GITHUB_TOKEN, process.env.DEEPSEEK_API_KEY].filter(
    (v): v is string => typeof v === "string" && v.length >= 8,
  );
}

/**
 * One fire of one job. Never rejects. Skips (rather than queues) when the
 * previous run of the same job is still in flight.
 */
async function fire(
  def: JobDef,
  store: SchedulerStore,
  state: JobRuntime,
): Promise<void> {
  if (state.running) {
    state.skipped++;
    return;
  }

  const reason = evalInactive(def, null);
  if (reason) {
    state.inactiveReason = reason;
    return;
  }
  state.inactiveReason = null;

  state.running = true;
  state.runs++;
  state.lastStartedAt = Date.now();
  const startedAt = state.lastStartedAt;
  try {
    await def.run(store);
    state.lastSuccessAt = Date.now();
    state.lastError = null;
    state.consecutiveFailures = 0;
  } catch (e) {
    // Isolation: a failing job is recorded here and nowhere else — the other
    // jobs keep their own timers and the process stays up.
    state.failures++;
    state.consecutiveFailures++;
    state.lastErrorAt = Date.now();
    // Sanitized at record time, so nothing unsanitized is ever stored or served.
    const message = sanitizeErrorMessage(errorText(e), secretValues());
    // Logged once per failure streak; a persistent fault does not spam.
    if (!state.lastError) {
      console.warn(`[scheduler] ${def.name} job failed: ${message}`);
    }
    state.lastError = message;
  } finally {
    state.running = false;
    state.lastFinishedAt = Date.now();
    state.lastDurationMs = state.lastFinishedAt - startedAt;
  }
}

function startJob(store: SchedulerStore, def: JobDef): void {
  const state = store.jobs[def.name];
  const cadence = JOB_CADENCE_MS[def.name];

  const initial = setTimeout(() => {
    void fire(def, store, state);
  }, START_DELAY_MS[def.name]);
  const interval = setInterval(() => {
    void fire(def, store, state);
  }, cadence);

  // Never hold the process open; a clean shutdown must still be possible.
  initial.unref?.();
  interval.unref?.();
  store.timers += 2;
}

/**
 * Start the scheduler once for this process. Safe to call from anywhere and on
 * every request: repeated calls (including after a dev-mode module reload) are
 * no-ops, so no duplicate timers are ever created.
 *
 * Returns true only for the call that actually started it.
 */
export function ensureSchedulerStarted(): boolean {
  const store = getStore();
  if (store.started) return false;
  store.started = true;
  store.startedAt = Date.now();
  for (const def of JOBS) startJob(store, def);
  console.log(
    `[scheduler] started — ${JOB_NAMES.map(
      (n) => `${n} ${JOB_CADENCE_MS[n] / 1000}s`,
    ).join(", ")}`,
  );
  return true;
}

function jobStatus(name: JobName, store: SchedulerStore, now: number): JobStatus {
  const s = store.jobs[name];
  const staleAfterMs = JOB_STALE_AFTER_MS[name];
  // Evaluated live, not read from the last fire: an unconfigured collector must
  // read inactive from the first status request, before it has ever run.
  const inactiveReason = evalInactive(JOBS_BY_NAME.get(name), s.inactiveReason);
  const state = deriveCollectorState({
    now,
    startedAt: store.startedAt,
    staleAfterMs,
    inactiveReason,
    consecutiveFailures: s.consecutiveFailures,
    lastSuccessAt: s.lastSuccessAt,
  });
  return {
    cadenceMs: JOB_CADENCE_MS[name],
    staleAfterMs,
    state,
    running: s.running,
    inactiveReason,
    lastStartedAt: s.lastStartedAt,
    lastFinishedAt: s.lastFinishedAt,
    lastSuccessAt: s.lastSuccessAt,
    lastErrorAt: s.lastErrorAt,
    lastError: s.lastError,
    lastDurationMs: s.lastDurationMs,
    runs: s.runs,
    skipped: s.skipped,
    failures: s.failures,
    consecutiveFailures: s.consecutiveFailures,
  };
}

/**
 * Read-only status snapshot. No secrets: job bookkeeping and the overall
 * freshness verdict only.
 */
export function getSchedulerStatus(now: number = Date.now()): SchedulerStatus {
  const store = getStore();
  const jobs = {} as Record<JobName, JobStatus>;
  for (const name of JOB_NAMES) jobs[name] = jobStatus(name, store, now);

  // Overall freshness follows the primary system sample (the telemetry job).
  const lastSampleAtMs =
    store.telemetry?.at ?? store.jobs.telemetry.lastSuccessAt;
  const ageMs = lastSampleAtMs == null ? null : now - lastSampleAtMs;
  let state: SchedulerStatus["freshness"]["state"] = "active";
  if (!store.started) state = "stale";
  else if (lastSampleAtMs == null) state = "starting";
  else if (ageMs != null && ageMs > JOB_STALE_AFTER_MS.telemetry) state = "stale";

  return {
    running: store.started,
    startedAt: store.startedAt,
    uptimeMs: store.startedAt == null ? null : now - store.startedAt,
    timers: store.timers,
    freshness: { state, lastSampleAtMs, ageMs },
    jobs,
  };
}

