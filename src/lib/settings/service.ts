/**
 * Business layer over the settings store. Everything else (monitors, the alert
 * engine, the History timeline, the Settings API) reads configuration through
 * this module, so there is exactly one source of truth: SQLite, seeded once from
 * the old source arrays. When the settings DB is unavailable these accessors
 * degrade to the historical defaults so monitoring and alerts keep working.
 */

import { monitoredSites, type MonitoredSite } from "@/data/monitored-sites";
import { monitoredRepos, type MonitoredRepo } from "@/data/monitored-repos";
import { alertConfig } from "@/lib/alerts/config";
import type { ApiTarget } from "@/lib/monitoring/apis";

import { deviceTypeOf, type MonitorableDevice } from "@/lib/devices/model";

import {
  deleteApi,
  deleteDevice,
  deleteRepository,
  deleteWebsite,
  ensureSeeded,
  insertApi,
  insertDevice,
  insertRepository,
  insertWebsite,
  listApis,
  listDevices,
  listRepositories,
  listWebsites,
  readAiBudgets,
  readSystemThresholds,
  updateApi,
  updateDevice,
  updateRepository,
  updateWebsite,
  writeAiBudgets,
  writeSystemThresholds,
} from "./storage";
import type {
  AiAlertSettings,
  AlertSettings,
  ApiMethod,
  MonitoredApi,
  MonitoredDevice,
  MonitoredRepository,
  MonitoredWebsite,
  SettingsBundle,
  SystemAlertSettings,
} from "./types";
import {
  normalizeDeviceHost,
  validateAlertInput,
  validateApiFields,
  validateDeviceFields,
  validateOwnerRepo,
  validateWebsiteFields,
} from "./validate";

/** Make sure first-run seeding has happened before any read. */
export function ensureSettingsSeeded(): void {
  ensureSeeded();
}

/* ------------------------------------------------------------------ *
 * Providers for monitors / alert engine / history
 * ------------------------------------------------------------------ */

function toMonitorSite(w: MonitoredWebsite): MonitoredSite {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    ...(w.expectedStatus != null ? { expectedStatus: w.expectedStatus } : {}),
  };
}

/**
 * Enabled websites to monitor. On DB failure falls back to the source-seeded
 * list so monitoring does not silently stop. An available-but-empty store
 * returns [] (the user genuinely removed all targets).
 */
export function getEnabledSites(): MonitoredSite[] {
  ensureSeeded();
  const all = listWebsites();
  if (all === null) return monitoredSites.map((s) => ({ ...s }));
  return all.filter((w) => w.enabled).map(toMonitorSite);
}

function toApiTarget(a: MonitoredApi): ApiTarget {
  return {
    id: a.id,
    name: a.name,
    url: a.url,
    method: a.method,
    ...(a.expectedStatus != null ? { expectedStatus: a.expectedStatus } : {}),
    ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}),
  };
}

/**
 * Enabled API endpoints to monitor. There is no source-seeded fallback list for
 * APIs, so an unavailable DB yields [] (nothing is checked) rather than
 * inventing targets; an available-but-empty store means the same thing.
 */
export function getEnabledApis(): ApiTarget[] {
  ensureSeeded();
  return (listApis() ?? []).filter((a) => a.enabled).map(toApiTarget);
}

function toMonitorRepo(r: MonitoredRepository): MonitoredRepo {
  return { owner: r.owner, repo: r.repo, displayName: r.displayName };
}

/** Enabled repositories to monitor (DB-failure fallback mirrors getEnabledSites). */
export function getEnabledRepos(): MonitoredRepo[] {
  ensureSeeded();
  const all = listRepositories();
  if (all === null) return monitoredRepos.map((r) => ({ ...r }));
  return all.filter((r) => r.enabled).map(toMonitorRepo);
}

function toMonitorableDevice(d: MonitoredDevice): MonitorableDevice {
  return { id: d.id, name: d.name, host: d.host, type: d.type };
}

/**
 * Enabled devices to check. There is no source-seeded fallback list for devices
 * (nothing is monitored until the user configures it), so an unavailable DB
 * yields [] rather than inventing targets — the devices collector job is
 * inactive in that case rather than reporting an empty, successful run.
 */
export function getEnabledDevices(): MonitorableDevice[] {
  ensureSeeded();
  return (listDevices() ?? []).filter((d) => d.enabled).map(toMonitorableDevice);
}

/**
 * Effective CPU/memory alert settings: persisted thresholds when present,
 * otherwise the historical source defaults. The consecutive-sample guard and
 * lookback stay engine constants (not surfaced as settings).
 */
