/**
 * Bounded evidence gathering for the daily brief.
 *
 * The evidence comes *only* from what DevPulse has already persisted, read
 * through the same normalized readers Ask DevPulse and the History page use —
 * the unified timeline, the alert store, derived project health, the
 * notification inbox and the AI usage rows. No collector is triggered, no socket
 * is opened, no process is started and no file is touched: every path below is a
 * storage read.
 *
 * Selection then reuses Ask DevPulse's ranking verbatim (`selectEvidence` /
 * `toEvidenceItems`): severity first, then evidence kind, then recency, with a
 * per-source cap and a hard text budget. Only the *sources* and the *bounds* are
 * the brief's own — the deterministic part is shared, so the two features cannot
 * drift apart in how they decide what the model is allowed to see.
 *
 * The output is a small, ordered, request-local id list (E1, E2, …) plus the
 * deterministic pre-summary derived from the same reads. Those ids — and nothing
 * else — are how the model may refer back to evidence.
 */

import { readAlerts } from "@/lib/alerts/storage";
import type { AlertRecord } from "@/lib/alerts/model";
import { selectEvidence, toEvidenceItems, type Candidate } from "@/lib/ask/evidence";
import type { AskEvidence } from "@/lib/ask/model";
import { buildTimeline } from "@/lib/history";
import type { TimelineEvent } from "@/lib/history/model";
import { readUsageRowsSince, type UsageRowForHistory } from "@/lib/monitoring/ai-storage";
import { listRecentNotifications } from "@/lib/notifications/storage";
import type { NotificationRecord } from "@/lib/notifications/model";
import { listProjects } from "@/lib/projects/service";
import type { ProjectHealth, ProjectSummary } from "@/lib/projects/types";

import {
  BRIEF_MAX_ACTIVE_ALERTS,
  BRIEF_MAX_AI_ROWS,
  BRIEF_MAX_DETAIL_LEN,
  BRIEF_MAX_EVIDENCE,
  BRIEF_MAX_EVIDENCE_CHARS,
  BRIEF_MAX_NOTIFICATIONS,
  BRIEF_MAX_PER_SOURCE,
  BRIEF_MAX_PROJECTS,
  BRIEF_MAX_RESOLVED_ALERTS,
  BRIEF_MAX_TIMELINE_SCAN,
  BRIEF_MAX_TITLE_LEN,
  type BriefPeriod,
  type BriefPreSummary,
} from "./model";
import { inPeriod } from "./period";
import { buildPreSummary, type PreSummaryInput } from "./presummary";

/** What one period's gathering produced. */
export type BriefGathered = {
  evidence: AskEvidence[];
  preSummary: BriefPreSummary;
};

/* ------------------------------------------------------------------ *
 * Candidate builders (storage rows -> raw, pre-id evidence)
 * ------------------------------------------------------------------ */

function alertCandidate(a: AlertRecord): Candidate {
  return {
    kind: "alert",
    source: "alert",
    ts: a.lastSeenAt,
    severity: a.severity,
    title: `Alert · ${a.title}`,
    detail: `${a.message} · status ${a.status} · source ${a.source}`,
  };
}

function eventCandidate(e: TimelineEvent): Candidate {
  return {
    kind: "event",
    source: e.source,
    ts: e.ts,
    severity: e.severity ?? null,
    title: e.title,
    detail: e.description,
  };
}

function projectCandidate(p: { name: string; health: ProjectHealth }): Candidate {
  const c = p.health.counts;
  return {
    kind: "project",
    source: "project",
    ts: p.health.evaluatedAt,
    severity:
      p.health.state === "critical"
        ? "critical"
        : p.health.state === "degraded"
          ? "warning"
          : null,
    title: `Project · ${p.name}`,
    detail:
      `health ${p.health.state} · ${c.total} source${c.total === 1 ? "" : "s"} ` +
      `(${c.healthy} healthy, ${c.warn} warn, ${c.critical} critical, ${c.unknown} unknown)` +
      (p.health.reasons.length > 0
        ? ` · ${p.health.reasons.map((r) => r.message).join("; ")}`
        : ""),
  };
}

/** One aggregate line for the period's AI usage, from rows already read. */
function aiUsageCandidate(rows: readonly UsageRowForHistory[]): Candidate | null {
  if (rows.length === 0) return null;
  let tokens = 0;
  let cost = 0;
  let hasCost = false;
  for (const r of rows) {
    tokens += r.totalTokens ?? 0;
    if (r.estimatedCostUsd != null) {
      cost += r.estimatedCostUsd;
      hasCost = true;
    }
  }
  const models = [...new Set(rows.map((r) => r.model).filter((m): m is string => !!m))].slice(0, 3);
  return {
    kind: "ai_usage",
    source: "ai",
    ts: rows[rows.length - 1].ts,
    severity: null,
    title: `AI usage · this period`,
    detail:
      `${rows.length} request${rows.length === 1 ? "" : "s"} · ${tokens} tokens` +
      (hasCost ? ` · $${cost.toFixed(4)} est` : "") +
      (models.length ? ` · models ${models.join(", ")}` : ""),
  };
}

