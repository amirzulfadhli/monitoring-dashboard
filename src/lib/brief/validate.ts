/**
 * Validation of a DeepSeek daily-brief response.
 *
 * Model JSON is never trusted: the shape is type-checked, every section is
 * bounded in item count and item length, the total output size is capped, and
 * the grounding guarantee is enforced — every cited evidence id must be one
 * DevPulse actually supplied for this period. Unknown ids are dropped rather
 * than resolved, and a confident brief that cites nothing at all is rejected, so
 * an unsupported claim can never be rendered as if the monitoring data backed
 * it. Anything malformed fails the generation; no partial, arbitrary or
 * unvalidated model text is ever returned to the browser or persisted.
 *
 * Pure: no DB, no framework, no clock.
 */

import {
  BRIEF_MAX_CITATIONS,
  BRIEF_MAX_ITEM_LEN,
  BRIEF_MAX_RAW_CITATIONS,
  BRIEF_MAX_SECTION_ITEMS,
  BRIEF_MAX_SUMMARY_LEN,
  BRIEF_MAX_TOTAL_CHARS,
  type ValidatedBrief,
} from "./model";

export type BriefValidationError =
  | "not_json"
  | "not_object"
  | "bad_summary"
  | "bad_section"
  | "bad_insufficient"
  | "bad_evidence_ids"
  | "too_large"
  | "ungrounded";

export type BriefValidateResult =
  | { ok: true; brief: ValidatedBrief }
  | { ok: false; error: BriefValidationError };

function trimTo(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Validate one section: an array (or absent/null, meaning empty) of non-empty
 * strings, no more than BRIEF_MAX_SECTION_ITEMS long, each trimmed to
 * BRIEF_MAX_ITEM_LEN. Returns null when the section is not a valid shape.
 */
function parseSection(o: Record<string, unknown>, key: string): string[] | null {
  if (o[key] === undefined || o[key] === null) return [];
  const v = o[key];
  if (!Array.isArray(v)) return null;
  if (v.length > BRIEF_MAX_SECTION_ITEMS) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.trim().length === 0) return null;
    out.push(trimTo(item, BRIEF_MAX_ITEM_LEN));
  }
  return out;
}

/**
 * Validate one model response against the evidence ids that were supplied.
 * `allowedIds` is exactly the set of ids the model was given — nothing else can
 * be cited, because nothing else exists on this code path.
 */
export function validateBrief(rawText: string, allowedIds: string[]): BriefValidateResult {
  // The whole response is bounded before it is parsed, so an enormous or
  // adversarial payload cannot become an arbitrarily large object graph.
  if (rawText.length > BRIEF_MAX_TOTAL_CHARS * 8) return { ok: false, error: "too_large" };

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

  if (typeof o.summary !== "string" || o.summary.trim().length === 0) {
    return { ok: false, error: "bad_summary" };
  }
  const summary = trimTo(o.summary, BRIEF_MAX_SUMMARY_LEN);

  const highlights = parseSection(o, "highlights");
  const problems = parseSection(o, "problems");
  const recoveries = parseSection(o, "recoveries");
  const watchNext = parseSection(o, "watchNext");
  if (!highlights || !problems || !recoveries || !watchNext) {
    return { ok: false, error: "bad_section" };
  }

  if (typeof o.insufficientEvidence !== "boolean") {
    return { ok: false, error: "bad_insufficient" };
  }
  const insufficientEvidence = o.insufficientEvidence;

  if (o.evidenceIds === undefined || o.evidenceIds === null) o.evidenceIds = [];
  if (!Array.isArray(o.evidenceIds)) return { ok: false, error: "bad_evidence_ids" };
  if (o.evidenceIds.length > BRIEF_MAX_RAW_CITATIONS) {
    return { ok: false, error: "too_large" };
  }

  const allowed = new Set(allowedIds);
  const cited: string[] = [];
  const seen = new Set<string>();
  for (const id of o.evidenceIds) {
    // Unknown, malformed or repeated references are dropped, never resolved.
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    cited.push(id);
    if (cited.length >= BRIEF_MAX_CITATIONS) break;
  }

  // A confident brief must point at something in the supplied evidence.
  if (!insufficientEvidence && cited.length === 0) {
    return { ok: false, error: "ungrounded" };
  }

  const total =
    summary.length +
    [...highlights, ...problems, ...recoveries, ...watchNext].reduce(
      (n, s) => n + s.length,
      0,
    );
  if (total > BRIEF_MAX_TOTAL_CHARS) return { ok: false, error: "too_large" };

  return {
    ok: true,
    brief: { summary, highlights, problems, recoveries, watchNext, evidenceIds: cited, insufficientEvidence },
  };
}
