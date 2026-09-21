/**
 * DevPulse Daily Operational Brief.
 *
 * A brief is a grounded, structured summary of the evidence DevPulse has
 * *already* persisted for one 24-hour operational period. It is deliberately not
 * a second monitoring system and not an agent: it runs no collector, opens no
 * socket, reads no file and calls no tool. It reads the same normalized storage
 * readers the dashboard and History already use, reduces them deterministically
 * to a small bounded evidence set, and makes at most one instrumented DeepSeek
 * call to describe it.
 *
 * Every bound that keeps a brief cheap lives here — period length, evidence
 * count, per-item and total evidence text, section cardinality and item length,
 * the output token cap, the total validated output size, how many briefs are
 * retained, and the regeneration rule (explicit request only, at most one model
 * call per request, replacing the stored brief for the same period). There is no
 * scheduled, background or on-load generation anywhere in this module or its
 * callers.
 */

import type { AskEvidence } from "@/lib/ask/model";

/* ------------------------------------------------------------------ *
 * Period semantics
 * ------------------------------------------------------------------ */

/** The brief always covers a 24-hour operational period. */
export const BRIEF_WINDOW_HOURS = 24;
export const BRIEF_WINDOW_MS = BRIEF_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * One operational period: the local calendar day containing the request, as a
 * half-open [start, end) window of exactly BRIEF_WINDOW_MS.
 *
 * Days are the unit because a brief is a *daily* artifact and because a stable
 * `start` is what makes "the same period" meaningful — it is the cache key, so a
 * second request for the same day reuses the stored brief instead of paying for
 * another model call. `end` is `start + 24h` rather than the next local midnight
 * so the window is exactly 24 hours even across a daylight-saving change; the
 * window, not the wall-clock day, is what the evidence and the model are told.
 *
 * Evidence is read from [start, end), so a brief requested mid-morning covers
 * the day so far. Nothing in the future can contribute: no row exists yet.
 */
export type BriefPeriod = {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive
  hours: number;
};

/* ------------------------------------------------------------------ *
 * The structured brief
 * ------------------------------------------------------------------ */

/** The model's validated contribution: prose sections plus grounding refs. */
export type ValidatedBrief = {
  summary: string;
  highlights: string[];
  problems: string[];
  recoveries: string[];
  watchNext: string[];
  /** Always a subset of the ids DevPulse supplied; unknown ids are dropped. */
  evidenceIds: string[];
  insufficientEvidence: boolean;
};

/** Measured usage for one generated brief (from the wrapper, never estimated). */
export type BriefUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

/**
 * One stored, validated brief — the whole structured record, not just the
 * model's prose. `periodStart`/`periodEnd`/`generatedAt` describe the period and
 * the instant; `evidence` is the bounded evidence DevPulse supplied (its
 * "evidence references"), and `citedEvidenceIds` is the validated subset the
 * model actually used.
 */
export type BriefRecord = {
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  windowHours: number;
  summary: string;
  highlights: string[];
  problems: string[];
  recoveries: string[];
  watchNext: string[];
  evidence: AskEvidence[];
  citedEvidenceIds: string[];
  evidenceCount: number;
  insufficientEvidence: boolean;
  /** The deterministic 24h pre-summary the model was given, when parsed back. */
  preSummary: BriefPreSummary | null;
  model: string | null;
  usage: BriefUsage | null;
};

/* ------------------------------------------------------------------ *
 * Deterministic pre-summary
 * ------------------------------------------------------------------ *
 * Derived before any model call, from the same bounded reads the evidence uses.
 * It is structured *evidence*, not a monitoring system of its own: every field
 * is a count of something already persisted in the period, and a measurement
 * DevPulse does not have is never estimated into existence.
 * ------------------------------------------------------------------ */

export type BriefPreSummary = {
  /** Alerts open right now (current truth, not restricted to the period). */
  activeAlerts: { total: number; critical: number; warning: number };
  /** Alert lifecycle transitions observed inside the period. */
  alertsOpened: number;
  alertsEscalated: number;
  alertsResolved: number;
  /** Derived project health, evaluated at pre-summary time. */
  projects: { total: number; critical: number; degraded: number; unknown: number };
  /** State transitions inside the period, by source. */
  websiteFailures: number;
  apiFailures: number;
  deviceReachabilityTransitions: number;
  securityFindings: number;
  storageThresholdEvents: number;
  /** AI usage recorded inside the period. */
  ai: { requests: number; failures: number; totalTokens: number; estimatedCostUsd: number | null };
};

/* ------------------------------------------------------------------ *
 * Cost controls (the single editable home for every brief bound)
 * ------------------------------------------------------------------ */

/** Approximate upper bound on model output tokens for one brief. */
export const BRIEF_MAX_OUTPUT_TOKENS = 900;

/** Maximum evidence items handed to the model. */
export const BRIEF_MAX_EVIDENCE = 20;

/** Maximum evidence items any single source may contribute. */
export const BRIEF_MAX_PER_SOURCE = 5;

/** Per-item text caps, so one long description cannot inflate the prompt. */
export const BRIEF_MAX_TITLE_LEN = 160;
export const BRIEF_MAX_DETAIL_LEN = 300;

/** Total evidence text budget across all items. */
export const BRIEF_MAX_EVIDENCE_CHARS = 5000;

/** Candidate caps per source, applied before ranking. */
export const BRIEF_MAX_ACTIVE_ALERTS = 12;
export const BRIEF_MAX_RESOLVED_ALERTS = 8;
export const BRIEF_MAX_PROJECTS = 6;
export const BRIEF_MAX_NOTIFICATIONS = 40;
export const BRIEF_MAX_AI_ROWS = 5000;

/** A busy timeline cannot make ranking the dominant cost of a brief. */
export const BRIEF_MAX_TIMELINE_SCAN = 400;

/** Section cardinality and text caps, enforced on the model's output. */
export const BRIEF_MAX_SECTION_ITEMS = 5;
export const BRIEF_MAX_ITEM_LEN = 240;

/** Caps on the summary and on the total validated output (all sections summed). */
export const BRIEF_MAX_SUMMARY_LEN = 700;
export const BRIEF_MAX_TOTAL_CHARS = 2500;

/** Maximum evidence ids the model may cite back. */
export const BRIEF_MAX_CITATIONS = 12;

/** Hard cap on evidence ids accepted from the model before de-duplication. */
export const BRIEF_MAX_RAW_CITATIONS = 64;

/* ------------------------------------------------------------------ *
 * Retention / regeneration
 * ------------------------------------------------------------------ */

/** Keep at most this many stored briefs; older periods are pruned on write. */
export const BRIEF_MAX_KEPT_ROWS = 30;

/**
 * Regeneration policy, in one place:
 *  - a brief is generated only by an explicit POST — never on a GET, a page
 *    load, a poll, a collector or a scheduler tick;
 *  - a request for the current period returns the stored brief and makes no
 *    model call unless it explicitly asks to regenerate;
 *  - a regeneration is one request, at most one model call, and replaces the
 *    stored brief for that period rather than appending a second one.
 */
export const BRIEF_REGENERATION = {
  explicitRequestOnly: true,
  reuseStoredForSamePeriod: true,
  maxModelCallsPerRequest: 1,
  additionalRowsPerRegeneration: 0,
} as const;
