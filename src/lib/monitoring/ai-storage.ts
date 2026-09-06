import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Persistence + aggregation for AI/API usage, kept separate from collection so
 * the presentation surface never touches how rows are stored. Mirrors the
 * telemetry/website storage design: the DB opens lazily, every call is wrapped
 * so a failure degrades to a no-op, and rows live in the same on-disk SQLite
 * database as everything else — but in their own table.
 *
 * Usage rows carry a `source` label so Claude Code-originated usage (DeepSeek
 * reached through Claude Code's local transcripts) stays distinguishable from
 * DevPulse's own direct DeepSeek calls. Both share provider = "deepseek".
 */

const DB_DIR = path.join(process.cwd(), ".devpulse");
const DB_PATH = path.join(DB_DIR, "telemetry.db");

export const DAY_MS = 86_400_000;

/** Where a usage row came from. `direct` = DevPulse's own DeepSeek wrapper. */
export type UsageSource = "direct" | "claude-code";

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
  source?: UsageSource;
  sessionId?: string | null;
  thinkingTokens?: number | null;
  cacheCreationTokens?: number | null; // diagnostics only — NOT authoritative for DeepSeek
  cacheReadTokens?: number | null; // diagnostics only — NOT authoritative for DeepSeek
  messageId?: string | null; // stable external key for Claude Code usage
};

let db: DatabaseSync | null = null;

