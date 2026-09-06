import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { RepoSnapshot } from "./github";

/**
 * Persistence for compact GitHub repository-health snapshots. Mirrors the other
 * storage modules: the DB opens lazily, every call degrades to a no-op on
 * failure, and rows live in the same on-disk SQLite database — but in their own
 * table so GitHub history never mixes with website checks, telemetry, or alerts.
 *
 * Kept separate from the GitHub API fetcher on purpose: the monitor (github.ts)
 * produces its normalized result, and this layer consumes that result. No full
 * GitHub payloads, tokens, commit bodies, or workflow logs are ever stored —
 * only the small health/status surface DevPulse relies on.
 */

const DB_DIR = path.join(process.cwd(), ".devpulse");
const DB_PATH = path.join(DB_DIR, "telemetry.db");

/**
 * Minimum interval between *routine* snapshots of one repository. State changes
 * still persist sooner (see persistGithubSnapshots), so unchanged results never
 * accumulate into duplicate history, but a periodic beat is preserved.
 */
export const MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/** Repository health state as persisted (the monitor never persists a failure). */
export type GithubHealthState = "healthy" | "attention" | "running";

/** One compact stored snapshot — the read surface for alerts and future timeline. */
export type StoredGithubSnapshot = {
  ts: number; // epoch ms the snapshot was taken
  repoKey: string; // owner/repo
  repoName: string; // repository slug
  displayName: string; // human label used by the UI / alerts
  state: GithubHealthState;
  commitSha: string | null;
  commitDateMs: number | null;
  openIssues: number | null;
  openPrs: number | null;
  workflowName: string | null;
  workflowStatus: string | null;
  workflowConclusion: string | null;
  workflowBranch: string | null;
  lastPushMs: number | null; // repository last_push time
};

type Row = {
  ts: number;
  repoKey: string;
  repoName: string;
  displayName: string;
  state: string;
  commitSha: string | null;
  commitDateMs: number | null;
  openIssues: number | null;
  openPrs: number | null;
  workflowName: string | null;
  workflowStatus: string | null;
  workflowConclusion: string | null;
  workflowBranch: string | null;
  lastPushMs: number | null;
};

let db: DatabaseSync | null = null;

/**
 * The DB location, overridable for scratch/isolated verification so synthetic
 * test rows never touch the real telemetry database.
 */
function dbPath(): string {
  return process.env.DEVPULSE_DB_PATH
    ? path.resolve(process.env.DEVPULSE_DB_PATH)
    : DB_PATH;
}

/** Open (once) and prepare the database. Returns null on any failure. */
function openDb(): DatabaseSync | null {
  if (db) return db;
  try {
    mkdirSync(path.dirname(dbPath()), { recursive: true });
    const d = new DatabaseSync(dbPath());
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
    `);
    db = d;
    return d;
  } catch {
    return null;
  }
}

function toSnapshot(r: Row): StoredGithubSnapshot {
  return {
    ts: r.ts,
    repoKey: r.repoKey,
    repoName: r.repoName,
    displayName: r.displayName,
    state: r.state as GithubHealthState,
    commitSha: r.commitSha,
    commitDateMs: r.commitDateMs,
    openIssues: r.openIssues,
    openPrs: r.openPrs,
    workflowName: r.workflowName,
    workflowStatus: r.workflowStatus,
    workflowConclusion: r.workflowConclusion,
    workflowBranch: r.workflowBranch,
    lastPushMs: r.lastPushMs,
  };
}

/**
 * Persist the monitored repos' normalized results as compact snapshots, applying
 * the cadence guard per repository:
 *   - a failed/partial read is never persisted (no misleading "healthy" row);
 *   - a meaningful transition (workflow status/conclusion, health state, or
 *     latest commit SHA change) persists immediately;
 *   - otherwise an unchanged result persists only after MIN_SNAPSHOT_INTERVAL_MS.
 * Returns the number of new rows inserted. Never throws.
 */
export function persistGithubSnapshots(repos: RepoSnapshot[]): number {
  const d = openDb();
  if (!d) return 0;
  const now = Date.now();
  let inserted = 0;
  const latestStmt = d.prepare(
    `SELECT ts, state, commitSha, workflowStatus, workflowConclusion
       FROM github_snapshots WHERE repoKey = ? ORDER BY ts DESC LIMIT 1`,
  );
  const insertStmt = d.prepare(
    `INSERT OR IGNORE INTO github_snapshots
       (ts, repoKey, repoName, displayName, state, commitSha, commitDateMs,
        openIssues, openPrs, workflowName, workflowStatus, workflowConclusion,
        workflowBranch, lastPushMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const r of repos) {
    if (r.error !== null) continue; // only successful reads become snapshots

    // Meaningful-transition signature; matching it means "no state change".
    const sig =
      `${r.commitSha ?? ""}|${r.workflowStatus ?? ""}|` +
      `${r.workflowConclusion ?? ""}|${r.state}`;

    let last: Row | undefined;
    try {
      last = latestStmt.get(r.key) as Row | undefined;
    } catch {
      last = undefined;
    }

    if (last) {
      const lastSig =
        `${last.commitSha ?? ""}|${last.workflowStatus ?? ""}|` +
        `${last.workflowConclusion ?? ""}|${last.state}`;
      const changed = lastSig !== sig;
      const due = now - last.ts >= MIN_SNAPSHOT_INTERVAL_MS;
      if (!changed && !due) continue; // unchanged within the guard -> no duplicate
    }

    try {
      const res = insertStmt.run(
        r.checkedAtMs,
        r.key,
        r.repo,
        r.displayName,
        r.state,
        r.commitSha,
        r.commitDateMs,
        r.openIssues,
        r.openPrs,
        r.workflowName,
        r.workflowStatus,
        r.workflowConclusion,
        r.workflowBranch,
        r.pushedAtMs,
      );
      inserted += Number(res.changes);
    } catch {
      // Persistence for one repo must never break the rest (or the monitor).
    }
  }
  return inserted;
}

/**
 * The newest persisted snapshot per repository. The alert engine evaluates the
 * WORKFLOW_FAILED rule from these rather than firing a live GitHub fetch, so no
 * duplicate API call is made just to raise an alert. Returns [] on no data or DB
 * failure — callers treat an empty result as "GitHub evaluation unavailable".
 */
export function readLatestGithubSnapshots(): StoredGithubSnapshot[] {
  const d = openDb();
  if (!d) return [];
  try {
    const rows = d
      .prepare(
        `SELECT s.* FROM github_snapshots s
          JOIN (SELECT repoKey, MAX(ts) AS m FROM github_snapshots GROUP BY repoKey) x
            ON x.repoKey = s.repoKey AND x.m = s.ts
         ORDER BY s.repoKey ASC`,
      )
      .all() as Row[];
    return rows.map(toSnapshot);
  } catch {
    return [];
  }
}

/**
 * Recent snapshots for one repository, newest-first, bounded to `limit`.
 * Small internal read for future timeline/history work; size stays bounded so a
 * repository can never flood a response. Returns [] on no data or DB failure.
 */
export function readGithubSnapshotHistory(
  repoKey: string,
  limit: number,
): StoredGithubSnapshot[] {
  const d = openDb();
  if (!d) return [];
  const capped = Math.max(1, Math.min(Math.floor(limit) || 1, 500));
  try {
    const rows = d
      .prepare(
        `SELECT * FROM github_snapshots WHERE repoKey = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(repoKey, capped) as Row[];
    return rows.map(toSnapshot);
  } catch {
    return [];
  }
}
