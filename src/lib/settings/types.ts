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

import type { DeviceType } from "@/lib/devices/model";
import type { NotificationSettings } from "@/lib/notifications/model";

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

/** HTTP methods an API monitor may use. No request bodies are ever sent. */
export const API_METHODS = ["GET", "HEAD", "POST"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export type MonitoredApi = {
  id: string;
  name: string;
  url: string;
  method: ApiMethod;
  /** HTTP status that counts as Healthy. Null => the default (200). */
  expectedStatus: number | null;
  /** Per-request timeout in ms. Null => the monitor default. */
  timeoutMs: number | null;
  enabled: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
};

/**
 * A monitored machine. Reachability only: there is no credential, port, path or
 * command here, and there never will be — device monitoring asks the network
 * whether a host answers and nothing more.
 */
export type MonitoredDevice = {
  id: string;
  name: string;
  /** Normalized hostname or IP literal. Never a URL, port or address range. */
  host: string;
  /** computer | server | iot | other */
  type: DeviceType;
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
  apis: MonitoredApi[];
  repositories: MonitoredRepository[];
  devices: MonitoredDevice[];
  alerts: AlertSettings;
  notifications: NotificationSettings;
  integrations: { github: boolean; deepseek: boolean };
};
