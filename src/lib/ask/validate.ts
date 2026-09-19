/**
 * Validation of a DeepSeek answer to an Ask DevPulse question.
 *
 * Model JSON is never trusted: the schema is type-checked, the answer is bounded,
 * and the grounding guarantee is enforced — every cited evidence id must be one
 * DevPulse actually supplied in this request. Unknown ids are dropped rather than
 * accepted, and a non-empty answer that cites nothing at all is rejected, so an
 * unsupported answer can never be rendered as if the monitoring data backed it.
 *
 * Anything malformed fails the request; no partial or arbitrary model text is
 * ever returned to the browser. Pure: no DB, no framework.
 */

import {
  ASK_MAX_ANSWER_LEN,
  ASK_MAX_CITATIONS,
  type AskAnswer,
} from "./model";

export type AskValidationError =
  | "not_json"
  | "not_object"
  | "bad_answer"
  | "bad_insufficient"
  | "bad_evidence_ids"
  | "ungrounded";

export type AskValidateResult =
  | { ok: true; answer: AskAnswer }
  | { ok: false; error: AskValidationError };

function trimTo(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Validate one model response against the evidence ids that were supplied.
 * `allowedIds` is exactly the set of ids the model was given — nothing else can
 * be cited, because nothing else exists on this code path.
 */
export function validateAskAnswer(
  rawText: string,
  allowedIds: string[],
): AskValidateResult {
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

  if (typeof o.answer !== "string" || o.answer.trim().length === 0) {
    return { ok: false, error: "bad_answer" };
  }
  const answer = trimTo(o.answer, ASK_MAX_ANSWER_LEN);

  if (typeof o.insufficientEvidence !== "boolean") {
    return { ok: false, error: "bad_insufficient" };
  }
  const insufficientEvidence = o.insufficientEvidence;

  if (o.evidenceIds === undefined || o.evidenceIds === null) o.evidenceIds = [];
  if (!Array.isArray(o.evidenceIds)) return { ok: false, error: "bad_evidence_ids" };

  const allowed = new Set(allowedIds);
  const cited: string[] = [];
  const seen = new Set<string>();
  for (const id of o.evidenceIds) {
    // Unknown or malformed references are dropped, never resolved.
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    cited.push(id);
    if (cited.length >= ASK_MAX_CITATIONS) break;
  }

  // A confident answer must point at something in the supplied evidence.
  if (!insufficientEvidence && cited.length === 0) {
    return { ok: false, error: "ungrounded" };
  }

  return { ok: true, answer: { answer, evidenceIds: cited, insufficientEvidence } };
}
