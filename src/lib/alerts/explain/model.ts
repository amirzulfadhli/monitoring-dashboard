/**
 * "Explain this alert" — a grounded, DeepSeek-produced explanation of one
 * DevPulse alert based ONLY on nearby persisted evidence.
 *
 * Not a chatbot: the request names an existing alert (by fingerprint) and the
 * action is fixed — build a bounded evidence window around that alert's first
 * occurrence and explain it. No arbitrary prompt is accepted.
 *
 * Output is structured and validated (see validate.ts): a summary, an optional
 * likely cause, a confidence that must not overstate evidence, the evidence
 * events it cites (each must exist in what was supplied), and checks. Findings
 * and grounding are deliberately small and bounded for token + cost control.
 */

/** One bounded evidence event handed to the model (see select/evidence). */
export type ExplainEvidenceEvent = {
  id: string;
  ts: number; // epoch ms
  source: string;
  type: string;
  severity?: string | null;
  title: string;
  description: string;
};

/** A per-event citation the model makes back to the supplied evidence. */
export type ExplainEvidenceRef = {
  eventId: string;
  relevance: string;
};

export type ExplainConfidence = "low" | "medium" | "high";
export const EXPLAIN_CONFIDENCES: readonly ExplainConfidence[] = [
  "low",
  "medium",
  "high",
];

/** The validated, structured explanation returned to the browser. */
export type AlertExplanation = {
  summary: string;
  likelyCause: string | null;
  confidence: ExplainConfidence;
  evidence: ExplainEvidenceRef[];
  checks: string[];
};

/* ------------------------------------------------------------------ *
 * Tunables (single home for window, budgets, cache, bounds).
 * ------------------------------------------------------------------ */

/** Evidence window is this far before / after the alert's first occurrence. */
export const EXPLAIN_WINDOW_BEFORE_MS = 30 * 60 * 1000;
export const EXPLAIN_WINDOW_AFTER_MS = 30 * 60 * 1000;

/** Maximum evidence events handed to the model. */
export const EXPLAIN_MAX_EVIDENCE = 20;

/** Concise output cap for an explanation. */
export const EXPLAIN_MAX_OUTPUT_TOKENS = 500;

/** An explanation for an unchanged alert occurrence is reused inside this window. */
export const EXPLAIN_CACHE_TTL_MS = 20 * 60 * 1000; // ~15–30 min, pick 20

/** lastSeenAt coarseness folded into the cache version (material-change gate). */
export const EXPLAIN_VERSION_BUCKET_MS = 10 * 60 * 1000;

/** Result cardinality / string caps. */
export const EXPLAIN_MAX_ITEMS = 5; // evidence refs and checks
export const EXPLAIN_MAX_SUMMARY_LEN = 800;
export const EXPLAIN_MAX_CAUSE_LEN = 500;
export const EXPLAIN_MAX_RELEVANCE_LEN = 300;
export const EXPLAIN_MAX_CHECK_LEN = 300;
