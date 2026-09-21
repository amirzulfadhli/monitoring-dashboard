/**
 * Persistence for daily operational briefs. Lives in the same on-disk SQLite
 * database as every other DevPulse source, in its own `daily_briefs` table (see
 * lib/db/schema migration 8).
 *
 * Only what is safe and useful is stored: the period boundaries, when the brief
 * was generated, the validated structured brief, the bounded evidence it was
 * grounded on, the deterministic pre-summary and the model/token/cost metadata.
 * The full DeepSeek prompt is never persisted, and no API key, request body,
 * collector result or file path can reach this table.
 *
 * One row per period (`periodStart` is the primary key), so regenerating a period
 * replaces that row instead of appending a second one; a bounded retention keeps
 * the table small. Every call is wrapped: an unavailable database degrades to
 * null/false rather than breaking the page or the route that reads briefs.
 */

import { getDb } from "@/lib/db";
import type { AskEvidence } from "@/lib/ask/model";

import {
  BRIEF_MAX_KEPT_ROWS,
  type BriefPreSummary,
  type BriefRecord,
  type BriefUsage,
} from "./model";

type Row = {
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  windowHours: number;
  summary: string;
  highlights: string;
  problems: string;
  recoveries: string;
  watchNext: string;
  insufficientEvidence: number;
  evidence: string;
  citedEvidenceIds: string;
  evidenceCount: number;
  preSummary: string | null;
  model: string | null;
  usage: string | null;
};

function parseJson<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseArray<T>(raw: string): T[] {
  const v = parseJson<unknown>(raw);
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Parse usage defensively — a malformed blob is null, never a thrown error. */
function parseUsage(raw: string | null): BriefUsage | null {
  const u = parseJson<Partial<BriefUsage>>(raw);
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : null,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : null,
    estimatedCostUsd: typeof u.estimatedCostUsd === "number" ? u.estimatedCostUsd : null,
  };
}

/** Parse the stored pre-summary defensively; a bad blob reads as absent. */
function parsePreSummary(raw: string | null): BriefPreSummary | null {
  const p = parseJson<BriefPreSummary>(raw);
  return p && typeof p === "object" && !Array.isArray(p) ? p : null;
}

function toRecord(r: Row): BriefRecord | null {
  try {
    if (typeof r.summary !== "string" || r.summary.length === 0) return null;
    return {
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      generatedAt: r.generatedAt,
      windowHours: r.windowHours,
      summary: r.summary,
      highlights: parseArray<string>(r.highlights),
      problems: parseArray<string>(r.problems),
      recoveries: parseArray<string>(r.recoveries),
      watchNext: parseArray<string>(r.watchNext),
      evidence: parseArray<AskEvidence>(r.evidence),
      citedEvidenceIds: parseArray<string>(r.citedEvidenceIds),
      evidenceCount: r.evidenceCount,
      insufficientEvidence: r.insufficientEvidence === 1,
      preSummary: parsePreSummary(r.preSummary),
      model: r.model,
      usage: parseUsage(r.usage),
    };
  } catch {
    return null;
  }
}

const COLUMNS = `periodStart, periodEnd, generatedAt, windowHours, summary,
  highlights, problems, recoveries, watchNext, insufficientEvidence, evidence,
  citedEvidenceIds, evidenceCount, preSummary, model, usage`;

/** The most recent stored brief by period, or null. Never throws. */
export function readLatestBrief(): BriefRecord | null {
  const d = getDb();
  if (!d) return null;
  try {
    const r = d
      .prepare(`SELECT ${COLUMNS} FROM daily_briefs ORDER BY periodStart DESC LIMIT 1`)
      .get() as Row | undefined;
    return r ? toRecord(r) : null;
  } catch {
    return null;
  }
}

/**
 * The stored brief for one period, or null. This is the cache lookup: a hit
 * means the period has already been paid for and no model call is needed.
 */
export function readBriefForPeriod(periodStart: number): BriefRecord | null {
  const d = getDb();
  if (!d) return null;
  try {
    const r = d
      .prepare(`SELECT ${COLUMNS} FROM daily_briefs WHERE periodStart = ?`)
      .get(periodStart) as Row | undefined;
    return r ? toRecord(r) : null;
  } catch {
    return null;
  }
}

/** Total stored briefs (verification / retention checks). */
export function countBriefs(): number {
  const d = getDb();
  if (!d) return 0;
  try {
    const r = d.prepare(`SELECT COUNT(*) AS n FROM daily_briefs`).get() as
      | { n: number }
      | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Store one validated brief. Replaces the period's existing row when it is
 * regenerated, and prunes all but the most recent BRIEF_MAX_KEPT_ROWS periods.
 * Never throws; returns false when nothing could be written.
 */
export function persistBrief(record: BriefRecord): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT OR REPLACE INTO daily_briefs
         (periodStart, periodEnd, generatedAt, windowHours, summary, highlights,
          problems, recoveries, watchNext, insufficientEvidence, evidence,
          citedEvidenceIds, evidenceCount, preSummary, model, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.periodStart,
      record.periodEnd,
      record.generatedAt,
      record.windowHours,
      record.summary,
      JSON.stringify(record.highlights),
      JSON.stringify(record.problems),
      JSON.stringify(record.recoveries),
      JSON.stringify(record.watchNext),
      record.insufficientEvidence ? 1 : 0,
      JSON.stringify(record.evidence),
      JSON.stringify(record.citedEvidenceIds),
      record.evidenceCount,
      record.preSummary ? JSON.stringify(record.preSummary) : null,
      record.model,
      record.usage ? JSON.stringify(record.usage) : null,
    );
    // Keep the table bounded: only the newest periods are retained.
    d.prepare(
      `DELETE FROM daily_briefs WHERE periodStart NOT IN (
         SELECT periodStart FROM daily_briefs ORDER BY periodStart DESC LIMIT ?
       )`,
    ).run(BRIEF_MAX_KEPT_ROWS);
    return true;
  } catch {
    return false;
  }
}
