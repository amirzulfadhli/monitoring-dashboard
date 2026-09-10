/**
 * Centralized schema for the single DevPulse SQLite database. Previously every
 * storage module created its own tables on first open; the DDL now lives here so
 * the schema has one owner and one ordered migration path.
 *
 * Versioning uses `PRAGMA user_version`:
 *   0 = a database created before versioning existed (the schema is already
 *       present — migration 1 adopts it via idempotent `IF NOT EXISTS` DDL and
 *       only records the version), or a brand-new/empty file.
 *   1 = the current schema.
 *
 * Every migration must be additive and idempotent: DevPulse never drops tables,
 * deletes rows, or recreates the database. A database whose version is *newer*
 * than this build is left untouched rather than being downgraded.
 */

import type { DatabaseSync } from "node:sqlite";

/** Current schema version. Bump when adding a migration below. */
export const SCHEMA_VERSION = 1;

/** Add a column to a table only if it does not exist yet (idempotent, additive). */
function addColumn(
  d: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  try {
    const found = (
      d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
    if (!found) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {
    // A failed migration must never prevent the table from being usable.
  }
}

/**
 * Version 1 — the full schema, created idempotently. On an existing (version 0)
 * DevPulse database every statement is a no-op apart from the version stamp and
 * the additive `ai_usage` columns, so no existing table, index or row is lost.
 */
function migration1(d: DatabaseSync): void {
  // --- telemetry ---------------------------------------------------------
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

  // --- website checks ----------------------------------------------------
  d.exec(`
    CREATE TABLE IF NOT EXISTS website_checks (
      ts INTEGER,                    -- epoch ms
      targetId TEXT,
      state TEXT,                    -- healthy | degraded | down
      httpStatus INTEGER,            -- null when unreachable
      latencyMs REAL,                -- response latency, null on failure
      errorType TEXT,                -- timeout | dns | network | unexpected_status | ...
      error TEXT,
      PRIMARY KEY (ts, targetId)
    );
    -- ts is the leading PK column, so range reads + retention already scan by
    -- timestamp. This secondary index serves latest-per-target reads and any
    -- per-target time queries (alert evaluation / history) without a full scan.
    CREATE INDEX IF NOT EXISTS idx_website_checks_target_ts
      ON website_checks(targetId, ts);
  `);

  // --- AI / API usage ----------------------------------------------------
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
  addColumn(d, "ai_usage", "source", "source TEXT NOT NULL DEFAULT 'direct'");
  addColumn(d, "ai_usage", "sessionId", "sessionId TEXT");
  addColumn(d, "ai_usage", "thinkingTokens", "thinkingTokens INTEGER");
  addColumn(d, "ai_usage", "cacheCreationTokens", "cacheCreationTokens INTEGER");
  addColumn(d, "ai_usage", "cacheReadTokens", "cacheReadTokens INTEGER");
  addColumn(d, "ai_usage", "messageId", "messageId TEXT");

  d.exec(`
    -- Persistence-level idempotency for Claude Code ingestion: the assistant
    -- message id is a stable external key. SQLite unique indexes permit many
    -- NULLs, so pre-existing direct rows are unaffected.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_usage_message_id ON ai_usage(messageId);
    -- Trailing-window reads (ts >= ?) and retention both scan by timestamp.
    -- A standalone source/model index is not justified: aggregation filters on
    -- source/model in JS after a full-window ts scan, never in SQL.
    CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage(ts);

    -- Ingestion cursor: byte offset already consumed per transcript file, plus
    -- a tiny key/value area for scan throttling. Both are internal to ingestion.
    CREATE TABLE IF NOT EXISTS claude_ingest_state (
      path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS claude_ingest_meta (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL
    );
  `);

  // --- GitHub repository health snapshots --------------------------------
  d.exec(`
    CREATE TABLE IF NOT EXISTS github_snapshots (
      ts INTEGER NOT NULL,          -- epoch ms snapshot taken
      repoKey TEXT NOT NULL,        -- owner/repo
      repoName TEXT NOT NULL,       -- repository slug
      displayName TEXT NOT NULL,    -- human label for UI / alerts
      state TEXT NOT NULL,          -- healthy | attention | running
      commitSha TEXT,               -- latest commit short sha
      commitDateMs INTEGER,         -- latest commit timestamp
      openIssues INTEGER,           -- open issue count
      openPrs INTEGER,              -- open PR count
      workflowName TEXT,            -- latest workflow run name, if any
      workflowStatus TEXT,          -- latest workflow status
      workflowConclusion TEXT,      -- latest workflow conclusion
      workflowBranch TEXT,          -- latest workflow head branch
      lastPushMs INTEGER,           -- repository last_push time
      PRIMARY KEY (repoKey, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_github_snapshots_repo_ts
      ON github_snapshots(repoKey, ts);
    -- Cross-repo trailing-window reads (ts >= ?) and retention prune by ts,
    -- which the (repoKey, ts) keys cannot serve without a full scan.
    CREATE INDEX IF NOT EXISTS idx_github_snapshots_ts
      ON github_snapshots(ts);
  `);

  // --- alerts ------------------------------------------------------------
  d.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      fingerprint TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      ruleId TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,             -- active | resolved
      firstSeenAt INTEGER NOT NULL,     -- epoch ms
      lastSeenAt INTEGER NOT NULL,      -- epoch ms
      resolvedAt INTEGER,               -- epoch ms; null while active
      metadata TEXT                     -- small JSON extras
    );
  `);

  // --- alert explanations -------------------------------------------------
  d.exec(`
    CREATE TABLE IF NOT EXISTS alert_explanations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      versionKey TEXT NOT NULL,
      createdAt INTEGER NOT NULL,        -- epoch ms
      summary TEXT NOT NULL,
      likelyCause TEXT,
      confidence TEXT NOT NULL,
      evidence TEXT NOT NULL,            -- JSON array of {eventId,relevance}
      checks TEXT NOT NULL,              -- JSON array of string
      evidenceEventIds TEXT NOT NULL,    -- JSON array of string (grounding refs)
      model TEXT,
      usage TEXT                          -- JSON {inputTokens,outputTokens,estimatedCostUsd}
    );
    CREATE INDEX IF NOT EXISTS idx_explain_fp ON alert_explanations(fingerprint);
  `);

  // --- intelligence analyses ---------------------------------------------
  d.exec(`
    CREATE TABLE IF NOT EXISTS intelligence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,               -- analyzedAt epoch ms
      windowHours INTEGER NOT NULL,      -- analysis window (24 for V1)
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings TEXT NOT NULL,            -- JSON array of Finding
      recommendations TEXT NOT NULL,     -- JSON array of string
      evidenceEventIds TEXT NOT NULL,    -- JSON array of string (grounding refs)
      evidenceCount INTEGER NOT NULL,    -- events supplied to the model
      model TEXT,
      usage TEXT                          -- JSON {inputTokens,outputTokens,estimatedCostUsd}
    );
  `);

  // --- configuration / sources -------------------------------------------
  d.exec(`
    CREATE TABLE IF NOT EXISTS monitored_websites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      expectedStatus INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitored_repositories (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      displayName TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_monitored_repositories_owner_repo
      ON monitored_repositories (owner, repo);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // --- retention bookkeeping ---------------------------------------------
  d.exec(
    `CREATE TABLE IF NOT EXISTS maintenance_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  );
}

/** Ordered migrations. Each entry moves the database from version-1 to its own. */
const MIGRATIONS: { version: number; up: (d: DatabaseSync) => void }[] = [
  { version: 1, up: migration1 },
];

function getUserVersion(d: DatabaseSync): number {
  const row = d.prepare(`PRAGMA user_version`).get() as
    | { user_version?: number }
    | undefined;
  const v = row?.user_version;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function setUserVersion(d: DatabaseSync, version: number): void {
  // PRAGMA arguments cannot be bound; the value is a validated integer literal.
  d.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * Bring a database up to SCHEMA_VERSION. Additive and idempotent, so it is safe
 * on a brand-new file, on an existing version-0 DevPulse database, and on every
 * subsequent open. Throws only if the database itself is unusable — callers
 * treat that as "storage unavailable" and degrade to a no-op.
 */
export function migrate(d: DatabaseSync): void {
  const from = getUserVersion(d);
  // A database written by a newer build: leave it exactly as it is.
  if (from >= SCHEMA_VERSION) return;

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    m.up(d);
    setUserVersion(d, m.version);
  }
}
