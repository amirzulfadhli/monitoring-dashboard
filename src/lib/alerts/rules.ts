/**
 * Deterministic rule evaluation. Each function takes only plain observations
 * (numbers / states already collected by DevPulse's existing monitors) and the
 * central config, and returns verdicts. No AI, no heuristics, no network here —
 * pure logic that the engine feeds real data into and tests feed fixtures into.
 */
import { RULES, type AlertSource, type RuleId, type RuleVerdict, type Severity } from "./model";

/* ----------------------------- helpers ----------------------------- */

function mk(
  source: AlertSource,
  ruleId: RuleId,
  fingerprint: string,
  severity: Severity,
  title: string,
  message: string,
  active: boolean,
  metadata?: Record<string, string | number | null>,
): RuleVerdict {
  return { fingerprint, source, ruleId, severity, title, message, active, metadata };
}

/**
 * Sustained-condition guard. Given newest-first non-null values, the condition
 * only fires when the newest `minSamples` all pass the threshold — a single
 * brief sample (or sparse data) never triggers. Returns the newest value (for
 * choosing severity) or null when not fired.
 */
function sustained(
  valuesDesc: number[],
  threshold: number,
  minSamples: number,
): number | null {
  const newest = valuesDesc.slice(0, minSamples);
  if (newest.length < minSamples) return null;
  return newest.every((v) => v >= threshold) ? newest[0] : null;
}

const pct = (v: number) => `${Math.round(v)}%`;

/* ------------------------------ system ------------------------------ */

export type SystemSample = {
  ts: number;
  cpuPct: number | null;
  usedMem: number | null; // bytes
  availMem: number | null; // bytes
};

type SystemCfg = {
  cpuWarnPct: number;
  cpuCritPct: number;
  memWarnPct: number;
  memCritPct: number;
  minSamples: number;
};

export function evaluateSystem(
  samples: SystemSample[], // oldest first, as persisted
  cfg: SystemCfg,
): RuleVerdict[] {
  const desc = [...samples].reverse(); // newest first

  const cpuDesc = desc
    .filter((s) => s.cpuPct != null)
    .map((s) => s.cpuPct as number);
  const cpu = sustained(cpuDesc, cfg.cpuWarnPct, cfg.minSamples);
  const cpuSeverity: Severity =
    cpu != null && cpu >= cfg.cpuCritPct ? "critical" : "warning";

  const memDesc = desc
    .filter((s) => s.usedMem != null && s.availMem != null && s.usedMem + s.availMem > 0)
    .map((s) => ((s.usedMem as number) / ((s.usedMem as number) + (s.availMem as number))) * 100);
  const mem = sustained(memDesc, cfg.memWarnPct, cfg.minSamples);
  const memSeverity: Severity =
    mem != null && mem >= cfg.memCritPct ? "critical" : "warning";

  return [
    mk(
      "system",
      RULES.CPU_HIGH,
      "system:cpu_high",
      cpuSeverity,
      "CPU usage high",
      cpu != null
        ? `CPU is at ${pct(cpu)} — above the ${pct(cfg.cpuWarnPct)} warning threshold.`
        : `CPU back under ${pct(cfg.cpuWarnPct)}.`,
      cpu != null,
      cpu != null ? { pct: Math.round(cpu) } : undefined,
    ),
    mk(
      "system",
      RULES.MEMORY_HIGH,
      "system:memory_high",
      memSeverity,
      "Memory usage high",
      mem != null
        ? `Memory is at ${pct(mem)} — above the ${pct(cfg.memWarnPct)} warning threshold.`
        : `Memory back under ${pct(cfg.memWarnPct)}.`,
      mem != null,
      mem != null ? { pct: Math.round(mem) } : undefined,
    ),
  ];
}

/* ----------------------------- websites ----------------------------- */

export type WebsiteObs = {
  targetId: string;
  name: string;
  state: "healthy" | "degraded" | "down";
  latencyMs: number | null;
};