export function getSystemSettings(): {
  cpuWarnPct: number;
  cpuCritPct: number;
  memWarnPct: number;
  memCritPct: number;
  minSamples: number;
  lookbackMs: number;
} {
  ensureSeeded();
  const t = readSystemThresholds() ?? alertConfig.system;
  return {
    cpuWarnPct: t.cpuWarnPct,
    cpuCritPct: t.cpuCritPct,
    memWarnPct: t.memWarnPct,
    memCritPct: t.memCritPct,
    minSamples: alertConfig.system.minSamples,
    lookbackMs: alertConfig.system.lookbackMs,
  };
}

/** Effective AI budgets (null => disabled). Disabled when unreadable. */
export function getAiSettings(): AiAlertSettings {
  ensureSeeded();
  return (
    readAiBudgets() ?? {
      tokenBudget24h: alertConfig.ai.tokenBudget24h,
      costBudget24hUsd: alertConfig.ai.costBudget24hUsd,
    }
  );
}

/* ------------------------------------------------------------------ *
 * Settings API helpers
 * ------------------------------------------------------------------ */

const configured = (key: string) => !!process.env[key];

/** Full bundle for the Settings page. Never includes secret values. */
export function getSettingsBundle(): SettingsBundle {
  ensureSettingsSeeded();
  return {
    websites: listWebsites() ?? [],
    apis: listApis() ?? [],
    repositories: listRepositories() ?? [],
    devices: listDevices() ?? [],
    alerts: { system: getSystemSettings(), ai: getAiSettings() },
    integrations: {
      github: configured("GITHUB_TOKEN"),
      deepseek: configured("DEEPSEEK_API_KEY"),
    },
  };
}

export type MutateResult = { ok: true } | { ok: false; error: string };

function fail(error: string): MutateResult {
  return { ok: false, error };
}

export async function createWebsite(input: {
  name: string;
  url: string;
  expectedStatus?: number | null;
}): Promise<MutateResult> {
  const err = await validateWebsiteFields({
    name: input.name,
    url: input.url,
    expectedStatus: input.expectedStatus ?? null,
  });
  if (err) return fail(err);
  const created = insertWebsite({
    name: input.name,
    url: input.url,
    expectedStatus: input.expectedStatus ?? null,
  });
  return created ? { ok: true } : fail("Could not save the website.");
}

export async function updateWebsiteFields(
  id: string,
  patch: {
    name?: string;
    url?: string;
    expectedStatus?: number | null;
    enabled?: boolean;
  },
): Promise<MutateResult> {
  // Only validate when identity fields change — an enable/disable toggle must
  // not require re-validating untouched (already-valid) fields.
  if (
    patch.name !== undefined ||
    patch.url !== undefined ||
    patch.expectedStatus !== undefined
  ) {
    const all = listWebsites();
    const current = all?.find((w) => w.id === id);
    if (!current) return fail("Website not found.");
    const err = await validateWebsiteFields({
      name: patch.name ?? current.name,
      url: patch.url ?? current.url,
      expectedStatus: patch.expectedStatus !== undefined
        ? patch.expectedStatus
        : current.expectedStatus,
    });
    if (err) return fail(err);
  }
  if (!updateWebsite(id, patch)) return fail("Could not update the website.");
  return { ok: true };
}

export function removeWebsite(id: string): MutateResult {
  return deleteWebsite(id) ? { ok: true } : fail("Could not remove the website.");
}

/* ------------------------------- API monitors ------------------------------ */

export async function createApi(input: {
  name: string;
  url: string;
  method: string;
  expectedStatus?: number | null;
  timeoutMs?: number | null;
}): Promise<MutateResult> {
  const err = await validateApiFields({
    name: input.name,
    url: input.url,
    method: input.method,
    expectedStatus: input.expectedStatus ?? null,
    timeoutMs: input.timeoutMs ?? null,
  });
  if (err) return fail(err);
  const created = insertApi({
    name: input.name,
    url: input.url,
    method: input.method.toUpperCase() as ApiMethod,
    expectedStatus: input.expectedStatus ?? null,
    timeoutMs: input.timeoutMs ?? null,
  });
  return created ? { ok: true } : fail("Could not save the API monitor.");
}

export async function updateApiFields(
  id: string,
  patch: {
    name?: string;
    url?: string;
    method?: string;
    expectedStatus?: number | null;
    timeoutMs?: number | null;
    enabled?: boolean;
  },
): Promise<MutateResult> {
  // As with websites: only identity fields are re-validated, so an
  // enable/disable toggle never re-runs URL validation (and its DNS lookup).
  const identityChanged =
    patch.name !== undefined ||
    patch.url !== undefined ||
    patch.method !== undefined ||
    patch.expectedStatus !== undefined ||
    patch.timeoutMs !== undefined;
  if (identityChanged) {
    const current = (listApis() ?? []).find((a) => a.id === id);
    if (!current) return fail("API monitor not found.");
    const err = await validateApiFields({
      name: patch.name ?? current.name,
      url: patch.url ?? current.url,
      method: patch.method ?? current.method,
      expectedStatus:
        patch.expectedStatus !== undefined ? patch.expectedStatus : current.expectedStatus,
      timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs,
    });
    if (err) return fail(err);
  }
  const stored: Parameters<typeof updateApi>[1] = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.method !== undefined
      ? { method: patch.method.toUpperCase() as ApiMethod }
      : {}),
    ...(patch.expectedStatus !== undefined ? { expectedStatus: patch.expectedStatus } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  if (!updateApi(id, stored)) return fail("Could not update the API monitor.");
  return { ok: true };
}

