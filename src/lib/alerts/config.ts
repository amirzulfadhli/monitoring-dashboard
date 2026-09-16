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
  devices: {
    // Consecutive persisted checks that must all be unreachable before an alert
    // opens. One dropped echo request — or a single check landing while a
    // machine reboots — must never page anyone; three in a row (~3 minutes at
    // the collector cadence) is a machine that is actually gone.
    consecutiveFailures: 3,
    // How far back to read persisted device checks. A device whose newest check
    // is older than this is not evaluated at all: DevPulse cannot claim a device
    // is unreachable now based on an observation from days ago.
    lookbackMs: 10 * 60 * 1000,
    // How far back to look for checks at all when computing the streak. Wider
    // than lookbackMs so a slow cadence cannot make the streak unreadable.
    historyMs: DAY_MS,
  },
  security: {
    // A local security observation older than this is not evaluated at all: a
    // snapshot from days ago must not keep raising an alert for state that
    // nobody has verified since.
    maxSnapshotAgeMs: DAY_MS,
    // How far back to look for an earlier observation that reported Defender as
    // available. Inside this window, "available -> unavailable" is a
    // transition worth surfacing; a machine that never reported Defender at all
    // (a third-party antivirus) never fires the rule.
    defenderLookbackMs: 7 * DAY_MS,
  },
  ai: {
    // Claude Code + direct DeepSeek total tokens in the trailing 24h.
    // null => rule disabled.
    tokenBudget24h: null as number | null,
    // Estimated DeepSeek cost (USD) in the trailing 24h. null => disabled.
    costBudget24hUsd: null as number | null,
  },
};
