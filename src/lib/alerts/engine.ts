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
 * from the usage table, and GitHub from its persisted snapshots (no live fetch).
 */
import { DAY_MS, alertConfig } from "./config";
import { readAlerts, readCounts, applyVerdict } from "./storage";
import { readSystemSamples } from "@/lib/telemetry/storage";
import { readLatestWebsiteChecks } from "@/lib/monitoring/storage";
import { monitoredSites } from "@/data/monitored-sites";
import { readLatestGithubSnapshots } from "@/lib/monitoring/github-snapshots";
import { readAiUsage } from "@/lib/monitoring/ai-storage";
import {
  evaluateSystem,
  evaluateWebsites,
  evaluateGithub,
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
  // ---- system (persisted history; no collector, no OS call) ----
  try {
    const samples = readSystemSamples(alertConfig.system.lookbackMs);
    for (const v of evaluateSystem(samples, alertConfig.system)) applyVerdict(v, at);
  } catch {
    // System source failure must not break the others.
  }

  // ---- websites (persisted latest checks; no duplicate fetch) ----
  try {
    const nameOf = new Map(monitoredSites.map((s) => [s.id, s.name]));
    const checks = readLatestWebsiteChecks();
    const obs = checks.map((c) => ({
      targetId: c.targetId,
      name: nameOf.get(c.targetId) ?? c.targetId,
      state: c.state,
      latencyMs: c.latencyMs,
    }));
    for (const v of evaluateWebsites(obs)) applyVerdict(v, at);
  } catch {
    // Website source failure is isolated.
  }

  // ---- github (evaluate from the latest persisted snapshot; no live fetch) ----
  try {
    // If no GitHub snapshot has been recorded yet, evaluation is simply
    // unavailable: an empty observation list yields no verdicts, so nothing is
    // fabricated into a healthy or failed state.
    const obs = readLatestGithubSnapshots().map((s) => ({
      key: s.repoKey,
      name: s.displayName,
      state: s.state,
      workflowName: s.workflowName,
    }));
    for (const v of evaluateGithub(obs)) applyVerdict(v, at);
  } catch {
    // GitHub source failure is isolated; no failure alert is invented here.
  }

  // ---- ai usage (persisted usage table) ----
  try {
    const usage = readAiUsage(DAY_MS);
    for (const v of evaluateAi({ totalTokens: usage.totalTokens, costUsd: usage.estimatedCostUsd }, alertConfig.ai))
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
      return alertConfig.ai.tokenBudget24h != null;
    case "ai_cost_budget":
      return alertConfig.ai.costBudget24hUsd != null;
    default:
      return true;
  }
}

/** Exposed for isolated tests / tooling that drives transitions directly. */
export { applyVerdict };