export function removeApi(id: string): MutateResult {
  return deleteApi(id) ? { ok: true } : fail("Could not remove the API monitor.");
}

/* ------------------------------- devices ------------------------------- */

/**
 * Add a monitored device. The host is validated and normalized before storage,
 * so what the collector later receives is always a bare hostname or IP literal
 * — never a URL, a port, a path or anything a shell could read.
 */
export function createDevice(input: {
  name: string;
  host: string;
  type?: unknown;
}): MutateResult {
  const err = validateDeviceFields(input);
  if (err) return fail(err);
  const host = normalizeDeviceHost(input.host);
  if (!host) return fail("Host is not a valid hostname or IP address.");
  const created = insertDevice({
    name: input.name,
    host,
    type: deviceTypeOf(input.type),
  });
  return created
    ? { ok: true }
    : fail("Could not save the device (this host may already be monitored).");
}

export function updateDeviceFields(
  id: string,
  patch: {
    name?: string;
    host?: string;
    type?: unknown;
    enabled?: boolean;
  },
): MutateResult {
  // As with the other monitors, only identity fields are re-validated so an
  // enable/disable toggle never re-runs validation on untouched fields.
  const identityChanged =
    patch.name !== undefined || patch.host !== undefined || patch.type !== undefined;
  if (identityChanged) {
    const current = (listDevices() ?? []).find((d) => d.id === id);
    if (!current) return fail("Device not found.");
    const err = validateDeviceFields({
      name: patch.name ?? current.name,
      host: patch.host ?? current.host,
      type: patch.type !== undefined ? patch.type : current.type,
    });
    if (err) return fail(err);
  }

  const stored: Parameters<typeof updateDevice>[1] = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.host !== undefined
      ? { host: normalizeDeviceHost(patch.host) ?? patch.host }
      : {}),
    ...(patch.type !== undefined ? { type: deviceTypeOf(patch.type) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  if (!updateDevice(id, stored)) {
    return fail("Could not update the device (this host may already be monitored).");
  }
  return { ok: true };
}

export function removeDevice(id: string): MutateResult {
  return deleteDevice(id) ? { ok: true } : fail("Could not remove the device.");
}

export async function createRepository(input: {
  owner: string;
  repo: string;
  displayName: string;
}): Promise<MutateResult> {
  const err = validateOwnerRepo(input);
  if (err) return fail(err);
  const created = insertRepository(input);
  if (!created) return fail("Could not save the repository (it may already be monitored).");
  return { ok: true };
}

export async function updateRepositoryFields(
  id: string,
  patch: {
    owner?: string;
    repo?: string;
    displayName?: string;
    enabled?: boolean;
  },
): Promise<MutateResult> {
  if (
    patch.owner !== undefined ||
    patch.repo !== undefined ||
    patch.displayName !== undefined
  ) {
    const all = listRepositories();
    const current = all?.find((r) => r.id === id);
    if (!current) return fail("Repository not found.");
    const err = validateOwnerRepo({
      owner: patch.owner ?? current.owner,
      repo: patch.repo ?? current.repo,
      displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
    });
    if (err) return fail(err);
  }
  if (!updateRepository(id, patch)) return fail("Could not update the repository.");
  return { ok: true };
}

export function removeRepository(id: string): MutateResult {
  return deleteRepository(id) ? { ok: true } : fail("Could not remove the repository.");
}

/** Persist alert settings. Any omitted subsystem keeps its current value. */
export function saveAlertSettings(
  next: {
    system?: SystemAlertSettings;
    ai?: AiAlertSettings;
  },
): MutateResult {
  const current = getSettingsBundle().alerts;
  const system = next.system ?? current.system;
  const ai = next.ai ?? current.ai;
  const err = validateAlertInput({ system, ai });
  if (err) return fail(err);
  if (!writeSystemThresholds(system)) return fail("Could not save alert settings.");
  if (!writeAiBudgets(ai)) return fail("Could not save alert settings.");
  return { ok: true };
}

/** Shape of the persisted alerts the API exposes back after a save. */
export function readAlertSettings(): AlertSettings {
  return { system: getSystemSettings(), ai: getAiSettings() };
}
