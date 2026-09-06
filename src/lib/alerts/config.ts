/**
 * All alert thresholds in one clearly editable place. Nothing about a rule's
 * behavior is hard-coded elsewhere — a rule that should change is edited here.
 *
 * AI budgets are deliberately NOT set: this engine must never invent a personal
 * spending limit. Leaving a budget `null` disables that rule.
 */

export const DAY_MS = 86_400_000;

export const alertConfig = {
  system: {
    // Warning at/above these; Critical at/above cpuCritPct.
    cpuWarnPct: 85,
    cpuCritPct: 95,
    memWarnPct: 85,
    memCritPct: 95,
    // Consecutive persisted samples (each ~30s) required before the condition
    // fires, so one extremely brief sample never triggers an alert.
    minSamples: 2,
    // How far back to read persisted history for system rules.
    lookbackMs: 5 * 60 * 1000,
  },
  ai: {
    // Claude Code + direct DeepSeek total tokens in the trailing 24h.
    // null => rule disabled.
    tokenBudget24h: null as number | null,
    // Estimated DeepSeek cost (USD) in the trailing 24h. null => disabled.
    costBudget24hUsd: null as number | null,
  },
};
