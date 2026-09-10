/**
 * Scheduler model: job names, fixed cadences, and the read-only status shape
 * served by GET /api/system/status.
 *
 * Types and constants only — safe to import from both server and client code
 * (the Overview freshness indicator imports this for the status shape).
 */

export const JOB_NAMES = ["telemetry", "websites", "github", "alerts"] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Fixed cadences, deliberately modest — this is a local-first monitor, not a
 * high-frequency poller.
 */
export const JOB_CADENCE_MS: Record<JobName, number> = {
  telemetry: 30_000,
  websites: 60_000,
  github: 90_000,
  alerts: 60_000,
};

/**
 * Staleness rule, kept explicit and simple: a source is stale once its last
 * successful collection is three cadences behind its expected interval.
 */
export const JOB_STALE_AFTER_MS: Record<JobName, number> = {
  telemetry: 90_000,
  websites: 180_000,
  github: 300_000,
  alerts: 180_000,
};

export type JobStatus = {
  cadenceMs: number;
  staleAfterMs: number;
  running: boolean; // a run is in flight right now
  stale: boolean; // last success is beyond staleAfterMs
  inactiveReason: string | null; // deliberately not collecting (e.g. no token)
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runs: number;
  /** Fires skipped because the previous run was still in flight. */
  skipped: number;
  failures: number;
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
