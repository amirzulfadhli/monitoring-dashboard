/**
 * Persistence for device reachability checks.
 *
 * Same design as the other monitoring storage modules: the shared connection
 * opens lazily, every call is wrapped so a failure degrades to a no-op, and the
 * rows live in their own `device_checks` table in the one DevPulse database.
 *
 * Only observed reachability facts are stored — whether the host answered, the
 * latency and a short reason of our own. Ping's output is never written here,
 * and no CPU / memory / network measurement is either: the local machine's
 * telemetry stays in `history` and is never copied into device tables.
 */

import { getDb } from "@/lib/db";
import { maybePruneExpired } from "@/lib/maintenance";

import type { DeviceCheckResult } from "./model";

/** 24-hour summary window, matching the other monitors. */
export const DAY_MS = 86_400_000;

/** Persist one check. Never throws. */
export function persistDeviceCheck(r: DeviceCheckResult): boolean {
  const d = getDb();
  if (!d) return false;
  // Opportunistic retention (guarded to ~once/day) rides the write path.
  maybePruneExpired();
  try {
    d.prepare(
      `INSERT OR IGNORE INTO device_checks
         (ts, deviceId, reachable, latencyMs, errorType, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      r.checkedAt,
      r.device.id,
      r.reachable ? 1 : 0,
      r.latencyMs,
      r.errorType,
      r.error,
    );
    return true;
  } catch {
    return false;
  }
}

/** A stored check row, used to derive reachability transitions. */
export type StoredDeviceCheck = {
  ts: number;
  deviceId: string;
  reachable: boolean;
  latencyMs: number | null;
};

/**
 * Raw persisted checks within the trailing window (ts >= since), oldest first.
 * Backs the History timeline's transition derivation. Returns [] on no data or
 * DB failure — never throws.
 */
export function readDeviceChecks(since: number): StoredDeviceCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = d
      .prepare(
        `SELECT ts, deviceId, reachable, latencyMs
           FROM device_checks
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as { ts: number; deviceId: string; reachable: number; latencyMs: number | null }[];
    return rows.map((r) => ({
      ts: r.ts,
      deviceId: r.deviceId,
      reachable: r.reachable === 1,
      latencyMs: r.latencyMs,
    }));
  } catch {
    return [];
  }
}

/**
 * One device's most recent observed state, plus how many checks in a row at the
 * newest end were unreachable.
 *
 * The streak is what makes the unreachable alert deterministic and spam-free:
 * alert evaluation reads this instead of pinging anything, so raising a device
 * alert costs no network traffic.
 */
export type LatestDeviceCheck = {
  deviceId: string;
  ts: number;
  reachable: boolean;
  latencyMs: number | null;
  /** Leading run of unreachable checks, newest first. 0 when reachable. */
  consecutiveUnreachable: number;
};

/**
 * Newest check per device within the window, with its unreachable streak.
 *
 * Rows are folded in one pass, newest first: the first row seen for a device is
 * its latest, and the streak is the run of unreachable rows before the first
 * reachable one. This mirrors what `readLatestDeviceChecks` consumers need
 * without a correlated subquery per device.
 */
export function readLatestDeviceChecks(since: number): LatestDeviceCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = d
      .prepare(
        `SELECT ts, deviceId, reachable, latencyMs
           FROM device_checks
          WHERE ts >= ?
          ORDER BY ts DESC`,
      )
      .all(since) as { ts: number; deviceId: string; reachable: number; latencyMs: number | null }[];

    const out = new Map<string, LatestDeviceCheck>();
    // Devices whose leading run has already ended (a reachable check was seen).
    // Without this, failures from *before* a recovery would keep extending the
    // streak, over-counting it and letting a single new failure cross a
    // threshold that is meant to require several in a row.
    const closed = new Set<string>();
    for (const r of rows) {
      const reachable = r.reachable === 1;
      const existing = out.get(r.deviceId);
      if (!existing) {
        out.set(r.deviceId, {
          deviceId: r.deviceId,
          ts: r.ts,
          reachable,
          latencyMs: r.latencyMs,
          consecutiveUnreachable: reachable ? 0 : 1,
        });
        if (reachable) closed.add(r.deviceId);
        continue;
      }
      if (closed.has(r.deviceId)) continue;
      if (reachable) {
        closed.add(r.deviceId);
        continue;
      }
      existing.consecutiveUnreachable++;
    }
    return [...out.values()];
  } catch {
    return [];
  }
}

/** Per-device availability summary computed only from stored rows. */
export type DeviceHistorySummary = {
  /** Number of stored checks in the window; low values imply sparse history. */
  samples: number;
  /** Percentage of checks where the device answered. Null when none. */
  uptimePct: number | null;
  /** Average latency over checks that recorded one. Null when none. */
  avgLatencyMs: number | null;
  /** Epoch ms of the most recent unreachable check, or null if none failed. */
  latestFailureAt: number | null;
};

/** Aggregate the trailing window (ending now) per device. Never throws. */
export function readDeviceSummaries(rangeMs: number): Record<string, DeviceHistorySummary> {
  const d = getDb();
  if (!d) return {};
  const since = Date.now() - rangeMs;
  try {
    const rows = d
      .prepare(
        `SELECT ts, deviceId, reachable, latencyMs
           FROM device_checks
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as { ts: number; deviceId: string; reachable: number; latencyMs: number | null }[];

    const up: Record<string, number> = {};
    const total: Record<string, number> = {};
    const lat: Record<string, number[]> = {};
    const lastDown: Record<string, number> = {};
    for (const r of rows) {
      const id = r.deviceId;
      total[id] = (total[id] ?? 0) + 1;
      if (r.reachable === 1) up[id] = (up[id] ?? 0) + 1;
      else lastDown[id] = r.ts;
      if (r.latencyMs != null) (lat[id] ||= []).push(r.latencyMs);
    }

    const out: Record<string, DeviceHistorySummary> = {};
    for (const id of Object.keys(total)) {
      const n = total[id];
      const latArr = lat[id] ?? [];
      out[id] = {
        samples: n,
        uptimePct: n ? Math.round(((up[id] ?? 0) / n) * 1000) / 10 : null,
        avgLatencyMs: latArr.length ? latArr.reduce((s, v) => s + v, 0) / latArr.length : null,
        latestFailureAt: lastDown[id] ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}
