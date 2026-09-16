/**
 * Common alert representation. One shared shape flows from the evaluator
 * through storage to the API and UI, so every layer speaks the same language.
 * Kept deliberately small — metadata carries only strictly-useful extras.
 */

export type Severity = "info" | "warning" | "critical";
export type Status = "active" | "resolved";
export type AlertSource = "system" | "websites" | "apis" | "github" | "ai";

/** Centralized rule ids, referenced by evaluator + config + storage. */
export const RULES = {
  CPU_HIGH: "cpu_high",
  MEMORY_HIGH: "memory_high",
  WEBSITE_DEGRADED: "website_degraded",
  WEBSITE_DOWN: "website_down",
  API_DOWN: "api_down",
  WORKFLOW_FAILED: "workflow_failed",
  AI_TOKEN_BUDGET: "ai_token_budget",
  AI_COST_BUDGET: "ai_cost_budget",
} as const;
export type RuleId = (typeof RULES)[keyof typeof RULES];

/** A persisted alert row (also the shape served by the API). */
export type AlertRecord = {
  fingerprint: string; // stable identity: source:rule:subject
  source: AlertSource;
  ruleId: RuleId;
  severity: Severity;
  title: string;
  message: string;
  status: Status;
  firstSeenAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
  resolvedAt: number | null; // epoch ms; null while active
  metadata: Record<string, string | number | null>; // small extras only
};

/**
 * The evaluator's verdict for one alert instance: whether its condition is
 * present right now (active) and how to describe it. A healthy verdict for a
 * known fingerprint drives resolution; a fired verdict drives (re)activation.
 */
export type RuleVerdict = {
  fingerprint: string;
  source: AlertSource;
  ruleId: RuleId;
  severity: Severity;
  title: string;
  message: string;
  active: boolean;
  metadata?: Record<string, string | number | null>;
};

/** Summary counts returned by the API and used by the Overview indicator. */
export type AlertCounts = {
  active: number;
  critical: number; // currently-active, by severity
  warning: number;
  info: number;
  resolvedRecent: number; // resolved within the last 24h
};
