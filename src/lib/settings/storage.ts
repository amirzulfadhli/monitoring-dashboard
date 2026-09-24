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

import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { monitoredSites } from "@/data/monitored-sites";
import { monitoredRepos } from "@/data/monitored-repos";
import { alertConfig } from "@/lib/alerts/config";
import { deviceTypeOf, type DeviceType } from "@/lib/devices/model";
import {
  NOTIFICATION_MIN_SEVERITIES,
  type NotificationMinSeverity,
  type NotificationSettings,
} from "@/lib/notifications/model";

import type {
  AiAlertSettings,
  ApiMethod,
  MonitoredApi,
  MonitoredDevice,
  MonitoredRepository,
  MonitoredWebsite,
  SystemAlertSettings,
} from "./types";

/** Marker key written once after first-run seeding from source config. */
const SEED_MARKER = "seeded.v1";

/* ------------------------------------------------------------------ *
 * First-run seeding from the historical source configuration.
 *
 * Runs once (guarded by a marker row), then the DB is authoritative. Because
 * seed website ids match the ids the old code emitted, existing website_checks
 * history keeps lining up. Repeated startups never duplicate: the marker and
 * PRIMARY KEYs make the migration idempotent.
 * ------------------------------------------------------------------ */

function seed(): void {
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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

type ApiRow = {
  id: string;
  name: string;
  url: string;
  method: string;
  expectedStatus: number | null;
  timeoutMs: number | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

function apiFromRow(r: ApiRow): MonitoredApi {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    method: r.method as ApiMethod,
    expectedStatus: r.expectedStatus,
    timeoutMs: r.timeoutMs,
    enabled: !!r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** All configured API monitors (enabled or not). null => DB unavailable. */
export function listApis(): MonitoredApi[] | null {
  const d = getDb();
  if (!d) return null;
  try {
    const rows = d
      .prepare(
        `SELECT id, name, url, method, expectedStatus, timeoutMs, enabled, createdAt, updatedAt
           FROM monitored_apis ORDER BY createdAt ASC, id ASC`,
      )
      .all() as unknown as ApiRow[];
    return rows.map(apiFromRow);
  } catch {
    return null;
  }
}

export function insertApi(input: {
  name: string;
  url: string;
  method: ApiMethod;
  expectedStatus: number | null;
  timeoutMs: number | null;
}): MonitoredApi | null {
  const d = getDb();
  if (!d) return null;
  const now = Date.now();
  const id = randomUUID();
  const name = input.name.trim();
  const url = input.url.trim();
  try {
    d.prepare(
      `INSERT INTO monitored_apis
         (id, name, url, method, expectedStatus, timeoutMs, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      name,
      url,
      input.method,
      input.expectedStatus,
      input.timeoutMs,
      now,
      now,
    );
    return apiFromRow({
      id,
      name,
      url,
      method: input.method,
      expectedStatus: input.expectedStatus,
      timeoutMs: input.timeoutMs,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return null;
  }
}

/** Update any subset of an API monitor's fields. */
export function updateApi(
  id: string,
  patch: {
    name?: string;
    url?: string;
    method?: ApiMethod;
    expectedStatus?: number | null;
    timeoutMs?: number | null;
    enabled?: boolean;
  },
): boolean {
  const d = getDb();
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
  if (patch.method !== undefined) {
    sets.push("method = ?");
    args.push(patch.method);
  }
  if (patch.expectedStatus !== undefined) {
    sets.push("expectedStatus = ?");
    args.push(patch.expectedStatus);
  }
  if (patch.timeoutMs !== undefined) {
    sets.push("timeoutMs = ?");
    args.push(patch.timeoutMs);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  args.push(id);
  try {
    const r = d
      .prepare(`UPDATE monitored_apis SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/** Remove an API monitor from config. Its check history is intentionally kept. */
export function deleteApi(id: string): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d.prepare(`DELETE FROM monitored_apis WHERE id = ?`).run(id);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/* ------------------------------ devices ----------------------------- */

type DeviceRow = {
  id: string;
  name: string;
  host: string;
  type: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

function deviceFromRow(r: DeviceRow): MonitoredDevice {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    type: deviceTypeOf(r.type),
    enabled: !!r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** All configured devices (enabled or not). null => DB unavailable. */
export function listDevices(): MonitoredDevice[] | null {
  const d = getDb();
  if (!d) return null;
  try {
    const rows = d
      .prepare(
        `SELECT id, name, host, type, enabled, createdAt, updatedAt
           FROM monitored_devices ORDER BY createdAt ASC, id ASC`,
      )
      .all() as unknown as DeviceRow[];
    return rows.map(deviceFromRow);
  } catch {
    return null;
  }
}

/**
 * Store a device. `host` must already be normalized by the caller (validation
 * runs in the service layer); a duplicate host is refused by the unique index
 * rather than silently creating a second monitor for the same machine.
 */
export function insertDevice(input: {
  name: string;
  host: string;
  type: DeviceType;
}): MonitoredDevice | null {
  const d = getDb();
  if (!d) return null;
  const now = Date.now();
  const id = randomUUID();
  const name = input.name.trim();
  const host = input.host.trim();
  try {
    d.prepare(
      `INSERT INTO monitored_devices
         (id, name, host, type, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, name, host, input.type, now, now);
    return deviceFromRow({
      id,
      name,
      host,
      type: input.type,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return null;
  }
}

/** Update any subset of a device's fields. */
export function updateDevice(
  id: string,
  patch: {
    name?: string;
    host?: string;
    type?: DeviceType;
    enabled?: boolean;
  },
): boolean {
  const d = getDb();
  if (!d) return false;
  const now = Date.now();
  const sets: string[] = ["updatedAt = ?"];
  const args: (string | number | null)[] = [now];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name.trim());
  }
  if (patch.host !== undefined) {
    sets.push("host = ?");
    args.push(patch.host.trim());
  }
  if (patch.type !== undefined) {
    sets.push("type = ?");
    args.push(patch.type);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  args.push(id);
  try {
    const r = d
      .prepare(`UPDATE monitored_devices SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/** Remove a device from config. Its reachability history is intentionally kept. */
export function deleteDevice(id: string): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d.prepare(`DELETE FROM monitored_devices WHERE id = ?`).run(id);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

function readJsonSetting(key: string): unknown {
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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
  const d = getDb();
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

/* ------------------------------------------------------------------ *
 * Notification preferences
 *
 * Same `app_settings` key/value area as the alert thresholds — no new store, no
 * new table. Only three scalars live here: there is no per-rule or per-project
 * notification configuration in V1.
 * ------------------------------------------------------------------ */

/**
 * Persisted notification preferences, or null when unset / DB unavailable. A
 * partially-written or hand-edited value degrades to null (the conservative
 * defaults) rather than being trusted field by field.
 */
export function readNotificationSettings(): NotificationSettings | null {
  const v = readJsonSetting("notifications.prefs");
  if (!v || typeof v !== "object") return null;
  const n = v as Partial<NotificationSettings>;
  if (typeof n.enabled !== "boolean" || typeof n.desktop !== "boolean") return null;
  if (
    !(NOTIFICATION_MIN_SEVERITIES as readonly string[]).includes(n.minSeverity as string)
  ) {
    return null;
  }
  return {
    enabled: n.enabled,
    desktop: n.desktop,
    minSeverity: n.minSeverity as NotificationMinSeverity,
  };
}

export function writeNotificationSettings(s: NotificationSettings): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES ('notifications.prefs', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(s));
    return Number(r.changes) >= 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Overview layout
 *
 * One more JSON value in the same `app_settings` area — no new table, so an
 * install that never customizes the dashboard reads as "unset" and simply gets
 * the default. The shape is deliberately not validated here: it is owned by
 * lib/dashboard/model, which normalizes whatever comes back (including a
 * hand-edited or stale value) into something safe to render.
 * ------------------------------------------------------------------ */

/** The stored Overview layout, or null when unset / DB unavailable. */
export function readDashboardLayoutValue(): unknown {
  return readJsonSetting("dashboard.layout");
}

export function writeDashboardLayoutValue(value: unknown): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES ('dashboard.layout', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(value));
    return Number(r.changes) >= 0;
  } catch {
    return false;
  }
}