export function evaluateWebsites(targets: WebsiteObs[]): RuleVerdict[] {
  const out: RuleVerdict[] = [];
  for (const t of targets) {
    const down = t.state === "down";
    const degraded = t.state === "degraded";
    out.push(
      mk(
        "websites",
        RULES.WEBSITE_DOWN,
        `websites:down:${t.targetId}`,
        "critical",
        "Website down",
        down ? `${t.name} is unreachable or returning an error.` : `${t.name} is back up.`,
        down,
        { site: t.name },
      ),
    );
    out.push(
      mk(
        "websites",
        RULES.WEBSITE_DEGRADED,
        `websites:degraded:${t.targetId}`,
        "warning",
        "Website degraded",
        degraded
          ? `${t.name} is responding slowly${t.latencyMs != null ? ` (${Math.round(t.latencyMs)}ms)` : ""}.`
          : `${t.name} is responding normally.`,
        degraded,
        { site: t.name, latencyMs: t.latencyMs != null ? Math.round(t.latencyMs) : null },
      ),
    );
  }
  return out;
}

/* -------------------------------- apis -------------------------------- */

export type ApiObs = {
  targetId: string;
  name: string;
  state: "healthy" | "degraded" | "down";
  latencyMs: number | null;
};

/**
 * One rule per endpoint: an API endpoint is either failing (unexpected status,
 * timeout, network/DNS error — all of which the monitor records as "down") or it
 * is not. Deliberately no degraded-latency rule, matching websites: latency
 * alone is reported on the APIs page, never alerted on.
 */
export function evaluateApis(targets: ApiObs[]): RuleVerdict[] {
  const out: RuleVerdict[] = [];
  for (const t of targets) {
    const down = t.state === "down";
    out.push(
      mk(
        "apis",
        RULES.API_DOWN,
        `apis:down:${t.targetId}`,
        "critical",
        "API endpoint down",
        down
          ? `${t.name} is failing — unexpected status, timeout or unreachable.`
          : `${t.name} is responding as expected.`,
        down,
        { api: t.name },
      ),
    );
  }
  return out;
}

/* ------------------------------ github ------------------------------ */

export type GithubObs = {
  key: string; // owner/repo
  name: string; // display name
  state: "healthy" | "attention" | "running" | "unavailable";
  workflowName?: string | null;
};

export function evaluateGithub(repos: GithubObs[]): RuleVerdict[] {
  const out: RuleVerdict[] = [];
  for (const r of repos) {
    // A repo reaching "attention" is the monitor's own terminal-signal for an
    // unsuccessful workflow conclusion. Unavailable/running/healthy are not
    // failures to alert on — in particular we never invent a failure when the
    // GitHub source itself is down (unavailable).
    const failed = r.state === "attention";
    out.push(
      mk(
        "github",
        RULES.WORKFLOW_FAILED,
        `github:workflow_failed:${r.key}`,
        "warning",
        "Workflow failed",
        failed
          ? `${r.name} latest workflow run did not succeed${r.workflowName ? ` (${r.workflowName})` : ""}.`
          : `${r.name} latest workflow run is not failing.`,
        failed,
        { repo: r.key },
      ),
    );
  }
  return out;
}

/* -------------------------------- ai -------------------------------- */

export type AiObs = {
  totalTokens: number; // claude-code + direct, trailing 24h
  costUsd: number | null; // null when it cannot be estimated
};

type AiCfg = {
  tokenBudget24h: number | null;
  costBudget24hUsd: number | null;
};

export function evaluateAi(o: AiObs, cfg: AiCfg): RuleVerdict[] {
  const tokenBudget = cfg.tokenBudget24h;
  const tokensOver = tokenBudget != null && o.totalTokens > tokenBudget;
  const costBudget = cfg.costBudget24hUsd;
  // Cost rule only ever fires when both a budget is configured AND a cost could
  // be estimated; otherwise it stays disabled.
  const costOver = costBudget != null && o.costUsd != null && o.costUsd > costBudget;

  return [
    mk(
      "ai",
      RULES.AI_TOKEN_BUDGET,
      "ai:token_budget",
      "warning",
      "AI token budget exceeded",
      tokensOver
        ? `${o.totalTokens.toLocaleString()} tokens in 24h — above the ${tokenBudget!.toLocaleString()} budget.`
        : `AI token usage within the 24h budget.`,
      tokensOver,
      { totalTokens: o.totalTokens },
    ),
    mk(
      "ai",
      RULES.AI_COST_BUDGET,
      "ai:cost_budget",
      "warning",
      "AI cost budget exceeded",
      costOver
        ? `Estimated DeepSeek cost $${o.costUsd!.toFixed(3)} in 24h — above the $${costBudget!.toFixed(3)} budget.`
        : `Estimated AI cost within the 24h budget.`,
      costOver,
      o.costUsd != null ? { costUsd: Number(o.costUsd.toFixed(4)) } : undefined,
    ),
  ];
}
