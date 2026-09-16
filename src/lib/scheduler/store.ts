/**
 * Process-wide scheduler state: the last collected result per source plus
 * per-job run bookkeeping.
 *
 * The state lives on `globalThis`, not in module scope, so a Next.js dev-mode
 * module reload (which re-evaluates this file) reuses the same object instead
 * of forking a second scheduler or losing the last collected values.
 *
 * Server-only. The API routes read the latest values from here so a browser
 * poll serves stored state instead of triggering fresh OS/network work.
 */
import type { TelemetrySnapshot } from "@/lib/telemetry";
import type { CheckResult } from "@/lib/monitoring/websites";
import type { ApiCheckResult } from "@/lib/monitoring/apis";
import type { GitHubResult } from "@/lib/monitoring/github";
import type { JobName } from "./model";

export type Latest<T> = { value: T; at: number };

export type SchedulerStore = {
  /** True once ensureSchedulerStarted() has run in this process. */
  started: boolean;
  startedAt: number | null;
  timers: number;
  jobs: Record<JobName, JobRuntime>;
  telemetry: Latest<TelemetrySnapshot> | null;
  websites: Latest<CheckResult[]> | null;
  apis: Latest<ApiCheckResult[]> | null;
  github: Latest<GitHubResult> | null;
};

/**
 * Mutable per-job bookkeeping. Deliberately separate from the serialized
 * JobStatus: this object is never handed to a client directly.
 */
export type JobRuntime = {
  running: boolean;
  inactiveReason: string | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runs: number;
  skipped: number;
  failures: number;
  /** Reset to 0 on success; drives the "failing" health state. */
  consecutiveFailures: number;
};

function emptyJob(): JobRuntime {
  return {
    running: false,
    inactiveReason: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastDurationMs: null,
    runs: 0,
    skipped: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
}

type GlobalWithStore = typeof globalThis & {
  __devpulseSchedulerStore?: SchedulerStore;
};

/** The process-wide store, created on first access. */
export function getStore(): SchedulerStore {
  const g = globalThis as GlobalWithStore;
  if (!g.__devpulseSchedulerStore) {
    g.__devpulseSchedulerStore = {
      started: false,
      startedAt: null,
      timers: 0,
      jobs: {
        telemetry: emptyJob(),
        websites: emptyJob(),
        apis: emptyJob(),
        github: emptyJob(),
        alerts: emptyJob(),
      },
      telemetry: null,
      websites: null,
      apis: null,
      github: null,
    };
  }
  return g.__devpulseSchedulerStore;
}

/** Latest scheduler-collected telemetry snapshot, or null before the first run. */
export function getLatestTelemetry(): Latest<TelemetrySnapshot> | null {
  return getStore().telemetry;
}

/** Latest scheduler-collected website check results. */
export function getLatestWebsites(): Latest<CheckResult[]> | null {
  return getStore().websites;
}

/** Latest scheduler-collected API check results. */
export function getLatestApis(): Latest<ApiCheckResult[]> | null {
  return getStore().apis;
}

/** Latest scheduler-collected GitHub monitor result. */
export function getLatestGithub(): Latest<GitHubResult> | null {
  return getStore().github;
}
