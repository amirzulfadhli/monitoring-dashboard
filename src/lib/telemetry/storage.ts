import { getDb } from "@/lib/db";

/**
 * Local persistence for telemetry history. Isolated behind this module so the
 * backing store can be swapped later without touching presentation code.
 *
 * Backend: Node's built-in `node:sqlite` (SQLite). Zero extra dependencies,
 * real on-disk database that survives process restarts. The DB opens lazily on
 * first write and every call is wrapped so any failure degrades to a no-op —
 * a storage problem must never break live telemetry.
 */

// Persist no more often than this. The live endpoint is polled every ~3s, so a
// simple guarded write based on the last stored timestamp keeps one row per
// ~30s instead of one per request.
export const SNAPSHOT_INTERVAL_MS = 30_000;

type Row = Record<string, string | number | bigint | null>;

let lastPersistedAt = 0;

/** The subset of a snapshot worth keeping for historical monitoring. */
export type PersistableSnapshot = {
  ts: number;
  cpuPct: number | null;
  usedMem: number | null;
  availMem: number | null;
  rxRate: number | null;
  txRate: number | null;
  rxTotal: number | null;
  txTotal: number | null;
};

/**
 * Persist one snapshot unless one was written in the last interval. Returns
 * false when skipped, when the DB is unavailable, or on write failure — never
 * throws.
 */
export function persistSnapshot(s: PersistableSnapshot): boolean {
  const d = getDb();
  if (!d) return false;
  if (s.ts - lastPersistedAt < SNAPSHOT_INTERVAL_MS) return false;
  try {
    d.prepare(
      `INSERT OR IGNORE INTO history
         (ts, cpuPct, usedMem, availMem, rxRate, txRate, rxTotal, txTotal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.ts,
      s.cpuPct,
      s.usedMem,
      s.availMem,
      s.rxRate,
      s.txRate,
      s.rxTotal,
      s.txTotal,
    );
    lastPersistedAt = s.ts;
    return true;
  } catch {
    return false;
  }
}

/** A single rate point for the throughput graph. */
export type HistoryPoint = { ts: number; rxRate: number; txRate: number };

/**
 * Read receive/transmit rate history over the trailing window ending now,
 * oldest first, downsampled to at most `maxPoints`. Rows without a rate
 * reading are excluded. Returns [] on empty history or DB failure.
 */
export function readRange(rangeMs: number, maxPoints: number): HistoryPoint[] {
  const d = getDb();
  if (!d) return [];
  const since = Date.now() - rangeMs;
  try {
    const rows = d
      .prepare(
        `SELECT ts, rxRate, txRate
           FROM history
          WHERE ts >= ? AND rxRate IS NOT NULL AND txRate IS NOT NULL
          ORDER BY ts ASC`,
      )
      .all(since) as { ts: number; rxRate: number; txRate: number }[];
    return downsample(rows, maxPoints);
  } catch {
    return [];
  }
}

/** Aggregate summary of a trailing window, for the Overview "recent" panel. */
export type HistorySummary = {
  /** Number of persisted snapshots in the window; small values imply sparse history. */
  points: number;
  cpu: { avg: number | null; peak: number | null }; // CPU busy %
  usedMem: { avg: number | null; peak: number | null }; // bytes in use
  rxRate: number | null; // peak bytes/sec
  txRate: number | null; // peak bytes/sec
};

const EMPTY_SUMMARY: HistorySummary = {
  points: 0,
  cpu: { avg: null, peak: null },
  usedMem: { avg: null, peak: null },
  rxRate: null,
  txRate: null,
};

/**
 * Compute a 24h-style summary over the trailing window ending now: average and
 * peak CPU/memory, plus peak network rates. Each metric is reduced only over
 * rows that recorded it. Returns EMPTY_SUMMARY on no data or DB failure —
 * never throws.
 */
export function readSummary(rangeMs: number): HistorySummary {
  const d = getDb();
  if (!d) return EMPTY_SUMMARY;
  const since = Date.now() - rangeMs;
  try {
    const rows = d
      .prepare(
        `SELECT cpuPct, usedMem, rxRate, txRate
           FROM history
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as {
      cpuPct: number | null;
      usedMem: number | null;
      rxRate: number | null;
      txRate: number | null;
    }[];
    if (rows.length === 0) return EMPTY_SUMMARY;

    const cpu: number[] = [];
    const mem: number[] = [];
    let peakRx = 0;
    let peakTx = 0;
    for (const r of rows) {
      if (r.cpuPct != null) cpu.push(r.cpuPct);
      if (r.usedMem != null) mem.push(r.usedMem);
      if (r.rxRate != null) peakRx = Math.max(peakRx, r.rxRate);
      if (r.txRate != null) peakTx = Math.max(peakTx, r.txRate);
    }
    const avg = (a: number[]) =>
      a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const peak = (a: number[]) => (a.length ? Math.max(...a) : null);

    return {
      points: rows.length,
      cpu: { avg: avg(cpu), peak: peak(cpu) },
      usedMem: { avg: avg(mem), peak: peak(mem) },
      rxRate: peakRx || null,
      txRate: peakTx || null,
    };
  } catch {
    return EMPTY_SUMMARY;
  }
}

/** One persisted system sample for alert evaluation. */
export type SystemSample = {
  ts: number;
  cpuPct: number | null;
  usedMem: number | null; // bytes in use
  availMem: number | null; // bytes free (=> total is derivable)
};

/**
 * Read persisted system samples within the trailing window ending now, oldest
 * first. Backs the CPU/memory alert rules with real persisted history — no new
 * collector, no OS call at evaluation time. Returns [] on no data / DB failure.
 */
export function readSystemSamples(rangeMs: number): SystemSample[] {
  const d = getDb();
  if (!d) return [];
  const since = Date.now() - rangeMs;
  try {
    return d
      .prepare(
        `SELECT ts, cpuPct, usedMem, availMem
           FROM history
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as SystemSample[];
  } catch {
    return [];
  }
}

/** A persisted system/network sample used to build timeline summaries. */
export type TelemetryRow = {
  ts: number;
  cpuPct: number | null;
  usedMem: number | null;
  rxRate: number | null;
  txRate: number | null;
};

/**
 * Raw persisted telemetry rows within the trailing window (ts >= since),
 * oldest first. Backs the History timeline's hourly CPU/memory + network
 * summaries. Returns [] on no data or DB failure — never throws.
 */
export function readTelemetryRows(since: number): TelemetryRow[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT ts, cpuPct, usedMem, rxRate, txRate
           FROM history
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as TelemetryRow[];
  } catch {
    return [];
  }
}

/** Collapse runs of points into averaged buckets when there are too many. */
function downsample(
  rows: { ts: number; rxRate: number; txRate: number }[],
  maxPoints: number,
): HistoryPoint[] {
  const n = rows.length;
  if (n <= maxPoints) return rows;
  const size = Math.ceil(n / maxPoints);
  const out: HistoryPoint[] = [];
  for (let i = 0; i < n; i += size) {
    const end = Math.min(i + size, n);
    let rx = 0;
    let tx = 0;
    for (let j = i; j < end; j++) {
      rx += rows[j].rxRate;
      tx += rows[j].txRate;
    }
    out.push({
      ts: rows[i].ts,
      rxRate: rx / (end - i),
      txRate: tx / (end - i),
    });
  }
  return out;
}
