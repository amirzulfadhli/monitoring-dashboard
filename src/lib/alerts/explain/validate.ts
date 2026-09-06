/**
 * Validation of a DeepSeek alert-explanation response.
 *
 * Model JSON is never trusted: type-check the schema, enforce the confidence
 * enum and cardinality/string caps, and — the grounding guarantee — verify every
 * cited eventId exists in the evidence that was actually supplied. `likelyCause`
 * is allowed to be null (honest "insufficient evidence"). Anything malformed is
 * rejected so broken or unsupported output is never surfaced or persisted.
 * Pure; no DB, no framework.
 */

import {
  EXPLAIN_CONFIDENCES,
  EXPLAIN_MAX_CAUSE_LEN,
  EXPLAIN_MAX_CHECK_LEN,
  EXPLAIN_MAX_ITEMS,
  EXPLAIN_MAX_RELEVANCE_LEN,
  EXPLAIN_MAX_SUMMARY_LEN,
  type AlertExplanation,
  type ExplainConfidence,
} from "./model";

export type ExplainValidationError =
  | "not_json"
  | "not_object"
  | "bad_summary"
  | "bad_cause"
  | "bad_confidence"
  | "bad_evidence_type"
  | "too_many_evidence"
  | "bad_evidence_item"
  | "unknown_event_id"
  | "bad_checks"
  | "too_many_checks";

export type ExplainValidateResult =
  | { ok: true; explanation: AlertExplanation }
  | { ok: false; error: ExplainValidationError };

const isConfidence = (v: unknown): v is ExplainConfidence =>
  typeof v === "string" &&
  (EXPLAIN_CONFIDENCES as readonly string[]).includes(v);

const nonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

function trimTo(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function validateExplain(
  rawText: string,
  allowedIds: string[],
): ExplainValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "not_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "not_object" };
  }
  const o = parsed as Record<string, unknown>;
  const allowed = new Set(allowedIds);

  if (!nonEmptyString(o.summary)) return { ok: false, error: "bad_summary" };
  const summary = trimTo(o.summary, EXPLAIN_MAX_SUMMARY_LEN);

  // likelyCause must be null or a non-empty string.
  if (o.likelyCause !== null && !nonEmptyString(o.likelyCause)) {
    return { ok: false, error: "bad_cause" };
  }
  const likelyCause =
    o.likelyCause === null || o.likelyCause === undefined
      ? null
      : trimTo(o.likelyCause as string, EXPLAIN_MAX_CAUSE_LEN);

  if (!isConfidence(o.confidence)) return { ok: false, error: "bad_confidence" };
  const confidence = o.confidence;

  if (o.evidence === undefined || o.evidence === null) o.evidence = [];
  if (!Array.isArray(o.evidence)) return { ok: false, error: "bad_evidence_type" };
  if (o.evidence.length > EXPLAIN_MAX_ITEMS) {
    return { ok: false, error: "too_many_evidence" };
  }
  const evidence: AlertExplanation["evidence"] = [];
  for (const it of o.evidence) {
    if (typeof it !== "object" || it === null || Array.isArray(it)) {
      return { ok: false, error: "bad_evidence_item" };
    }
    const e = it as Record<string, unknown>;
    if (typeof e.eventId !== "string" || e.eventId.length === 0) {
      return { ok: false, error: "bad_evidence_item" };
    }
    if (!allowed.has(e.eventId)) return { ok: false, error: "unknown_event_id" };
    if (typeof e.relevance !== "string" || e.relevance.trim().length === 0) {
      return { ok: false, error: "bad_evidence_item" };
    }
    evidence.push({
      eventId: e.eventId,
      relevance: trimTo(e.relevance, EXPLAIN_MAX_RELEVANCE_LEN),
    });
  }

  if (o.checks === undefined || o.checks === null) o.checks = [];
  if (!Array.isArray(o.checks)) return { ok: false, error: "bad_checks" };
  if (o.checks.length > EXPLAIN_MAX_ITEMS) return { ok: false, error: "too_many_checks" };
  const checks: string[] = [];
  for (const c of o.checks) {
    if (!nonEmptyString(c)) return { ok: false, error: "bad_checks" };
    checks.push(trimTo(c, EXPLAIN_MAX_CHECK_LEN));
  }

  return {
    ok: true,
    explanation: { summary, likelyCause, confidence, evidence, checks },
  };
}
