import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Persistence + aggregation for AI/API usage, kept separate from collection so
 * the presentation surface never touches how rows are stored. Mirrors the
 * telemetry/website storage design: the DB opens lazily, every call is wrapped
 * so a failure degrades to a no-op, and rows live in the same on-disk SQLite
 * database as everything else — but in their own table.
 */

const DB_DIR = path.join(process.cwd(), ".devpulse");
const DB_PATH = path.join(DB_DIR, "telemetry.db");

export const DAY_MS = 86_400_000;

/** A single instrumented request, as persisted. Metadata only — no keys, no bodies. */
export type AiUsageRow = {
  ts: number; // epoch ms
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  httpStatus: number | null;
  success: boolean;
  errorType: string | null; // missing_key | http | network | timeout | parse
  requestId: string | null;
  estimatedCostUsd: number | null; // set by the collector via pricing; null when unknown
};

let db: DatabaseSync | null = null;

/** Open (once) and prepare the database. Returns null on any failure. */
function openDb(): DatabaseSync | null {
  if (db) return db;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,            -- epoch ms
        provider TEXT NOT NULL,
        model TEXT,
        inputTokens INTEGER,
        outputTokens INTEGER,
        cachedTokens INTEGER,
        totalTokens INTEGER,
        latencyMs REAL,                 -- request duration, null on failure
        httpStatus INTEGER,             -- null when the request never returned
        success INTEGER NOT NULL,       -- 1 success, 0 failure
        errorType TEXT,
        requestId TEXT,
        estimatedCostUsd REAL
      );
    `);
    db = d;
    return d;
  } catch {
    return null;
  }
}

/** Persist one instrumented request. Never throws. */
export function persistAiUsage(row: AiUsageRow): boolean {
  const d = openDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO ai_usage
         (ts, provider, model, inputTokens, outputTokens, cachedTokens,
          totalTokens, latencyMs, httpStatus, success, errorType, requestId,
          estimatedCostUsd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ts,
      row.provider,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cachedTokens,
      row.totalTokens,
      row.latencyMs,
      row.httpStatus,
      row.success ? 1 : 0,
      row.errorType,
      row.requestId,
      row.estimatedCostUsd,
    );
    return true;
  } catch {
    return false;
  }
}

/** Per-model rollup over the window. */
export type ModelStat = {
  model: string;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
};

/** One equal-width time bucket for the usage graph. */
export type TimeBucket = { ts: number; requests: number; tokens: number };

/** Aggregated usage over a trailing window (ending now). */
export type AiUsageSummary = {
  windowMs: number;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
  byModel: ModelStat[];
  overTime: TimeBucket[];
};

/** Pick an equal-width bucket step so 24H/7D/30D each graph ~1–30 bars. */
function bucketStepMs(rangeMs: number): number {
  if (rangeMs <= DAY_MS) return 60 * 60 * 1000; // 24H -> hourly (24 bars)
  if (rangeMs <= 7 * DAY_MS) return 6 * 60 * 60 * 1000; // 7D -> 6-hourly (28 bars)
  return DAY_MS; // 30D -> daily (30 bars)
}

/**
 * Aggregate rows over the trailing window ending now. Counts default to 0, avg
 * latency reduces only over rows that recorded one, cost sums only rows that
 * carry an estimate. Returns an empty summary on no data or DB failure — never
 * throws. Response size is bounded: one object + one object per model + one
 * bucket per step.
 */
export function readAiUsage(rangeMs: number): AiUsageSummary {
  const empty: AiUsageSummary = {
    windowMs: rangeMs,
    requests: 0,
    success: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    avgLatencyMs: null,
    estimatedCostUsd: null,
    byModel: [],
    overTime: [],
  };

  const d = openDb();
  if (!d) return empty;
  const since = Date.now() - rangeMs;
  let rows;
  try {
    rows = d
      .prepare(
        `SELECT ts, model, inputTokens, outputTokens, cachedTokens, totalTokens,
                latencyMs, success, estimatedCostUsd
           FROM ai_usage
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as {
      ts: number;
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedTokens: number | null;
      totalTokens: number | null;
      latencyMs: number | null;
      success: number;
      estimatedCostUsd: number | null;
    }[];
  } catch {
    return empty;
  }
  if (rows.length === 0) return empty;

  // Whole-window tallies.
  let requests = 0;
  let success = 0;
  let failures = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;
  let latSum = 0;
  let latCount = 0;
  let costUsd = 0;
  let hasCost = false;

  // Per-model tallies, keyed by model string.
  type Tally = {
    requests: number;
    failures: number;
    input: number;
    output: number;
    cached: number;
    total: number;
    latSum: number;
    latCount: number;
    cost: number;
  };
  const per = new Map<string, Tally>();
  const tallyOf = (model: string): Tally => {
    let t = per.get(model);
    if (!t) {
      t = {
        requests: 0,
        failures: 0,
        input: 0,
        output: 0,
        cached: 0,
        total: 0,
        latSum: 0,
        latCount: 0,
        cost: 0,
      };
      per.set(model, t);
    }
    return t;
  };

  const step = bucketStepMs(rangeMs);
  const bucketCount = Math.max(1, Math.ceil(rangeMs / step));
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    ts: since + i * step,
    requests: 0,
    tokens: 0,
  }));

  for (const r of rows) {
    requests++;
    const ok = r.success === 1;
    if (ok) success++;
    else failures++;

    const input = r.inputTokens ?? 0;
    const output = r.outputTokens ?? 0;
    const cached = r.cachedTokens ?? 0;
    const total = r.totalTokens ?? 0;
    inputTokens += input;
    outputTokens += output;
    cachedTokens += cached;
    totalTokens += total;

    if (r.latencyMs != null) {
      latSum += r.latencyMs;
      latCount++;
    }
    if (r.estimatedCostUsd != null) {
      costUsd += r.estimatedCostUsd;
      hasCost = true;
    }

    const model = r.model || "unknown";
    const t = tallyOf(model);
    t.requests++;
    if (!ok) t.failures++;
    t.input += input;
    t.output += output;
    t.cached += cached;
    t.total += total;
    if (r.latencyMs != null) {
      t.latSum += r.latencyMs;
      t.latCount++;
    }
    if (r.estimatedCostUsd != null) t.cost += r.estimatedCostUsd;

    const bi = Math.min(bucketCount - 1, Math.floor((r.ts - since) / step));
    buckets[bi].requests++;
    buckets[bi].tokens += total;
  }

  const avgLatency = latCount ? latSum / latCount : null;

  const byModel: ModelStat[] = [...per.entries()].map(([model, t]) => ({
    model,
    requests: t.requests,
    success: t.requests - t.failures,
    failures: t.failures,
    inputTokens: t.input,
    outputTokens: t.output,
    cachedTokens: t.cached,
    totalTokens: t.total,
    avgLatencyMs: t.latCount ? t.latSum / t.latCount : null,
    estimatedCostUsd: hasCost ? t.cost : null,
  }));

  return {
    windowMs: rangeMs,
    requests,
    success,
    failures,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
    avgLatencyMs: avgLatency,
    estimatedCostUsd: hasCost ? costUsd : null,
    byModel,
    overTime: buckets,
  };
}