/** Add a column to ai_usage only if it does not exist yet (backward-compatible). */
function addColumn(d: DatabaseSync, column: string, ddl: string): void {
  try {
    const found = (d.prepare(`PRAGMA table_info(ai_usage)`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
    if (!found) d.exec(`ALTER TABLE ai_usage ADD COLUMN ${ddl}`);
  } catch {
    // A failed migration must never prevent the table from being usable.
  }
}

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

    // Small backward-compatible migrations for previously-created databases.
    addColumn(d, "source", "source TEXT NOT NULL DEFAULT 'direct'");
    addColumn(d, "sessionId", "sessionId TEXT");
    addColumn(d, "thinkingTokens", "thinkingTokens INTEGER");
    addColumn(d, "cacheCreationTokens", "cacheCreationTokens INTEGER");
    addColumn(d, "cacheReadTokens", "cacheReadTokens INTEGER");
    addColumn(d, "messageId", "messageId TEXT");
    // Persistence-level idempotency for Claude Code ingestion: the assistant
    // message id is a stable external key. SQLite unique indexes permit many
    // NULLs, so pre-existing direct rows are unaffected.
    d.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_usage_message_id ON ai_usage(messageId)`,
    );

    // Ingestion cursor: byte offset already consumed per transcript file, plus
    // a tiny key/value area for scan throttling. Both are internal to ingestion.
    d.exec(`
      CREATE TABLE IF NOT EXISTS claude_ingest_state (
        path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS claude_ingest_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
      );
    `);
    db = d;
    return d;
  } catch {
    return null;
  }
}

/** Persist one instrumented request (defaults to source 'direct'). Never throws. */
export function persistAiUsage(row: AiUsageRow): boolean {
  const d = openDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT OR IGNORE INTO ai_usage
         (ts, provider, source, sessionId, model, inputTokens, outputTokens,
          cachedTokens, thinkingTokens, cacheCreationTokens, cacheReadTokens,
          totalTokens, latencyMs, httpStatus, success, errorType, requestId,
          estimatedCostUsd, messageId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ts,
      row.provider,
      row.source ?? "direct",
      row.sessionId ?? null,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cachedTokens,
      row.thinkingTokens ?? null,
      row.cacheCreationTokens ?? null,
      row.cacheReadTokens ?? null,
      row.totalTokens,
      row.latencyMs,
      row.httpStatus,
      row.success ? 1 : 0,
      row.errorType,
      row.requestId,
      row.estimatedCostUsd,
      row.messageId ?? null,
    );
    return true;
  } catch {
    return false;
  }
}

/** A Claude Code assistant-usage event, reduced to accounting metadata only. */
export type ClaudeCodeUsageEvent = {
  ts: number;
  sessionId: string | null;
  model: string | null;
  messageId: string; // stable external key — the assistant message id
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null; // subset detail; output already includes it
  cacheCreationTokens: number | null; // diagnostic only, not authoritative
  cacheReadTokens: number | null; // diagnostic only, not authoritative
  estimatedCostUsd: number | null; // estimate computed at ingest
};

/**
 * Insert a batch of Claude Code usage events. Idempotent: any messageId already
 * present is ignored (unique index), so re-running ingestion never duplicates.
 * Returns the number of newly inserted rows, or -1 when the DB is unavailable
 * (callers must not advance their cursor in that case).
 */
export function persistClaudeCodeEvents(events: ClaudeCodeUsageEvent[]): number {
  const d = openDb();
  if (!d) return -1;
  if (events.length === 0) return 0;
  let inserted = 0;
  const stmt = d.prepare(
    `INSERT OR IGNORE INTO ai_usage
       (ts, provider, source, sessionId, model, inputTokens, outputTokens,
        cachedTokens, thinkingTokens, cacheCreationTokens, cacheReadTokens,
        totalTokens, latencyMs, httpStatus, success, errorType, requestId,
        estimatedCostUsd, messageId)
     VALUES (?, ?, 'claude-code', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 1,
             NULL, NULL, ?, ?)`,
  );
  try {
    for (const e of events) {
      // totalTokens = input + output. Thinking is a subset already counted in
      // output_tokens, so it is never added on top. Cache fields are unreliable
      // for DeepSeek and are deliberately not folded into totalTokens.
      const total =
        e.inputTokens != null && e.outputTokens != null
          ? e.inputTokens + e.outputTokens
          : null;
      const r = stmt.run(
        e.ts,
        "deepseek",
        e.sessionId,
        e.model,
        e.inputTokens,
        e.outputTokens,
        e.thinkingTokens,
        e.cacheCreationTokens,
        e.cacheReadTokens,
        total,
        e.estimatedCostUsd,
        e.messageId,
      );
      inserted += Number(r.changes);
    }
    return inserted;
  } catch {
    return -1;
  }
}

/* ------------------------------------------------------------------ *
 * Ingestion cursor state (byte offsets per transcript file + throttle)
 * ------------------------------------------------------------------ */

export function readIngestOffset(file: string): number {
  const d = openDb();
  if (!d) return 0;
  try {
    const r = d
      .prepare(`SELECT offset FROM claude_ingest_state WHERE path = ?`)
      .get(file) as { offset: number } | undefined;
    return r ? r.offset : 0;
  } catch {
    return 0;
  }
}

export function writeIngestOffset(file: string, offset: number): void {
  const d = openDb();
  if (!d) return;
  try {
    d.prepare(
      `INSERT INTO claude_ingest_state (path, offset) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET offset = excluded.offset`,
    ).run(file, offset);
  } catch {
    // Non-fatal: the next scan retries from the last committed offset.
  }
}

export function readIngestMeta(key: string): number | null {
  const d = openDb();
  if (!d) return null;
  try {
    const r = d.prepare(`SELECT v FROM claude_ingest_meta WHERE k = ?`).get(key) as
      | { v: number }
      | undefined;
    return r ? r.v : null;
  } catch {
    return null;
  }
}

export function writeIngestMeta(key: string, value: number): void {
  const d = openDb();
  if (!d) return;
  try {
    d.prepare(
      `INSERT INTO claude_ingest_meta (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(key, value);
  } catch {
    // Non-fatal.
  }
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

/** Per-model rollup over the window. `source` distinguishes the origin. */
export type ModelStat = {
  source: UsageSource;
  model: string;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
};

/** One equal-width time bucket for the usage graph. */
export type TimeBucket = { ts: number; requests: number; tokens: number };

/** Aggregate rollup for one usage source. */
export type SourceStat = {
  source: UsageSource;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
};

/** Aggregated usage over a trailing window (ending now). */
export type AiUsageSummary = {
  windowMs: number;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
  bySource: SourceStat[];
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
 * throws. Response size is bounded: one object + one object per model/source +
 * one bucket per step.
 */
export function readAiUsage(rangeMs: number): AiUsageSummary {
  const empty: AiUsageSummary = {
    windowMs: rangeMs,
    requests: 0,
    success: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    avgLatencyMs: null,
    estimatedCostUsd: null,
    bySource: [],
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
        `SELECT ts, source, model, inputTokens, outputTokens, thinkingTokens,
                cachedTokens, totalTokens, latencyMs, success, estimatedCostUsd
           FROM ai_usage
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as {
      ts: number;
      source: string;
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      thinkingTokens: number | null;
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
  let thinkingTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;
  let latSum = 0;
  let latCount = 0;
  let costUsd = 0;
  let hasCost = false;

  type Tally = {
    requests: number;
    failures: number;
    input: number;
    output: number;
    thinking: number;
    cached: number;
    total: number;
    latSum: number;
    latCount: number;
    cost: number;
  };
  const newTally = (): Tally => ({
    requests: 0,
    failures: 0,
    input: 0,
    output: 0,
    thinking: 0,
    cached: 0,
    total: 0,
    latSum: 0,
    latCount: 0,
    cost: 0,
  });

  // Per (source, model) tallies.
  const perModel = new Map<string, Tally>();
  const modelMeta = new Map<string, { source: UsageSource; model: string }>();
  const modelOf = (source: UsageSource, model: string) => {
    const key = `${source}|${model}`;
    let t = perModel.get(key);
    if (!t) {
      t = newTally();
      perModel.set(key, t);
      modelMeta.set(key, { source, model });
    }
    return t;
  };

  // Per-source tallies.
  const perSource = new Map<UsageSource, Tally>();
  const sourceOf = (source: UsageSource) => {
    let t = perSource.get(source);
    if (!t) {
      t = newTally();
      perSource.set(source, t);
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
    const source: UsageSource = r.source === "claude-code" ? "claude-code" : "direct";
    requests++;
    const ok = r.success === 1;
    if (ok) success++;
    else failures++;

    const input = r.inputTokens ?? 0;
    const output = r.outputTokens ?? 0;
    const thinking = r.thinkingTokens ?? 0;
    const cached = r.cachedTokens ?? 0;
    const total = r.totalTokens ?? 0;
    inputTokens += input;
    outputTokens += output;
    thinkingTokens += thinking;
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
    const m = modelOf(source, model);
    const s = sourceOf(source);
    for (const t of [m, s]) {
      t.requests++;
      if (!ok) t.failures++;
      t.input += input;
      t.output += output;
      t.thinking += thinking;
      t.cached += cached;
      t.total += total;
      if (r.latencyMs != null) {
        t.latSum += r.latencyMs;
        t.latCount++;
      }
      if (r.estimatedCostUsd != null) t.cost += r.estimatedCostUsd;
    }

    const bi = Math.min(bucketCount - 1, Math.floor((r.ts - since) / step));
    buckets[bi].requests++;
    buckets[bi].tokens += total;
  }

  const avgLatency = latCount ? latSum / latCount : null;

  const bySource: SourceStat[] = [...perSource.entries()].map(([source, t]) => ({
    source,
    requests: t.requests,
    success: t.requests - t.failures,
    failures: t.failures,
    inputTokens: t.input,
    outputTokens: t.output,
    thinkingTokens: t.thinking,
    cachedTokens: t.cached,
    totalTokens: t.total,
    avgLatencyMs: t.latCount ? t.latSum / t.latCount : null,
    estimatedCostUsd: hasCost ? t.cost : null,
  }));
  bySource.sort((a, b) => (a.source === "direct" ? -1 : 1) - (b.source === "direct" ? -1 : 1));

  const byModel: ModelStat[] = [...perModel.entries()].map(([key, t]) => {
    const meta = modelMeta.get(key)!;
    return {
      source: meta.source,
      model: meta.model,
      requests: t.requests,
      success: t.requests - t.failures,
      failures: t.failures,
      inputTokens: t.input,
      outputTokens: t.output,
      thinkingTokens: t.thinking,
      cachedTokens: t.cached,
      totalTokens: t.total,
      avgLatencyMs: t.latCount ? t.latSum / t.latCount : null,
      estimatedCostUsd: hasCost ? t.cost : null,
    };
  });

  return {
    windowMs: rangeMs,
    requests,
    success,
    failures,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cachedTokens,
    totalTokens,
    avgLatencyMs: avgLatency,
    estimatedCostUsd: hasCost ? costUsd : null,
    bySource,
    byModel,
    overTime: buckets,
  };
}
