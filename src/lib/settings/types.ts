/**
 * Canonical shapes for DevPulse's persisted monitoring configuration.
 *
 * These are the authoritative records stored in SQLite. Monitors, the alert
 * engine, the Settings UI and the History timeline all read from here — never
 * from the old hard-coded arrays (which now only feed first-run seeding and act
 * as a degraded fallback when the settings DB is unavailable).
 *
 * Secrets are deliberately absent: no API keys ever live in SQLite.
 */

export type MonitoredWebsite = {
  id: string;
  name: string;
  url: string;
  /** HTTP status that counts as Healthy. Null => the default (200). */
  expectedStatus: number | null;
  enabled: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
};

export type MonitoredRepository = {
  id: string;
  owner: string;
  repo: string;
  /** Human label shown in the UI; falls back to "owner/repo" when empty. */
  displayName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

/** CPU / memory thresholds. minSamples & lookback stay engine constants. */
export type SystemAlertSettings = {
  cpuWarnPct: number;
  cpuCritPct: number;
  memWarnPct: number;
  memCritPct: number;
};

/** Optional 24h AI budgets. null => that rule is disabled. */
export type AiAlertSettings = {
  tokenBudget24h: number | null;
  costBudget24hUsd: number | null;
};

export type AlertSettings = {
  system: SystemAlertSettings;
  ai: AiAlertSettings;
};

/** Full configuration bundle served to the Settings page. */
export type SettingsBundle = {
  websites: MonitoredWebsite[];
  repositories: MonitoredRepository[];
  alerts: AlertSettings;
  integrations: { github: boolean; deepseek: boolean };
};
