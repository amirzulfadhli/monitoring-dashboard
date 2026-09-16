/**
 * Unified History timeline assembly (Task 19).
 *
 * These tests exist to pin the *output semantics* of `buildTimeline`, because
 * the assembly path was optimized for cost: display names are now resolved from
 * a per-build cache instead of one settings query per emitted event, and the
 * website/cost formatting no longer round-trips through ICU. None of that may
 * change what the API returns.
 *
 * Every test works in a fresh OS temp directory: the real
 * `.devpulse/telemetry.db` is never opened, and nothing here touches the network
 * or an external service.
 *
 * What is deliberately covered — and nothing more:
 *   - website state transitions (baseline row is not an event; each change is)
 *   - settings-first display names with the seeded/fallback chain intact
 *   - GitHub change derivation (commit / workflow / health state)
 *   - equal-time insertion order, newest-first ordering and the 2000 cap
 *   - cost rendering equivalence with the previous toLocaleString expression
 *   - an empty or legacy database degrades to an empty timeline, never throws
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate } from "../src/lib/db/schema";
import { closeDb } from "../src/lib/db/index";
import { buildTimeline } from "../src/lib/history";
import type { TimelineEvent } from "../src/lib/history/model";

/* ------------------------------ helpers ------------------------------ */

const NOW = Date.now();

/**
 * Run `fn` against a fresh temp database. The legacy variants seed their own
 * schema first, so they get a raw handle instead of the migrated one.
 */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => void,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-history-"));
  const file = path.join(dir, DB_FILE_NAME);
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = file;
  const db = new DatabaseSync(file);
  migrate(db);
  try {
    fn(db);
  } finally {
    db.close();
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Persist one website check at `ts`. */
function check(db: DatabaseSync, ts: number, targetId: string, state: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO website_checks (ts, targetId, state, httpStatus, latencyMs)
     VALUES (?, ?, ?, 200, 12)`,
  ).run(ts, targetId, state);
}

type SnapshotInput = {
  ts: number;
  repoKey: string;
  displayName?: string;
  state?: string;
  commitSha?: string | null;
  workflowStatus?: string | null;
  workflowConclusion?: string | null;
};

function snapshot(db: DatabaseSync, s: SnapshotInput): void {
  db.prepare(
    `INSERT OR IGNORE INTO github_snapshots
       (ts, repoKey, repoName, displayName, state, commitSha, workflowName,
        workflowStatus, workflowConclusion, workflowBranch)
     VALUES (?, ?, ?, ?, ?, ?, 'ci', ?, ?, 'main')`,
  ).run(
    s.ts,
    s.repoKey,
    s.repoKey.split("/")[1],
    s.displayName ?? "Snap name",
    s.state ?? "healthy",
    s.commitSha ?? "aaa111",
    s.workflowStatus ?? "completed",
    s.workflowConclusion ?? "success",
  );
}

function addSite(db: DatabaseSync, id: string, name: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO monitored_websites
       (id, name, url, expectedStatus, enabled, createdAt, updatedAt)
     VALUES (?, ?, 'https://x.test', 200, 1, 1, 1)`,
  ).run(id, name);
}

