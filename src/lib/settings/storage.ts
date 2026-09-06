/**
 * Persistence for DevPulse configuration.
 *
 * Lives in the same on-disk SQLite database as the telemetry / monitoring /
 * alert histories (`.devpulse/telemetry.db`) but in its own settings tables so
 * configuration never mixes with captured history. The DB opens lazily and every
 * call is wrapped so a storage failure degrades to a safe fallback rather than
 * breaking monitoring or alerts.
 *
 * No API keys or secrets are stored here — credentials stay in environment
 * variables.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { monitoredSites } from "@/data/monitored-sites";
import { monitoredRepos } from "@/data/monitored-repos";
import { alertConfig } from "@/lib/alerts/config";
import type {
  AiAlertSettings,
  MonitoredRepository,
  MonitoredWebsite,
  SystemAlertSettings,
} from "./types";

// Optional override lets verification run against a scratch DB instead of the
// real one. Unset (production) => the same file every other module uses.
const DB_DIR =
  process.env.DEVPULSE_DB_DIR ?? path.join(process.cwd(), ".devpulse");
const DB_PATH = path.join(DB_DIR, "telemetry.db");

/** Marker key written once after first-run seeding from source config. */
const SEED_MARKER = "seeded.v1";

let db: DatabaseSync | null = null;

