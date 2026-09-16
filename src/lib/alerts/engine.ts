/**
 * Alert engine: gathers the real monitoring signals DevPulse already collects,
 * feeds them through the deterministic rules, and persists the transitions.
 *
 *   monitoring signals  →  alert rules  →  alert persistence
 *
 * Nothing here decides an alert with AI — every verdict is a pure function of
 * observed numbers/states (see rules.ts). Each source is isolated so a failure
 * in one (e.g. GitHub) can never break evaluation of the others. No new
 * collectors are introduced and no duplicate external calls are made just to
 * evaluate alerts: websites and system come from persisted DB rows, AI usage
 * from the usage table, GitHub from its persisted snapshots, and local security
 * from its persisted snapshots (no live fetch, no PowerShell run).
 */
import { alertConfig, DAY_MS } from "./config";
import {
  getAiSettings,
  getEnabledApis,
  getEnabledDevices,
  getEnabledSites,
  getEnabledRepos,
  getSystemSettings,
} from "@/lib/settings/service";
import { readAlerts, readCounts, applyVerdict } from "./storage";
import { readSystemSamples } from "@/lib/telemetry/storage";
import { readLatestWebsiteChecks } from "@/lib/monitoring/storage";
import { readLatestApiChecks } from "@/lib/monitoring/api-storage";
import { readLatestDeviceChecks } from "@/lib/devices/storage";
import { readLatestGithubSnapshots } from "@/lib/monitoring/github-snapshots";
import { readAiUsage } from "@/lib/monitoring/ai-storage";
import {
  defenderAvailableBefore,
  readLatestSecuritySnapshot,
} from "@/lib/security/storage";
import {
  evaluateSystem,
  evaluateWebsites,
  evaluateApis,
  evaluateDevices,
  evaluateGithub,
  evaluateSecurity,
  evaluateAi,
} from "./rules";
import type { AlertCounts } from "./model";

/**
 * Modest evaluation cadence. Alerts are evaluated (and persisted) at most once
 * per interval when the API is requested — no background loop, no per-second
 * churn. Between intervals we simply serve the stored state.
 */
const EVAL_INTERVAL_MS = 30_000;

let lastEvalAt = 0;

function now() {
  return Date.now();
}