function addRepo(
  db: DatabaseSync,
  id: string,
  owner: string,
  repo: string,
  displayName: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO monitored_repositories
       (id, owner, repo, displayName, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, 1, 1)`,
  ).run(id, owner, repo, displayName);
}

const ofSource = (events: TimelineEvent[], source: string) =>
  events.filter((e) => e.source === source);

/* ----------------------------- websites ----------------------------- */

test("website transitions: a baseline row is not an event, each change is", (t) => {
  withTempDb(t, (db) => {
    const base = NOW - 3_600_000;
    // healthy(1) healthy(2) down(3) down(4) degraded(5)
    const states = ["healthy", "healthy", "down", "down", "degraded"];
    for (let i = 0; i < states.length; i++) {
      check(db, base + i * 60_000, "site-a", states[i]);
    }

    const events = ofSource(buildTimeline("24H"), "website");
    assert.equal(events.length, 2, "only the two real changes emit");

    // Newest first: degraded (5) then down (3).
    assert.deepEqual(
      events.map((e) => [e.ts, e.metadata?.from, e.metadata?.state]),
      [
        [base + 4 * 60_000, "down", "degraded"],
        [base + 2 * 60_000, "healthy", "down"],
      ],
    );
    assert.equal(events[1].id, `website:website_state:site-a:${base + 2 * 60_000}`);
    assert.equal(events[1].severity, "critical");
    assert.equal(events[0].severity, "warning");
    assert.equal(events[0].type, "website_state");
  });
});

test("display names: settings win, then the seeded list, then the raw id", (t) => {
  withTempDb(t, (db) => {
    const base = NOW - 600_000;
    // "example-com" is in the seeded source list; "site-x" is not.
    addSite(db, "example-com", "Renamed API");
    for (const id of ["example-com", "site-x", "site-y"]) {
      check(db, base, id, "healthy");
      check(db, base + 60_000, id, "down");
    }

    const titles = ofSource(buildTimeline("24H"), "website").map((e) => e.title);
    assert.ok(titles.includes("Renamed API → down"), "settings name takes precedence");
    assert.ok(titles.includes("site-x → down"), "an unknown target falls back to its id");
    assert.ok(titles.includes("site-y → down"));
  });
});

test("display names: a target removed from settings falls back to the seeded name", (t) => {
  withTempDb(t, (db) => {
    const base = NOW - 600_000;
    // No monitored_websites rows at all: the seeded array is the fallback.
    check(db, base, "example-com", "healthy");
    check(db, base + 60_000, "example-com", "down");

    const events = ofSource(buildTimeline("24H"), "website");
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "Example (placeholder) → down");
  });
});

/* ------------------------------ GitHub ------------------------------ */

test("GitHub emits only on a real change, from a per-repo baseline", (t) => {
  withTempDb(t, (db) => {
    const base = NOW - 3_600_000;
    const repo = "amirzulfadhli/devpulse";
    snapshot(db, { ts: base, repoKey: repo, commitSha: "aaa111" });
    snapshot(db, { ts: base + 60_000, repoKey: repo, commitSha: "aaa111" }); // unchanged
    snapshot(db, { ts: base + 120_000, repoKey: repo, commitSha: "bbb222" }); // commit
    snapshot(db, {
      ts: base + 180_000,
      repoKey: repo,
      commitSha: "bbb222",
      workflowConclusion: "failure",
    }); // workflow
    snapshot(db, {
      ts: base + 240_000,
      repoKey: repo,
      commitSha: "bbb222",
      workflowConclusion: "failure",
      state: "attention",
    }); // health

    const events = ofSource(buildTimeline("24H"), "github");
    // Newest first: health change, then workflow, then the commit.
    assert.deepEqual(
      events.map((e) => e.type),
      ["repo_state_changed", "workflow_changed", "commit_changed"],
    );
    assert.equal(events[0].metadata?.from, "healthy");
    assert.equal(events[0].metadata?.state, "attention");
    // The snapshot's own label is preferred over the settings/seeded fallback.
    assert.equal(events[1].title, "Snap name · workflow failure");
    assert.equal(events[1].severity, "warning");
    assert.equal(events[2].title, "Snap name · new commit");
  });
});

test("GitHub display names: the snapshot label wins, a blank one falls through", (t) => {
  withTempDb(t, (db) => {
    const base = NOW - 600_000;
    // A persisted rename must beat the seeded "DevPulse" label.
    addRepo(db, "r1", "amirzulfadhli", "devpulse", "Renamed Repo");
    snapshot(db, { ts: base, repoKey: "amirzulfadhli/devpulse", commitSha: "aaa111" });
    snapshot(db, {
      ts: base + 60_000,
      repoKey: "amirzulfadhli/devpulse",
      commitSha: "bbb222",
      displayName: "",
    });
    snapshot(db, { ts: base, repoKey: "other/unknown", commitSha: "aaa111", displayName: "" });
    snapshot(db, {
      ts: base + 60_000,
      repoKey: "other/unknown",
      commitSha: "bbb222",
      displayName: "",
    });

    const titles = ofSource(buildTimeline("24H"), "github").map((e) => e.title);
    // Blank snapshot label -> settings/seeded name -> (unknown) raw repo key.
    assert.ok(titles.includes("Renamed Repo · new commit"), "settings name wins");
    assert.ok(titles.includes("other/unknown · new commit"));
  });
});

/* --------------------------- ordering / cap --------------------------- */

test("the timeline is newest-first and capped at 2000 events", (t) => {
  withTempDb(t, (db) => {
    const base = NOW - 3_000_000;
    // One target alternating state every minute: every row after the first is a
    // transition, so this yields more events than the cap allows.
    let state = "healthy";
    for (let i = 0; i < 2100; i++) {
      check(db, base + i * 60_000, "site-a", state);
      state = state === "healthy" ? "down" : "healthy";
    }

    const events = buildTimeline("24H");
    assert.equal(events.length, 2000, "the cap bounds the response");
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i - 1].ts >= events[i].ts, "newest first");
    }
    // The cap keeps the newest 2000, i.e. it drops the oldest transitions.
    assert.equal(events[0].ts, base + 2099 * 60_000);
  });
});

test("equal-timestamp events keep their source order (system before network)", (t) => {
  withTempDb(t, (db) => {
    const ts = NOW - 600_000;
    db.prepare(
      `INSERT OR IGNORE INTO history (ts, cpuPct, usedMem, rxRate, txRate)
       VALUES (?, 42.5, 1024, 2048, 1024)`,
    ).run(ts);

    const sources = buildTimeline("24H").map((e) => e.source);
    assert.deepEqual(sources, ["system", "network"]);
  });
});

test("AI bucket cost renders like toLocaleString for the same value", (t) => {
  withTempDb(t, (db) => {
    const ins = db.prepare(
      `INSERT INTO ai_usage
         (ts, provider, model, inputTokens, outputTokens, totalTokens, success,
          estimatedCostUsd, source)
       VALUES (?, 'deepseek', 'deepseek-chat', 1000, 500, 1500, 1, ?, 'direct')`,
    );
    // One hour bucket; costs sum to a value that needs thousands separators.
    const base = NOW - 3_000_000;
    const each = 62.5208;
    for (let i = 0; i < 24; i++) ins.run(base + i * 1000, each);

    const events = ofSource(buildTimeline("24H"), "ai");
    assert.equal(events.length, 1);

    const total = 24 * each;
    const expected = `$${Number(total.toFixed(4)).toLocaleString("en-US", {
      maximumFractionDigits: 4,
    })}`;
    assert.equal(events[0].description, `24 requests · 36K tokens (24K in / 12K out) · ${expected} est`);
    assert.equal(events[0].metadata?.estimatedCostUsd, Number(total.toFixed(4)));
  });
});

/* --------------------------- degraded states --------------------------- */

test("an empty database yields an empty timeline rather than throwing", (t) => {
  withTempDb(t, () => {
    assert.deepEqual(buildTimeline("24H"), []);
    assert.deepEqual(buildTimeline("30D"), []);
  });
});

test("a legacy version-0 database still assembles a timeline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-history-legacy-"));
  const file = path.join(dir, DB_FILE_NAME);
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = file;
  try {
    // A pre-versioning DevPulse database: the tables exist, nothing is stamped.
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE website_checks (
        ts INTEGER, targetId TEXT, state TEXT, httpStatus INTEGER,
        latencyMs REAL, errorType TEXT, error TEXT,
        PRIMARY KEY (ts, targetId)
      );
      CREATE TABLE history (
        ts INTEGER PRIMARY KEY, cpuPct REAL, usedMem INTEGER, availMem INTEGER,
        rxRate REAL, txRate REAL, rxTotal INTEGER, txTotal INTEGER
      );
    `);
    const ts = NOW - 600_000;
    legacy
      .prepare(
        `INSERT INTO website_checks (ts, targetId, state, latencyMs) VALUES (?, 'legacy-site', 'down', 5)`,
      )
      .run(ts);
    legacy.close();

    // migrate() adopts the existing schema; no table or row is lost.
    closeDb();
    const events = ofSource(buildTimeline("24H"), "website");
    assert.deepEqual(events, [], "a lone check is a baseline, not a transition");
  } finally {
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
