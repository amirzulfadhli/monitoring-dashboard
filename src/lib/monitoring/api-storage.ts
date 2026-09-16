import { getDb } from "@/lib/db";
import { maybePruneExpired } from "../maintenance";
import type { ApiState } from "./apis";

/**
 * Persistence for API check history. Same design as the website storage it
 * mirrors: the shared connection opens lazily, every call is wrapped so a
 * failure degrades to a no-op, and the rows live in their own `api_checks`
 * table in the one DevPulse database.
 *
 * Only observed facts are stored — status, latency and a sanitized error.
 * Response bodies are never written here (the monitor never reads them).
 */

/** A row to persist for one check of one endpoint. */
export type ApiCheckRow = {
  ts: number; // epoch ms
  targetId: string;
  state: ApiState;
  httpStatus: number | null;
  latencyMs: number | null;
  errorType: string | null;
  error: string | null;
};

/** 24-hour summary window. */
export const DAY_MS = 86_400_000;

/** Persist one check. Never throws. */
export function persistApiCheck(row: ApiCheckRow): boolean {
  const d = getDb();
  if (!d) return false;
  // Opportunistic retention (guarded to ~once/day) rides the write path.
  maybePruneExpired();
  try {
    d.prepare(
      `INSERT OR IGNORE INTO api_checks
         (ts, targetId, state, httpStatus, latencyMs, errorType, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ts,
      row.targetId,
      row.state,
      row.httpStatus,
      row.latencyMs,
      row.errorType,
      row.error,
    );
    return true;
  } catch {
    return false;
  }
}

/** A stored API check row, used to derive state-transition events. */
export type StoredApiCheck = {
  ts: number;
  targetId: string;
  state: ApiState;
  latencyMs: number | null;
  httpStatus: number | null;
};

/**
 * Raw persisted API checks within the trailing window (ts >= since), oldest
 * first. Backs the History timeline's transition derivation. Returns [] on no
 * data or DB failure — never throws.
 */
export function readApiChecks(since: number): StoredApiCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT ts, targetId, state, latencyMs, httpStatus
           FROM api_checks
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as StoredApiCheck[];
  } catch {
    return [];
  }
}

/** The most recently persisted check for one endpoint. */
export type LatestApiCheck = {
  targetId: string;
  ts: number;
  state: ApiState;
  latencyMs: number | null;
};

/**
 * Newest persisted check per endpoint. Alert evaluation reads this rather than
 * firing its own request, so raising an API alert never costs a network call.
 * Returns [] on no data or DB failure.
 */
export function readLatestApiChecks(): LatestApiCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT a.targetId AS targetId, a.ts AS ts, a.state AS state,
                a.latencyMs AS latencyMs
           FROM api_checks a
           JOIN (SELECT targetId, MAX(ts) AS m FROM api_checks GROUP BY targetId) x
             ON x.targetId = a.targetId AND x.m = a.ts`,
      )
      .all() as LatestApiCheck[];
  } catch {
    return [];
  }
}

/** Per-endpoint 24h availability summary computed only from stored rows. */
export type ApiHistorySummary = {
  /** Number of stored checks in the window; low values imply sparse history. */
  samples: number;
  /** Percentage of checks that were up (healthy or degraded). Null when none. */
  uptimePct: number | null;
  /** Average latency over checks that recorded one. Null when none. */
  avgLatencyMs: number | null;
  /** Epoch ms of the most recent down check, or null if none were down. */
  latestFailureAt: number | null;
};

/** Aggregate the trailing window (ending now) per endpoint. Never throws. */
export function readApiSummaries(
  rangeMs: number,
): Record<string, ApiHistorySummary> {
  const d = getDb();
  if (!d) return {};
  const since = Date.now() - rangeMs;
  try {
    const rows = d
      .prepare(
        `SELECT ts, targetId, state, latencyMs
           FROM api_checks
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as {
      ts: number;
      targetId: string;
      state: string;
      latencyMs: number | null;
    }[];

    const per: Record<string, number[]> = {};
    const lat: Record<string, number[]> = {};
    const lastDown: Record<string, number> = {};
    for (const r of rows) {
      const id = r.targetId;
      (per[id] ||= []).push(r.state === "down" ? 0 : 1);
      if (r.latencyMs != null) (lat[id] ||= []).push(r.latencyMs);
      if (r.state === "down") lastDown[id] = r.ts;
    }

    const out: Record<string, ApiHistorySummary> = {};
    for (const id of Object.keys(per)) {
      const arr = per[id];
      const total = arr.length;
      const upCount = arr.reduce((s, v) => s + v, 0);
      const latArr = lat[id] ?? [];
      out[id] = {
        samples: total,
        uptimePct: total ? Math.round((upCount / total) * 1000) / 10 : null,
        avgLatencyMs: latArr.length
          ? latArr.reduce((s, v) => s + v, 0) / latArr.length
          : null,
        latestFailureAt: lastDown[id] ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}
