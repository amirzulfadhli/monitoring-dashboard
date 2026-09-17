/**
 * Scheduler model: job names, fixed cadences, and the read-only status shape
 * served by GET /api/system/status.
 *
 * Types and constants only — safe to import from both server and client code
 * (the Overview freshness indicator imports this for the status shape).
 */

import type { CollectorState } from "./health";

export { COLLECTOR_STATE_LABELS, type CollectorState } from "./health";

export const JOB_NAMES = [
  "telemetry",
  "websites",
  "apis",
  "devices",
  "security",
  "storage",
  "github",
  "alerts",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Fixed cadences, deliberately modest — this is a local-first monitor, not a
 * high-frequency poller.
 */
export const JOB_CADENCE_MS: Record<JobName, number> = {
  telemetry: 30_000,
  websites: 60_000,
  apis: 60_000, // same cadence as website monitoring
  // Device reachability is one echo request per device; a minute is frequent
  // enough to notice a machine dropping off without being a network nuisance.
  devices: 60_000,
  // Local security state (firewall / Defender / listening sockets) changes on a
  // human timescale, so it is sampled far less often than the other collectors.
  security: 300_000,
  // Disk capacity changes on a human timescale (installs, logs, backups), so
  // storage is sampled on the same slow cadence as local security rather than
  // being polled aggressively.
  storage: 300_000,
  github: 90_000,
  alerts: 60_000,
};

/**
 * Staleness rule, kept explicit and simple: a source is stale once its last
 * successful collection is three cadences behind its expected interval.
 * Derived from JOB_CADENCE_MS so the multiple cannot drift per job.
 */
export const STALE_CADENCE_MULTIPLE = 3;

export const JOB_STALE_AFTER_MS: Record<JobName, number> = Object.fromEntries(
  JOB_NAMES.map((name) => [name, JOB_CADENCE_MS[name] * STALE_CADENCE_MULTIPLE]),
) as Record<JobName, number>;

export type JobStatus = {
  cadenceMs: number;
  staleAfterMs: number;
  /** Single health verdict for this collector (see lib/scheduler/health.ts). */
  state: CollectorState;
  running: boolean; // a run is in flight right now
  inactiveReason: string | null; // deliberately not collecting (e.g. no token)
  /** Last attempt, successful or not. */
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  /** Last successful run — the freshness reference. */
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  /** Sanitized; never contains tokens or secrets. */
  lastError: string | null;
  lastDurationMs: number | null;
  runs: number;
  /** Fires skipped because the previous run was still in flight. */
  skipped: number;
  /** Total failures since process start. */
  failures: number;
  /** Failures since the last success; > 0 means the latest run threw. */
  consecutiveFailures: number;
};

export type MonitoringFreshness = {
  /** starting = scheduler up but no sample landed yet. */
  state: "active" | "stale" | "starting";
  lastSampleAtMs: number | null;
  ageMs: number | null;
};

export type SchedulerStatus = {
  running: boolean;
  startedAt: number | null;
  uptimeMs: number | null;
  /** Live timer handles for this process: 2 per job. A duplicate scheduler
   * (e.g. after a hot reload) would show up here as a higher count. */
  timers: number;
  freshness: MonitoringFreshness;
  jobs: Record<JobName, JobStatus>;
};