/** Evaluate every source once, applying verdicts. Failure-isolated per source. */
async function runEvaluation(at: number): Promise<void> {
  // Thresholds / budgets are read fresh each evaluation from persisted settings
  // (safe defaults when the settings DB is unavailable) so edits apply without a
  // server restart. minSamples & lookback come back inside system.
  const system = getSystemSettings();

  // ---- system (persisted history; no collector, no OS call) ----
  try {
    const samples = readSystemSamples(system.lookbackMs);
    for (const v of evaluateSystem(samples, system)) applyVerdict(v, at);
  } catch {
    // System source failure must not break the others.
  }

  // ---- websites (persisted latest checks; no duplicate fetch) ----
  try {
    // Only currently-enabled targets are evaluated: removing a site from
    // Settings stops its future checks, and stale "down" history must not keep
    // raising an alert for a site that is no longer monitored.
    const enabled = getEnabledSites();
    const enabledIds = new Set(enabled.map((s) => s.id));
    const nameOf = new Map(enabled.map((s) => [s.id, s.name]));
    const checks = readLatestWebsiteChecks();
    const obs = checks
      .filter((c) => enabledIds.has(c.targetId))
      .map((c) => ({
        targetId: c.targetId,
        name: nameOf.get(c.targetId) ?? c.targetId,
        state: c.state,
        latencyMs: c.latencyMs,
      }));
    for (const v of evaluateWebsites(obs)) applyVerdict(v, at);
  } catch {
    // Website source failure is isolated.
  }

  // ---- api endpoints (persisted latest checks; no duplicate request) ----
  try {
    // Same rule as websites: only currently-enabled monitors are evaluated, so
    // disabling one stops its alerts without deleting its history.
    const enabled = getEnabledApis();
    const enabledIds = new Set(enabled.map((a) => a.id));
    const nameOf = new Map(enabled.map((a) => [a.id, a.name]));
    const obs = readLatestApiChecks()
      .filter((c) => enabledIds.has(c.targetId))
      .map((c) => ({
        targetId: c.targetId,
        name: nameOf.get(c.targetId) ?? c.targetId,
        state: c.state,
        latencyMs: c.latencyMs,
      }));
    for (const v of evaluateApis(obs)) applyVerdict(v, at);
  } catch {
    // API source failure is isolated.
  }

  // ---- devices (persisted reachability checks; no ping of its own) ----
  try {
    // Same rule as the other monitors: only currently-enabled devices are
    // evaluated, so disabling one stops its alerts without deleting history.
    // Alert evaluation reads stored rows, so raising a device alert costs no
    // network traffic at all.
    const enabled = getEnabledDevices();
    const enabledIds = new Set(enabled.map((d) => d.id));
    const nameOf = new Map(enabled.map((d) => [d.id, d.name]));
    const hostOf = new Map(enabled.map((d) => [d.id, d.host]));
    const obs = readLatestDeviceChecks(at - alertConfig.devices.historyMs)
      .filter((c) => enabledIds.has(c.deviceId))
      // A check older than the lookback window is not evidence that a device is
      // unreachable *now*, so it is not evaluated.
      .filter((c) => at - c.ts <= alertConfig.devices.lookbackMs)
      .map((c) => ({
        deviceId: c.deviceId,
        name: nameOf.get(c.deviceId) ?? c.deviceId,
        host: hostOf.get(c.deviceId) ?? "unknown host",
        consecutiveUnreachable: c.consecutiveUnreachable,
        lastCheckedAt: c.ts,
      }));
    for (const v of evaluateDevices(obs, alertConfig.devices)) applyVerdict(v, at);
  } catch {
    // Device source failure is isolated; no alert is fabricated from it.
  }

  // ---- github (evaluate from the latest persisted snapshot; no live fetch) ----
  try {
    // If no GitHub snapshot has been recorded yet, evaluation is simply
    // unavailable: an empty observation list yields no verdicts, so nothing is
    // fabricated into a healthy or failed state. Disabled/removed repositories
    // are excluded so they stop producing alerts.
    const enabled = new Set(getEnabledRepos().map((r) => `${r.owner}/${r.repo}`));
    const obs = readLatestGithubSnapshots()
      .filter((s) => enabled.has(s.repoKey))
      .map((s) => ({
        key: s.repoKey,
        name: s.displayName,
        state: s.state,
        workflowName: s.workflowName,
      }));
    for (const v of evaluateGithub(obs)) applyVerdict(v, at);
  } catch {
    // GitHub source failure is isolated; no failure alert is invented here.
  }

  // ---- local security (latest persisted snapshot; no live collection) ----
  try {
    // Same principle as the sources above: alert evaluation reads stored state
    // and never runs a collector of its own, so raising a security alert costs
    // no PowerShell process. A snapshot that is missing or older than the
    // configured age yields no verdicts — nothing is fabricated from stale or
    // absent observations.
    const snapshot = readLatestSecuritySnapshot();
    if (
      snapshot &&
      at - snapshot.collectedAt <= alertConfig.security.maxSnapshotAgeMs
    ) {
      const obs = {
        firewall: {
          available: snapshot.firewall.available,
          profiles: snapshot.firewall.profiles,
        },
        defender: snapshot.defender,
        defenderPreviouslyAvailable: defenderAvailableBefore(
          snapshot.collectedAt,
          at - alertConfig.security.defenderLookbackMs,
        ),
      };
      for (const v of evaluateSecurity(obs)) applyVerdict(v, at);
    }
  } catch {
    // Security source failure is isolated.
  }

  // ---- ai usage (persisted usage table) ----
  try {
    const ai = getAiSettings();
    const usage = readAiUsage(DAY_MS);
    for (const v of evaluateAi({ totalTokens: usage.totalTokens, costUsd: usage.estimatedCostUsd }, ai))
      applyVerdict(v, at);
  } catch {
    // AI usage failure is isolated.
  }
}

/**
 * Evaluate if the interval has elapsed since the last run, then return the
 * fresh summary counts. Idempotent between intervals. Never throws.
 */
export async function evaluateAlerts(): Promise<AlertCounts> {
  const at = now();
  try {
    if (at - lastEvalAt >= EVAL_INTERVAL_MS) {
      await runEvaluation(at);
      lastEvalAt = at;
    }
  } catch {
    // Evaluation failure degrades to serving stored state.
  }
  return readCounts(now());
}

/** Support filtered reads without forcing a fresh evaluation. */
export function listAlerts(status: "active" | "resolved" | "all") {
  return readAlerts(status);
}

/** True when a rule is currently enabled by configuration. */
export function ruleEnabled(ruleId: string): boolean {
  switch (ruleId) {
    case "ai_token_budget":
      return getAiSettings().tokenBudget24h != null;
    case "ai_cost_budget":
      return getAiSettings().costBudget24hUsd != null;
    default:
      return true;
  }
}

/** Exposed for isolated tests / tooling that drives transitions directly. */
export { applyVerdict };
