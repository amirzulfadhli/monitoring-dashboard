import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

const DB_DIR = path.join(process.cwd(), ".devpulse");
const DB_PATH = path.join(DB_DIR, "telemetry.db");

type Row = Record<string, string | number | bigint | null>;

let db: DatabaseSync | null = null;
let lastPersistedAt = 0;

/** Open (once) and prepare the database. Returns null on any failure. */
function openDb(): DatabaseSync | null {
  if (db) return db;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec(`
      CREATE TABLE IF NOT EXISTS history (
        ts INTEGER PRIMARY KEY,          -- epoch ms
        cpuPct REAL,                     -- CPU busy %
        usedMem INTEGER,                 -- bytes in use
        availMem INTEGER,                -- bytes free
        rxRate REAL,                     -- bytes/sec
        txRate REAL,                     -- bytes/sec
        rxTotal INTEGER,                 -- cumulative received bytes
        txTotal INTEGER                  -- cumulative transmitted bytes
      );
    `);
    db = d;
    return d;
  } catch {
    return null;
  }
}

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
  const d = openDb();
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
  const d = openDb();
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