/* ------------------------------------------------------------------ *
 * Storage reads
 * ------------------------------------------------------------------ */

/**
 * Newest first, highest severity first, bounded to `max`. Used for active
 * alerts, which are a *current condition* and so are not restricted to the
 * period: an alert that has been open for days is still the machine's state
 * today. Resolved alerts, which are events, are filtered to the period instead.
 */
function takeAlerts(alerts: readonly AlertRecord[], max: number): Candidate[] {
  const ranked = [...alerts].sort((a, b) => {
    const rank = (s: string) => (s === "critical" ? 3 : s === "warning" ? 2 : 1);
    const bySev = rank(b.severity) - rank(a.severity);
    return bySev !== 0 ? bySev : b.lastSeenAt - a.lastSeenAt;
  });
  return ranked.slice(0, max).map(alertCandidate);
}

function safeProjects(): ProjectSummary[] {
  try {
    return listProjects();
  } catch {
    return [];
  }
}

function safeNotifications(): NotificationRecord[] {
  try {
    return listRecentNotifications(BRIEF_MAX_NOTIFICATIONS);
  } catch {
    return [];
  }
}

function safeTimeline(): TimelineEvent[] {
  try {
    // The 24H timeline is the shortest window DevPulse builds and always starts
    // at or before the period start, so it covers the whole period. Events
    // outside it are filtered out below.
    return buildTimeline("24H");
  } catch {
    return []; // the timeline is unavailable — the other slices still contribute
  }
}

function safeAiRows(since: number): UsageRowForHistory[] {
  try {
    return readUsageRowsSince(since);
  } catch {
    return [];
  }
}

/**
 * Gather the bounded evidence and the deterministic pre-summary for one period.
 *
 * Never throws: an unavailable source simply contributes nothing, and when
 * nothing at all was recorded the caller gets an empty evidence list and answers
 * locally without paying for a model call.
 */
export function gatherBriefEvidence(period: BriefPeriod): BriefGathered {
  const candidates: Candidate[] = [];

  // --- alerts: the current condition --------------------------------------
  let active: AlertRecord[] = [];
  try {
    active = readAlerts("active");
  } catch {
    /* alert store unavailable */
  }
  candidates.push(...takeAlerts(active, BRIEF_MAX_ACTIVE_ALERTS));

  // A condition that cleared inside the period is a recovery worth describing.
  let resolved: AlertRecord[] = [];
  try {
    resolved = readAlerts("resolved").filter((a) =>
      inPeriod(a.resolvedAt ?? a.lastSeenAt, period),
    );
  } catch {
    /* resolved slice unavailable */
  }
  candidates.push(...takeAlerts(resolved, BRIEF_MAX_RESOLVED_ALERTS));

  // --- unified timeline, filtered to the period ---------------------------
  const events: TimelineEvent[] = [];
  for (const e of safeTimeline()) {
    if (!inPeriod(e.ts, period)) continue;
    events.push(e);
    // The timeline is newest-first and already capped; this bounds the scan so a
    // busy history cannot make ranking the dominant cost of a brief.
    if (events.length >= BRIEF_MAX_TIMELINE_SCAN) break;
  }
  candidates.push(...events.map(eventCandidate));

  // --- derived project health ---------------------------------------------
  const projects = safeProjects();
  candidates.push(...projects.slice(0, BRIEF_MAX_PROJECTS).map(projectCandidate));

  // --- AI usage, reduced from the period's own rows -----------------------
  const aiRows = safeAiRows(period.start)
    .filter((r) => inPeriod(r.ts, period))
    .slice(0, BRIEF_MAX_AI_ROWS);
  const aiCandidate = aiUsageCandidate(aiRows);
  if (aiCandidate) candidates.push(aiCandidate);

  // --- notifications: pre-summary only, never evidence --------------------
  // A notification is *derived* from the alert lifecycle, which the alert
  // candidates and the timeline's alert events already carry. Sending a third
  // copy would spend the evidence budget without adding a fact, so the inbox is
  // read for the transition counts in the pre-summary and nothing else.
  const notifications = safeNotifications().filter((n) => inPeriod(n.createdAt, period));

  const input: PreSummaryInput = {
    activeAlerts: active,
    notifications,
    projects,
    events,
    aiRows,
  };

  const selected = selectEvidence(candidates, BRIEF_MAX_EVIDENCE, BRIEF_MAX_PER_SOURCE);
  const evidence = toEvidenceItems(selected, {
    maxTitleLen: BRIEF_MAX_TITLE_LEN,
    maxDetailLen: BRIEF_MAX_DETAIL_LEN,
    maxChars: BRIEF_MAX_EVIDENCE_CHARS,
  });

  return { evidence, preSummary: buildPreSummary(input) };
}
