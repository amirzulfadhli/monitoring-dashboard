/**
 * Database layer guarantees (Task 17). Every test works in a fresh OS temp
 * directory: the real `.devpulse/telemetry.db` is never opened, and no test
 * touches the network or any external service.
 *
 * What is deliberately covered — and nothing more:
 *   - path precedence (DEVPULSE_DB_PATH → DEVPULSE_DB_DIR → default)
 *   - a fresh database opens at SCHEMA_VERSION with the core tables/indexes
 *   - repeated initialization is a no-op
 *   - a version-0 legacy database upgrades without losing rows
 *   - a database from a newer build is never downgraded
 *
 * Individual column details are intentionally not asserted: one representative
 * assertion per behaviour is enough to catch a regression in the schema layer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME, DEFAULT_DB_DIR, resolveDbPath } from "../src/lib/db/path";
import { SCHEMA_VERSION, migrate } from "../src/lib/db/schema";
import { closeDb, getDb } from "../src/lib/db/index";

/* ------------------------------ helpers ------------------------------ */

const DB_ENV = ["DEVPULSE_DB_PATH", "DEVPULSE_DB_DIR"] as const;

/** Run `fn` with exactly the given DEVPULSE_* environment, restoring it after. */
function withEnv(
  vars: Partial<Record<(typeof DB_ENV)[number], string>>,
  fn: () => void,
): void {
  const saved = DB_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of DB_ENV) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** An isolated temp directory, removed when the test finishes. */
function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-test-"));
  t.after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? 0;
}

function names(db: DatabaseSync, type: "table" | "index"): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ?")
    .all(type);
  return new Set(rows.map((r) => String(r.name)));
}

/* ------------------------------ the tests ------------------------------ */

test("db path precedence: DEVPULSE_DB_PATH beats DIR beats the default", () => {
  withEnv({}, () => {
    assert.equal(
      resolveDbPath(),
      path.join(process.cwd(), DEFAULT_DB_DIR, DB_FILE_NAME),
    );
  });

  withEnv({ DEVPULSE_DB_DIR: path.join("scratch", "dir") }, () => {
    assert.equal(
      resolveDbPath(),
      path.join(path.resolve("scratch", "dir"), DB_FILE_NAME),
    );
  });

  withEnv(
    {
      DEVPULSE_DB_DIR: path.join("scratch", "dir"),
      DEVPULSE_DB_PATH: path.join("scratch", "custom.db"),
    },
    () => {
      assert.equal(resolveDbPath(), path.resolve("scratch", "custom.db"));
    },
  );

  // A blank value is not a configuration: it falls back to the default rather
  // than resolving to the working directory.
  withEnv({ DEVPULSE_DB_PATH: "   " }, () => {
    assert.equal(
      resolveDbPath(),
      path.join(process.cwd(), DEFAULT_DB_DIR, DB_FILE_NAME),
    );
  });
});

test("a fresh database opens at SCHEMA_VERSION with the core schema", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, DB_FILE_NAME);

  withEnv({ DEVPULSE_DB_PATH: file }, () => {
    const db = getDb();
    assert.ok(db, "getDb() should open the configured path");
    assert.equal(existsSync(file), true, "the database file should be created");
    assert.equal(userVersion(db), SCHEMA_VERSION);

    const tables = names(db, "table");
    for (const table of [
      "history",
      "website_checks",
      "ai_usage",
      "github_snapshots",
      "alerts",
      "alert_explanations",
      "intelligence",
      "monitored_websites",
      "monitored_repositories",
      "app_settings",
      "maintenance_state",
    ]) {
      assert.ok(tables.has(table), `missing table: ${table}`);
    }

    const indexes = names(db, "index");
    for (const index of [
      "idx_website_checks_target_ts",
      "uq_ai_usage_message_id",
      "idx_ai_usage_ts",
      "idx_github_snapshots_ts",
      "idx_explain_fp",
    ]) {
      assert.ok(indexes.has(index), `missing index: ${index}`);
    }

    // Re-initialization is safe: same handle, still one schema version.
    assert.equal(getDb(), db, "the shared connection should be reused");
    assert.equal(userVersion(db), SCHEMA_VERSION);
  });
});

test("a version-0 legacy database upgrades without losing rows", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, DB_FILE_NAME);

  // A database created before versioning existed, with an ai_usage table from
  // before the Claude Code columns were added.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE history (
      ts INTEGER PRIMARY KEY, cpuPct REAL, usedMem INTEGER, availMem INTEGER,
      rxRate REAL, txRate REAL, rxTotal INTEGER, txTotal INTEGER
    );
    CREATE TABLE ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      provider TEXT NOT NULL, model TEXT, inputTokens INTEGER,
      outputTokens INTEGER, cachedTokens INTEGER, totalTokens INTEGER,
      latencyMs REAL, httpStatus INTEGER, success INTEGER NOT NULL,
      errorType TEXT, requestId TEXT, estimatedCostUsd REAL
    );
    INSERT INTO history (ts, cpuPct) VALUES (1000, 42.5);
    INSERT INTO ai_usage (ts, provider, success) VALUES (1000, 'deepseek', 1);
  `);
  assert.equal(userVersion(legacy), 0);
  legacy.close();

  const db = new DatabaseSync(file);
  migrate(db);

  assert.equal(userVersion(db), SCHEMA_VERSION, "version should be stamped");
  // Compared field-by-field: node:sqlite rows are null-prototype objects, so
  // deepStrictEqual against an object literal would fail on the prototype.
  const history = db.prepare("SELECT ts, cpuPct FROM history").all();
  assert.equal(history.length, 1, "the existing history row should survive");
  assert.equal(history[0].ts, 1000);
  assert.equal(history[0].cpuPct, 42.5);

  const aiColumns = new Set(
    db
      .prepare("PRAGMA table_info(ai_usage)")
      .all()
      .map((c) => String(c.name)),
  );
  for (const column of ["source", "sessionId", "messageId"]) {
    assert.ok(aiColumns.has(column), `missing migrated column: ${column}`);
  }

  const rows = db.prepare("SELECT provider, source FROM ai_usage").all();
  assert.equal(rows.length, 1, "the existing AI row should survive");
  assert.equal(rows[0].provider, "deepseek");
  assert.equal(rows[0].source, "direct", "the new column should default");

  db.close();
});

test("a database from a newer build is not downgraded", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, DB_FILE_NAME);

  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version = 999");
  migrate(db);

  assert.equal(userVersion(db), 999, "a newer version must be left alone");
  assert.equal(
    names(db, "table").size,
    0,
    "no schema should be created in a newer database",
  );

  db.close();
});
