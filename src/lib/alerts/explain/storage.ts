/**
 * Persistence for alert explanations. Lives in the same on-disk SQLite database,
 * in its own `alert_explanations` table.
 *
 * Only structured metadata is stored: alert fingerprint + occurrence version key,
 * createdAt, the validated structured result, the evidence event ids it was
 * grounded on, the model, and token/cost metadata. The full DeepSeek prompt is
 * never persisted, and raw evidence bodies are not duplicated (ids suffice).
 * Reading is newest-first so a fresh explanation for the current occurrence is
 * surfaced; older rows for a fingerprint are pruned on write.
 */

import { getDb } from "@/lib/db";
import { DAY_MS } from "../config";
import type { AlertExplanation, ExplainEvidenceRef } from "./model";

const MAX_KEPT_PER_FINGERPRINT = 20;
const PRUNE_HORIZON_MS = 7 * DAY_MS;

export type ExplainUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export type StoredExplanation = {
  fingerprint: string;
  versionKey: string;
  createdAt: number;
  explanation: AlertExplanation;
  evidenceEventIds: string[];
  model: string | null;
  usage: ExplainUsage | null;
};

type Row = {
  id: number;
  fingerprint: string;
  versionKey: string;
  createdAt: number;
  summary: string;
  likelyCause: string | null;
  confidence: string;
  evidence: string;
  checks: string;
  evidenceEventIds: string;
  model: string | null;
  usage: string | null;
};

function parseArr<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function parseUsage(raw: string | null): ExplainUsage | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as {
      inputTokens?: number | null;
      outputTokens?: number | null;
      estimatedCostUsd?: number | null;
    };
    return {
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      estimatedCostUsd: u.estimatedCostUsd ?? null,
    };
  } catch {
    return null;
  }
}

function toStored(r: Row): StoredExplanation | null {
  if (
    (r.confidence !== "low" &&
      r.confidence !== "medium" &&
      r.confidence !== "high") ||
    !r.summary
  ) {
    return null;
  }
  const evidence = parseArr<ExplainEvidenceRef>(r.evidence).filter(
    (e) => e && typeof e.eventId === "string" && typeof e.relevance === "string",
  );
  const checks = parseArr<string>(r.checks).filter((c) => typeof c === "string");
  return {
    fingerprint: r.fingerprint,
    versionKey: r.versionKey,
    createdAt: r.createdAt,
    explanation: {
      summary: r.summary,
      likelyCause: r.likelyCause,
      confidence: r.confidence as AlertExplanation["confidence"],
      evidence,
      checks,
    },
    evidenceEventIds: parseArr<string>(r.evidenceEventIds),
    model: r.model,
    usage: parseUsage(r.usage),
  };
}

/** Read the most recent stored explanation for a fingerprint. Never throws. */
export function readExplain(fingerprint: string): StoredExplanation | null {
  const d = getDb();
  if (!d) return null;
  try {
    const r = d
      .prepare(
        `SELECT * FROM alert_explanations WHERE fingerprint = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(fingerprint) as Row | undefined;
    return r ? toStored(r) : null;
  } catch {
    return null;
  }
}

/** Persist one explanation. Prunes old rows for the fingerprint. Never throws. */
export function persistExplain(p: {
  fingerprint: string;
  versionKey: string;
  createdAt: number;
  explanation: AlertExplanation;
  evidenceEventIds: string[];
  model: string | null;
  usage: ExplainUsage | null;
}): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO alert_explanations
         (fingerprint, versionKey, createdAt, summary, likelyCause, confidence,
          evidence, checks, evidenceEventIds, model, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.fingerprint,
      p.versionKey,
      p.createdAt,
      p.explanation.summary,
      p.explanation.likelyCause,
      p.explanation.confidence,
      JSON.stringify(p.explanation.evidence),
      JSON.stringify(p.explanation.checks),
      JSON.stringify(p.evidenceEventIds),
      p.model,
      p.usage ? JSON.stringify(p.usage) : null,
    );
    d.prepare(
      `DELETE FROM alert_explanations WHERE fingerprint = ? AND id NOT IN (
         SELECT id FROM alert_explanations WHERE fingerprint = ?
         ORDER BY id DESC LIMIT ?
       )`,
    ).run(p.fingerprint, p.fingerprint, MAX_KEPT_PER_FINGERPRINT);
    d.prepare(`DELETE FROM alert_explanations WHERE createdAt < ?`).run(
      Date.now() - PRUNE_HORIZON_MS,
    );
    return true;
  } catch {
    return false;
  }
}
