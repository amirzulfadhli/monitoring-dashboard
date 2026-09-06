/**
 * Bounded, priority-aware evidence selection for Intelligence.
 *
 * Evidence is drawn from the unified History timeline (itself the reduced,
 * non-sensitive view of every monitoring source). That timeline can be large
 * (many hourly summaries), so before anything reaches DeepSeek it is narrowed
 * to a small, meaningful set: every critical/warning event first, then the
 * newest informational events to fill the budget. This keeps the prompt compact
 * and avoids flooding the model with repetitive low-value rows.
 *
 * Pure and free of DB/imports so it can be reasoned about and exercised in
 * isolation. The input shape is structural; History's TimelineEvent satisfies it.
 */

import {
  MAX_EVIDENCE_EVENTS,
  type EvidenceEventInput,
} from "./model";

const RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

/** Priority rank for selection (higher = more important). Undefined == info. */
function rankOf(sev: EvidenceEventInput["severity"]): number {
  return sev ? RANK[sev] ?? 1 : 1;
}

/**
 * Pick up to `max` events, newest-first within each priority tier. All
 * critical and warning events are kept ahead of informational ones, so a quiet
 * day full of hourly summaries can never crowd out a real warning. Never
 * throws. The input array is not mutated.
 */
export function selectEvidence(
  events: EvidenceEventInput[],
  max: number = MAX_EVIDENCE_EVENTS,
): EvidenceEventInput[] {
  if (events.length === 0 || max <= 0) return [];
  const ranked = [...events].sort((a, b) => {
    const byRank = rankOf(b.severity) - rankOf(a.severity);
    if (byRank !== 0) return byRank;
    return b.ts - a.ts; // newest first within a tier
  });
  return ranked.slice(0, max);
}

/** Severity label helpers shared by the prompt and payload builders. */
export function severityOf(sev: EvidenceEventInput["severity"]): string | null {
  if (!sev) return null;
  return ["critical", "warning", "info"].includes(sev) ? sev : null;
}
