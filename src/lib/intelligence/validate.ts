/**
 * Validation of a DeepSeek Intelligence response.
 *
 * Model-generated JSON is never trusted blindly: this module parses the raw
 * assistant text, type-checks every field, enforces the small schema and the
 * cardinality/string bounds, and — critically for grounding — verifies that
 * every evidence id a finding cites actually exists in the evidence that was
 * supplied. Anything malformed is rejected outright so a broken model output is
 * never surfaced or persisted. No large schema dependency is needed; the checks
 * are small and explicit. Pure (no imports beyond types) so it runs anywhere.
 */

import {
  ANALYSIS_STATUSES,
  FINDING_SEVERITIES,
  MAX_EXPLANATION_LEN,
  MAX_FINDINGS,
  MAX_RECOMMENDATIONS,
  MAX_RECOMMENDATION_LEN,
  MAX_SUMMARY_LEN,
  MAX_TITLE_LEN,
  MAX_EVIDENCE_REFS_PER_FINDING,
  type AnalysisStatus,
  type Finding,
  type FindingSeverity,
  type IntelligenceAnalysis,
} from "./model";

export type ValidationError =
  | "not_json"
  | "not_object"
  | "bad_status"
  | "bad_summary"
  | "bad_findings_type"
  | "too_many_findings"
  | "bad_finding"
  | "unknown_evidence_id"
  | "too_many_recommendations"
  | "bad_recommendation";

export type ValidateResult =
  | { ok: true; analysis: IntelligenceAnalysis }
  | { ok: false; error: ValidationError };

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

function trimTo(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function isSeverity(v: unknown): v is FindingSeverity {
  return typeof v === "string" && (FINDING_SEVERITIES as readonly string[]).includes(v);
}

/**
 * Validate one finding object and confirm its cited ids all exist in the
 * supplied evidence id set. Returns a trimmed, typed Finding, or null when the
 * finding (or its grounding) is invalid.
 */
function parseFinding(raw: unknown, allowed: ReadonlySet<string>): Finding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isSeverity(r.severity)) return null;
  if (!isNonEmptyString(r.title)) return null;
  if (typeof r.explanation !== "string" || r.explanation.trim().length === 0) return null;
  if (!Array.isArray(r.evidenceEventIds) || r.evidenceEventIds.length === 0) return null;
  if (r.evidenceEventIds.length > MAX_EVIDENCE_REFS_PER_FINDING) return null;
  const ids: string[] = [];
  for (const id of r.evidenceEventIds) {
    if (typeof id !== "string" || id.length === 0) return null; // malformed entry
    if (!allowed.has(id)) return null; // grounding violation -> reject finding
    ids.push(id);
  }
  return {
    severity: r.severity,
    title: trimTo(r.title, MAX_TITLE_LEN),
    explanation: trimTo(r.explanation, MAX_EXPLANATION_LEN),
    evidenceEventIds: ids,
  };
}

/**
 * Validate a full model response against the supplied evidence ids.
 * `allowed` is the set of evidence event ids the model was allowed to cite.
 */
export function validateAnalysis(
  rawText: string,
  allowedIds: string[],
): ValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "not_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "not_object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (
    typeof obj.status !== "string" ||
    !(ANALYSIS_STATUSES as readonly string[]).includes(obj.status)
  ) {
    return { ok: false, error: "bad_status" };
  }
  const status = obj.status as AnalysisStatus;

  if (!isNonEmptyString(obj.summary)) return { ok: false, error: "bad_summary" };
  const summary = trimTo(obj.summary as string, MAX_SUMMARY_LEN);

  const allowed = new Set(allowedIds);

  if (obj.findings === undefined || obj.findings === null) obj.findings = [];
  if (!Array.isArray(obj.findings)) return { ok: false, error: "bad_findings_type" };
  if (obj.findings.length > MAX_FINDINGS) return { ok: false, error: "too_many_findings" };
  const findings: Finding[] = [];
  for (const f of obj.findings) {
    const finding = parseFinding(f, allowed);
    if (!finding) return { ok: false, error: "unknown_evidence_id" };
    findings.push(finding);
  }

  if (obj.recommendations === undefined || obj.recommendations === null) {
    obj.recommendations = [];
  }
  if (!Array.isArray(obj.recommendations)) {
    return { ok: false, error: "too_many_recommendations" };
  }
  if (obj.recommendations.length > MAX_RECOMMENDATIONS) {
    return { ok: false, error: "too_many_recommendations" };
  }
  const recommendations: string[] = [];
  for (const rec of obj.recommendations) {
    if (!isNonEmptyString(rec)) return { ok: false, error: "bad_recommendation" };
    recommendations.push(trimTo(rec, MAX_RECOMMENDATION_LEN));
  }

  return { ok: true, analysis: { status, summary, findings, recommendations } };
}
