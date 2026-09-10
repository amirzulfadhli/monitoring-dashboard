/**
 * Persistence for Intelligence analyses. Lives in the same on-disk SQLite
 * database as every other DevPulse source, in its own `intelligence` table.
 *
 * Only what is safe and useful is stored: the timestamp, analysis window, the
 * validated structured result, the evidence event ids it was grounded on, the
 * model, and token/cost metadata. The full DeepSeek prompt is never persisted,
 * and evidence is not stored redundantly (ids are enough to reconstruct it).
 * V1 only surfaces the latest analysis on Overview, so reads are for the most
 * recent row; a light prune keeps the table small on each write.
 */

import { getDb } from "@/lib/db";
import { DAY_MS } from "../alerts/config";
import type { Finding, IntelligenceAnalysis } from "./model";

/** Keep at most this many recent analyses; older rows are pruned on write. */
const MAX_KEPT_ROWS = 25;
/** Hard horizon; anything older than this is pruned on write regardless. */
const PRUNE_HORIZON_MS = 7 * DAY_MS;

/** The stored shape returned to callers (parsed back out of the row). */
export type PersistedAnalysis = {
  ts: number;
  windowHours: number;
  analysis: IntelligenceAnalysis;
  evidenceEventIds: string[];
  evidenceCount: number;
  model: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  } | null;
};

type Row = {
  ts: number;
  windowHours: number;
  status: string;
  summary: string;
  findings: string;
  recommendations: string;
  evidenceEventIds: string;
  evidenceCount: number;
  model: string | null;
  usage: string | null;
};

function parseJsonArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toPersisted(r: Row): PersistedAnalysis | null {
  try {
    const findings = parseJsonArray<Finding>(r.findings);
    const recommendations = parseJsonArray<string>(r.recommendations);
    const evidenceEventIds = parseJsonArray<string>(r.evidenceEventIds);
    if (
      !r.summary ||
      (r.status !== "normal" && r.status !== "attention" && r.status !== "critical")
    ) {
      return null;
    }
    let usage: PersistedAnalysis["usage"] = null;
    if (r.usage) {
      try {
        const u = JSON.parse(r.usage) as {
          inputTokens?: number | null;
          outputTokens?: number | null;
          estimatedCostUsd?: number | null;
        };
        usage = {
          inputTokens: u.inputTokens ?? null,
          outputTokens: u.outputTokens ?? null,
          estimatedCostUsd: u.estimatedCostUsd ?? null,
        };
      } catch {
        usage = null;
      }
    }
    return {
      ts: r.ts,
      windowHours: r.windowHours,
      analysis: {
        status: r.status as IntelligenceAnalysis["status"],
        summary: r.summary,
        findings,
        recommendations,
      },
      evidenceEventIds,
      evidenceCount: r.evidenceCount,
      model: r.model,
      usage,
    };
  } catch {
    return null;
  }
}

/** Read the most recent persisted analysis, newest first. Never throws. */
export function readLatest(): PersistedAnalysis | null {
  const d = getDb();
  if (!d) return null;
  try {
    const r = d
      .prepare(
        `SELECT * FROM intelligence ORDER BY id DESC LIMIT 1`,
      )
      .get() as Row | undefined;
    return r ? toPersisted(r) : null;
  } catch {
    return null;
  }
}

/** Persist one completed analysis. Never throws. */
export function persistAnalysis(p: {
  ts: number;
  windowHours: number;
  analysis: IntelligenceAnalysis;
  evidenceEventIds: string[];
  evidenceCount: number;
  model: string | null;
  usage: PersistedAnalysis["usage"];
}): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO intelligence
         (ts, windowHours, status, summary, findings, recommendations,
          evidenceEventIds, evidenceCount, model, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.ts,
      p.windowHours,
      p.analysis.status,
      p.analysis.summary,
      JSON.stringify(p.analysis.findings),
      JSON.stringify(p.analysis.recommendations),
      JSON.stringify(p.evidenceEventIds),
      p.evidenceCount,
      p.model,
      p.usage ? JSON.stringify(p.usage) : null,
    );
    // Prune old rows so the table stays small (V1 only needs the latest).
    d.prepare(
      `DELETE FROM intelligence WHERE id NOT IN (
         SELECT id FROM intelligence ORDER BY id DESC LIMIT ?
       ) OR ts < ?`,
    ).run(MAX_KEPT_ROWS, Date.now() - PRUNE_HORIZON_MS);
    return true;
  } catch {
    return false;
  }
}