/** Open (once) and prepare the database. Returns null on any failure. */
function openDb(): DatabaseSync | null {
  if (db) return db;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    const d = new DatabaseSync(DB_PATH);
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
    db = d;
    return d;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * First-run seeding from the historical source configuration.
 *
 * Runs once (guarded by a marker row), then the DB is authoritative. Because
 * seed website ids match the ids the old code emitted, existing website_checks
 * history keeps lining up. Repeated startups never duplicate: the marker and
 * PRIMARY KEYs make the migration idempotent.
 * ------------------------------------------------------------------ */

function seed(): void {
  const d = openDb();
  if (!d) return;
  const now = Date.now();
  const insertSite = d.prepare(
    `INSERT OR IGNORE INTO monitored_websites
       (id, name, url, expectedStatus, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  const insertRepo = d.prepare(
    `INSERT OR IGNORE INTO monitored_repositories
       (id, owner, repo, displayName, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  const putSetting = d.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`,
  );
  try {
    d.exec("BEGIN");
    for (const s of monitoredSites) {
      insertSite.run(s.id, s.name, s.url, s.expectedStatus ?? null, now, now);
    }
    for (const r of monitoredRepos) {
      insertRepo.run(
        `${r.owner}/${r.repo}`,
        r.owner,
        r.repo,
        r.displayName,
        now,
        now,
      );
    }
    // Seed the current CPU/memory thresholds; AI budgets stay disabled (null).
    putSetting.run(
      "alerts.system",
      JSON.stringify({
        cpuWarnPct: alertConfig.system.cpuWarnPct,
        cpuCritPct: alertConfig.system.cpuCritPct,
        memWarnPct: alertConfig.system.memWarnPct,
        memCritPct: alertConfig.system.memCritPct,
      }),
    );
    putSetting.run(
      "alerts.ai",
      JSON.stringify({
        tokenBudget24h: alertConfig.ai.tokenBudget24h,
        costBudget24hUsd: alertConfig.ai.costBudget24hUsd,
      }),
    );
    putSetting.run(SEED_MARKER, "1");
    d.exec("COMMIT");
  } catch {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Ensure configuration is seeded from source. Safe to call on every read; the
 * marker keeps it to a single, idempotent pass. Never throws.
 */
export function ensureSeeded(): void {
  const d = openDb();
  if (!d) return;
  try {
    const marker = d
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get(SEED_MARKER) as { value: string } | undefined;
    if (marker) return;
  } catch {
    return;
  }
  seed();
}

/* ------------------------------------------------------------------ *
 * Read helpers (null => DB unavailable; [] => available but empty)
 * ------------------------------------------------------------------ */

type SiteRow = {
  id: string;
  name: string;
  url: string;
  expectedStatus: number | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

function siteFromRow(r: SiteRow): MonitoredWebsite {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    expectedStatus: r.expectedStatus,
    enabled: !!r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** All configured websites (enabled or not). null => DB unavailable. */
export function listWebsites(): MonitoredWebsite[] | null {
  const d = openDb();
  if (!d) return null;
  try {
    const rows = d
      .prepare(
        `SELECT id, name, url, expectedStatus, enabled, createdAt, updatedAt
           FROM monitored_websites ORDER BY createdAt ASC, id ASC`,
      )
      .all() as unknown as SiteRow[];
    return rows.map(siteFromRow);
  } catch {
    return null;
  }
}

type RepoRow = {
  id: string;
  owner: string;
  repo: string;
  displayName: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

function repoFromRow(r: RepoRow): MonitoredRepository {
  return {
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    displayName: r.displayName,
    enabled: !!r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** All configured repositories (enabled or not). null => DB unavailable. */
export function listRepositories(): MonitoredRepository[] | null {
  const d = openDb();
  if (!d) return null;
  try {
    const rows = d
      .prepare(
        `SELECT id, owner, repo, displayName, enabled, createdAt, updatedAt
           FROM monitored_repositories ORDER BY createdAt ASC, id ASC`,
      )
      .all() as unknown as RepoRow[];
    return rows.map(repoFromRow);
  } catch {
    return null;
  }
}

function readJsonSetting(key: string): unknown {
  const d = openDb();
  if (!d) return null;
  try {
    const row = d
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/** Persisted CPU/memory thresholds, or null when unset / DB unavailable. */
export function readSystemThresholds(): SystemAlertSettings | null {
  const v = readJsonSetting("alerts.system");
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<SystemAlertSettings>;
  if (
    typeof s.cpuWarnPct !== "number" ||
    typeof s.cpuCritPct !== "number" ||
    typeof s.memWarnPct !== "number" ||
    typeof s.memCritPct !== "number"
  ) {
    return null;
  }
  return {
    cpuWarnPct: s.cpuWarnPct,
    cpuCritPct: s.cpuCritPct,
    memWarnPct: s.memWarnPct,
    memCritPct: s.memCritPct,
  };
}

/** Persisted AI budgets, or null when unset / DB unavailable. */
export function readAiBudgets(): AiAlertSettings | null {
  const v = readJsonSetting("alerts.ai");
  if (!v || typeof v !== "object") return null;
  const a = v as Partial<AiAlertSettings>;
  return {
    tokenBudget24h: a.tokenBudget24h ?? null,
    costBudget24hUsd: a.costBudget24hUsd ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Website CRUD. Removal deletes only the config row — historical
 * website_checks rows are never touched (evidence is preserved).
 * ------------------------------------------------------------------ */

export function insertWebsite(input: {
  name: string;
  url: string;
  expectedStatus: number | null;
}): MonitoredWebsite | null {
  const d = openDb();
  if (!d) return null;
  const now = Date.now();
  const id = randomUUID();
  try {
    d.prepare(
      `INSERT INTO monitored_websites
         (id, name, url, expectedStatus, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, input.name.trim(), input.url.trim(), input.expectedStatus, now, now);
    return siteFromRow({
      id,
      name: input.name.trim(),
      url: input.url.trim(),
      expectedStatus: input.expectedStatus,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return null;
  }
}

/** Update any subset of name/url/expectedStatus/enabled for a website. */
export function updateWebsite(
  id: string,
  patch: {
    name?: string;
    url?: string;
    expectedStatus?: number | null;
    enabled?: boolean;
  },
): boolean {
  const d = openDb();
  if (!d) return false;
  const now = Date.now();
  const sets: string[] = ["updatedAt = ?"];
  const args: (string | number | null)[] = [now];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name.trim());
  }
  if (patch.url !== undefined) {
    sets.push("url = ?");
    args.push(patch.url.trim());
  }
  if (patch.expectedStatus !== undefined) {
    sets.push("expectedStatus = ?");
    args.push(patch.expectedStatus);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  args.push(id);
  try {
    const r = d.prepare(
      `UPDATE monitored_websites SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...args);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/** Remove a monitored website from config. History is intentionally kept. */
export function deleteWebsite(id: string): boolean {
  const d = openDb();
  if (!d) return false;
  try {
    const r = d.prepare(`DELETE FROM monitored_websites WHERE id = ?`).run(id);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Repository CRUD (same rule: removal never deletes historical snapshots)
 * ------------------------------------------------------------------ */

export function insertRepository(input: {
  owner: string;
  repo: string;
  displayName: string;
}): MonitoredRepository | null {
  const d = openDb();
  if (!d) return null;
  const now = Date.now();
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const id = `${owner}/${repo}`;
  try {
    d.prepare(
      `INSERT INTO monitored_repositories
         (id, owner, repo, displayName, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, owner, repo, input.displayName.trim(), now, now);
    return repoFromRow({
      id,
      owner,
      repo,
      displayName: input.displayName.trim(),
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return null; // unique (owner, repo) collision or DB failure
  }
}

export function updateRepository(
  id: string,
  patch: {
    owner?: string;
    repo?: string;
    displayName?: string;
    enabled?: boolean;
  },
): boolean {
  const d = openDb();
  if (!d) return false;
  const now = Date.now();
  const sets: string[] = ["updatedAt = ?"];
  const args: (string | number | null)[] = [now];
  if (patch.owner !== undefined) {
    sets.push("owner = ?");
    args.push(patch.owner.trim());
  }
  if (patch.repo !== undefined) {
    sets.push("repo = ?");
    args.push(patch.repo.trim());
  }
  if (patch.displayName !== undefined) {
    sets.push("displayName = ?");
    args.push(patch.displayName.trim());
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  args.push(id);
  try {
    const r = d.prepare(
      `UPDATE monitored_repositories SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...args);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

export function deleteRepository(id: string): boolean {
  const d = openDb();
  if (!d) return false;
  try {
    const r = d.prepare(`DELETE FROM monitored_repositories WHERE id = ?`).run(id);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Scalar alert settings
 * ------------------------------------------------------------------ */

export function writeSystemThresholds(s: SystemAlertSettings): boolean {
  const d = openDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES ('alerts.system', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(s));
    return Number(r.changes) >= 0;
  } catch {
    return false;
  }
}

export function writeAiBudgets(a: AiAlertSettings): boolean {
  const d = openDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES ('alerts.ai', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(a));
    return Number(r.changes) >= 0;
  } catch {
    return false;
  }
}
