/**
 * Priority-aware selection of evidence for an alert explanation.
 *
 * Pure and dependency-free so it can be reasoned about and exercised in
 * isolation. Candidates are ranked:
 *   1. the alert itself
 *   2. events from the alert's own source (or correlated network, for system)
 *   3. nearby warning/critical events from other sources
 *   4. temporally close cross-source events
 *   5. low-value summaries last
 * Then the closest-to-occurrence events are kept, capped at the evidence budget
 * so nothing unrelated from the broader timeline reaches the model.
 */

import {
  EXPLAIN_MAX_EVIDENCE,
  type ExplainEvidenceEvent,
} from "./model";

/** Sources correlated to each alert source (own-source evidence). */
const RELATED: Record<string, string[]> = {
  system: ["system", "network"], // network is correlated with CPU/memory alerts
  websites: ["website"],
  github: ["github"],
  ai: ["ai"],
  security: ["security"],
  storage: ["storage"],
};

const SEV: Record<string, number> = { critical: 3, warning: 2, info: 1 };

const isSubject = (e: ExplainEvidenceEvent, subjectId: string) => e.id === subjectId;

/** Tier-1 own-source check via the alert source (handles the websites↔website key). */
function relatedTo(source: string, alertSource: string): boolean {
  const rel = RELATED[alertSource];
  if (!rel) return false;
  if (rel.includes(source)) return true;
  // websites alert source maps to timeline "website"
  return source === alertSource;
}

/** Summaries / coarse buckets rank last (item 5). */
function isLowValueSummary(e: ExplainEvidenceEvent): boolean {
  const t = e.type;
  return (
    t === "system_summary" ||
    t === "network_summary" ||
    t === "ai_usage_bucket"
  );
}

function tierOf(e: ExplainEvidenceEvent, subjectId: string, alertSource: string): number {
  if (isSubject(e, subjectId)) return 0;
  if (relatedTo(e.source, alertSource)) return 1;
  const sev = e.severity ? SEV[e.severity] ?? 0 : 0;
  if (sev >= 2) return 2; // warning/critical
  if (isLowValueSummary(e)) return 4;
  return 3;
}

/**
 * Rank candidates around `center` (the alert's first occurrence) and return up
 * to `max`. The subject and its own source lead; then meaningful warnings;
 * then close cross-source events; summaries trail. Ties break toward temporal
 * proximity. Never throws; does not mutate the input.
 */
export function selectExplainEvidence(
  subjectId: string,
  alertSource: string,
  centerTs: number,
  events: ExplainEvidenceEvent[],
  max: number = EXPLAIN_MAX_EVIDENCE,
): ExplainEvidenceEvent[] {
  if (max <= 0) return [];
  const ranked = [...events].sort((a, b) => {
    const ta = tierOf(a, subjectId, alertSource);
    const tb = tierOf(b, subjectId, alertSource);
    if (ta !== tb) return ta - tb;
    const da = Math.abs(a.ts - centerTs);
    const db = Math.abs(b.ts - centerTs);
    return da - db;
  });
  return ranked.slice(0, max);
}
