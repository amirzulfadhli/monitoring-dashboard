import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import {
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_RETRY_MS,
  RETENTION_MS,
} from "./config";

/**
 * Opportunistic retention pruning shared across the persisted monitoring tables
 * (telemetry `history`, `website_checks`, `api_checks`, `device_checks`,
 * `storage_volume_checks`, `ai_usage`, `github_snapshots`).
 *
 * Design mirrors the storage modules it cleans: its own DatabaseSync against the
 * same on-disk file, lazily opened, and every failure degrades to a no-op so a
 * maintenance hiccup can never break live telemetry/monitoring/ingestion.
 *
 * Callers invoke the cheap `maybePruneExpired()` from their write paths. A full
 * prune runs at most ~once per MAINTENANCE_INTERVAL_MS per process: the last-run
 * time is kept both in memory and in a tiny `maintenance_state` table, so neither
 * a flood of calls nor a restart causes repeated full prunes.
 *
 * Retention only ever deletes rows by their `ts` column. It never touches the
 * Claude Code ingestion cursor / meta tables, so pruning ai_usage cannot cause
 * historical transcript rows to be replayed (the byte-offset cursor is the
 * dedup authority, not the rows).
 */

/** The tables pruned by retention and the retention key each maps to. */
const PRUNE_TARGETS: { table: string; retentionMs: number }[] = [
  { table: "history", retentionMs: RETENTION_MS.telemetry },
  { table: "website_checks", retentionMs: RETENTION_MS.websiteChecks },
  { table: "api_checks", retentionMs: RETENTION_MS.apiChecks },
  { table: "device_checks", retentionMs: RETENTION_MS.deviceChecks },
  { table: "storage_volume_checks", retentionMs: RETENTION_MS.storageChecks },
  { table: "ai_usage", retentionMs: RETENTION_MS.aiUsage },
  { table: "github_snapshots", retentionMs: RETENTION_MS.githubSnapshots },
];

function readLastPruneAt(d: DatabaseSync): number | null {
  try {
    const r = d
      .prepare(`SELECT v FROM maintenance_state WHERE k = 'last_prune_at'`)
      .get() as { v: number } | undefined;
    return r ? r.v : null;
  } catch {
    return null;
  }
}

function writeLastPruneAt(d: DatabaseSync, now: number): void {
  try {
    d.prepare(
      `INSERT INTO maintenance_state (k, v) VALUES ('last_prune_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(now);
  } catch {
    // Best-effort: the in-memory guard still throttles within this process.
  }
}

/** Prune every table to its retention window. Best-effort per table. Returns true if any row was deleted. */
function pruneAll(d: DatabaseSync, now: number): boolean {
  let any = false;
  for (const { table, retentionMs } of PRUNE_TARGETS) {
    const cutoff = now - retentionMs;
    try {
      const r = d.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoff);
      if (Number(r.changes) > 0) any = true;
    } catch {
      // A failed DELETE (e.g. table not yet created) must not stop the rest.
    }
  }
  return any;
}

// In-memory throttle: after a decision, skip with a plain compare until allowed
// again, so the hot write paths pay almost nothing on repeated calls.
let nextAllowedAt = 0;

/**
 * Run retention if it is due. Cheap to call often — after the first decision it
 * returns immediately until the maintenance interval elapses. Never throws.
 * Returns true if a prune actually ran.
 */
export function maybePruneExpired(now: number = Date.now()): boolean {
  if (now < nextAllowedAt) return false;

  const d = getDb();
  if (!d) {
    nextAllowedAt = now + MAINTENANCE_RETRY_MS;
    return false;
  }

  const last = readLastPruneAt(d);
  if (last != null && now - last < MAINTENANCE_INTERVAL_MS) {
    nextAllowedAt = now + MAINTENANCE_INTERVAL_MS - (now - last);
    return false;
  }

  pruneAll(d, now);
  writeLastPruneAt(d, now);
  nextAllowedAt = now + MAINTENANCE_INTERVAL_MS;
  return true;
}
