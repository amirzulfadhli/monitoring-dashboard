/**
 * Central retention + maintenance policy for persisted monitoring data.
 *
 * All magic durations for how long high-volume history survives live here so
 * storage modules never scatter retention numbers. Values are conservative for
 * a local, single-machine tool:
 *   - telemetry (`history`): 30d keeps the 24H / 7D / 30D UI ranges intact.
 *   - website checks:         30d
 *   - API checks:             30d
 *   - device checks:          30d
 *   - storage volume checks:  30d
 *   - AI usage:               90d  (transcript cursor, not rows, guarantees
 *                                   Claude Code idempotency — see index.ts)
 *   - GitHub snapshots:       90d
 *   - notifications:          30d  (a derived inbox — bounded, not a record of
 *                                   fact; the alerts it was derived from remain)
 */

const DAY_MS = 86_400_000;

export const RETENTION_MS = {
  telemetry: 30 * DAY_MS, // history table — must stay >= 30d for the 30D UI range
  websiteChecks: 30 * DAY_MS,
  apiChecks: 30 * DAY_MS,
  deviceChecks: 30 * DAY_MS,
  // Sampled far less often than the other checks, so this is a small number of
  // rows: it exists to bound the table, not to reduce volume.
  storageChecks: 30 * DAY_MS,
  aiUsage: 90 * DAY_MS,
  githubSnapshots: 90 * DAY_MS,
  // The inbox is a convenience view over alert transitions, so it is bounded on
  // the same conservative 30d horizon as the rest of the operational history.
  // Pruning it removes notifications only — never the alert they describe.
  notifications: 30 * DAY_MS,
} as const;

/**
 * How often maintenance may actually prune per process. A once-daily guard is
 * preferred: callers may invoke the (cheap) guard as often as they like, but a
 * full prune never runs more than ~once a day.
 */
export const MAINTENANCE_INTERVAL_MS = DAY_MS;

/** Short back-off when the DB is momentarily unavailable, to avoid hammering. */
export const MAINTENANCE_RETRY_MS = 60_000;
