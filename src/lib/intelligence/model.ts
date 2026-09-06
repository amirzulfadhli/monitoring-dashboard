/**
 * DevPulse Intelligence (DeepSeek reasoning over local monitoring evidence).
 *
 * V1 exposes a single fixed action — "analyze the last 24 hours of DevPulse
 * evidence" — and returns a concise, structured, grounded operational brief.
 * This is deliberately NOT a chatbot: there is no arbitrary prompt, no
 * natural-language question handling, no tool-calling, no autonomous loop.
 *
 * The model only ever sees structured evidence events produced by the History
 * timeline builder. Every finding it makes MUST cite at least one of those
 * event ids, and the validator rejects output that invents causes or cites
 * unknown ids. Nothing sensitive (prompts, completions, bodies, workflow logs,
 * credentials) ever enters the evidence layer.
 */

/** Overall health judgement over the evidence window. */
export type AnalysisStatus = "normal" | "attention" | "critical";

/** Per-finding severity. */
export type FindingSeverity = "info" | "warning" | "critical";

export const ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  "normal",
  "attention",
  "critical",
];
export const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  "info",
  "warning",
  "critical",
];

export type Finding = {
  severity: FindingSeverity;
  title: string;
  explanation: string;
  /** Grounding: must be non-empty and every id must exist in the supplied evidence. */
  evidenceEventIds: string[];
};

/** The validated, normalized analysis produced by the model + validator. */
export type IntelligenceAnalysis = {
  status: AnalysisStatus;
  summary: string;
  findings: Finding[];
  recommendations: string[];
};

/* ------------------------------------------------------------------ *
 * V1 bounds & tunables (single editable home for the analysis window,
 * token budget, cache freshness and cardinality limits).
 * ------------------------------------------------------------------ */

export const ANALYSIS_WINDOW_HOURS = 24;
export const ANALYSIS_WINDOW_MS = ANALYSIS_WINDOW_HOURS * 60 * 60 * 1000;

/** Approximate upper bound on model output tokens for the operational brief. */
export const MAX_OUTPUT_TOKENS = 800;

/** Maximum evidence events sent to the model (keeps the prompt bounded). */
export const MAX_EVIDENCE_EVENTS = 50;

/** A successful analysis is reused (not re-computed) inside this freshness window. */
export const CACHE_TTL_MS = 12 * 60 * 1000; // ~10–15 min, pick 12

export const MAX_FINDINGS = 5;
export const MAX_RECOMMENDATIONS = 5;

/** String caps, so malformed/long model text can never inflate storage or UI. */
export const MAX_SUMMARY_LEN = 800;
export const MAX_TITLE_LEN = 200;
export const MAX_EXPLANATION_LEN = 900;
export const MAX_RECOMMENDATION_LEN = 300;
export const MAX_EVIDENCE_REFS_PER_FINDING = 20;

/** A row of supplied evidence, as the model sees it (grounding source). */
export type EvidenceEventInput = {
  id: string;
  ts: number; // epoch ms
  source: string;
  type: string;
  severity?: string | null;
  title: string;
  description: string;
};
