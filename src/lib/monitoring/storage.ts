import { getDb } from "@/lib/db";
import { maybePruneExpired } from "../maintenance";

/**
 * Persistence for website check history. Mirrors the telemetry storage design:
 * the DB opens lazily, every call is wrapped so a failure degrades to a no-op,
 * and it lives in the same on-disk SQLite database as telemetry — but in its
 * own table so the two histories never mix.
 */

/** A row to persist for one check of one target. */
export type WebsiteCheckRow = {
  ts: number; // epoch ms
  targetId: string;
  state: "healthy" | "degraded" | "down";
  httpStatus: number | null;
  latencyMs: number | null;
  errorType: string | null;
  error: string | null;
};

/** 24-hour summary window. */
export const DAY_MS = 86_400_000;

/** Persist one check. Never throws. */
export function persistWebsiteCheck(row: WebsiteCheckRow): boolean {
  const d = getDb();
  if (!d) return false;
  // Opportunistic retention (guarded to ~once/day) rides the write path.
  maybePruneExpired();
  try {
    d.prepare(
      `INSERT OR IGNORE INTO website_checks
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

/** A stored website check row, used to derive state-transition events. */
export type StoredWebsiteCheck = {
  ts: number;
  targetId: string;
  state: "healthy" | "degraded" | "down";
  latencyMs: number | null;
  httpStatus: number | null;
};

/**
 * Raw persisted website checks within the trailing window (ts >= since),
 * oldest first. Backs the History timeline's state-transition derivation.
 * Returns [] on no data or DB failure — never throws.
 */
export function readWebsiteChecks(since: number): StoredWebsiteCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT ts, targetId, state, latencyMs, httpStatus
           FROM website_checks
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as StoredWebsiteCheck[];
  } catch {
    return [];
  }
}

/** Per-target 24h availability summary computed only from stored rows. */
export type SiteHistorySummary = {
  /** Number of stored checks in the window; low values imply sparse history. */
  samples: number;
  /** Percentage of checks that were up (healthy or degraded). Null when no samples. */
  uptimePct: number | null;
  /** Average latency over checks that recorded one. Null when none. */
  avgLatencyMs: number | null;
  /** Epoch ms of the most recent down check, or null if none were down. */
  latestFailureAt: number | null;
};

/** The most recently persisted check for one target. */
export type LatestWebsiteCheck = {
  targetId: string;
  ts: number;
  state: "healthy" | "degraded" | "down";
  latencyMs: number | null;
};

/**
 * Read the newest persisted check per target. Alert evaluation uses this rather
 * than firing a fresh fetch: it reuses whatever the website monitor already
 * recorded, so no duplicate network request is made just to raise an alert.
 * Returns [] on no data or DB failure.
 */
export function readLatestWebsiteChecks(): LatestWebsiteCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT w.targetId AS targetId, w.ts AS ts, w.state AS state,
                w.latencyMs AS latencyMs
           FROM website_checks w
           JOIN (SELECT targetId, MAX(ts) AS m FROM website_checks GROUP BY targetId) x
             ON x.targetId = w.targetId AND x.m = w.ts`,
      )
      .all() as LatestWebsiteCheck[];
  } catch {
    return [];
  }
}

/**
 * Aggregate the trailing window (ending now) per target. Returns an empty
 * object when there is no data or the DB is unavailable — never throws.
 */
export function readWebsiteSummaries(
  rangeMs: number,
): Record<string, SiteHistorySummary> {
  const d = getDb();
  if (!d) return {};
  const since = Date.now() - rangeMs;
  try {
    const rows = d
      .prepare(
        `SELECT ts, targetId, state, latencyMs
           FROM website_checks
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
    const down: Record<string, number> = {};
    const lastDown: Record<string, number> = {};
    for (const r of rows) {
      const id = r.targetId;
      (per[id] ||= []).push(r.state === "down" ? 0 : 1);
      if (r.latencyMs != null) (lat[id] ||= []).push(r.latencyMs);
      if (r.state === "down") {
        down[id] = (down[id] || 0) + 1;
        lastDown[id] = r.ts;
      }
    }

    const out: Record<string, SiteHistorySummary> = {};
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
