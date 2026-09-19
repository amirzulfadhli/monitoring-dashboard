/**
 * Bounded evidence retrieval for Ask DevPulse.
 *
 * Evidence is drawn *only* from what DevPulse has already persisted, through the
 * same normalized readers the dashboard uses — the unified History timeline,
 * the alert store, project health, the AI usage aggregate and the notification
 * inbox. Nothing here runs a collector, opens a socket, starts a process or
 * touches the filesystem: every path below is a storage read.
 *
 * Retrieval is deliberately not a fan-out over every table. Which readers run is
 * decided by the interpreted question (its detected topics) and by project
 * scoping; the unified timeline is a single reduced call, and it is filtered
 * before ranking. Everything is then bounded three times over: candidate count
 * per source, total selected items, and total evidence text.
 *
 * The output is a small, ordered, request-local id list (E1, E2, …). Those ids —
 * and nothing else — are how the model is allowed to refer back to evidence.
 */

import { readAlerts } from "@/lib/alerts/storage";
import type { AlertRecord } from "@/lib/alerts/model";
import { buildTimeline } from "@/lib/history";
import { HISTORY_RANGES, type TimelineEvent } from "@/lib/history/model";
import { readAiUsage } from "@/lib/monitoring/ai-storage";
import { listRecentNotifications } from "@/lib/notifications/storage";
import { getProject, listProjects } from "@/lib/projects/service";
import type { ProjectDetail, ProjectHealth, ProjectSummary } from "@/lib/projects/types";

import {
  ASK_MAX_ACTIVE_ALERTS,
  ASK_MAX_DETAIL_LEN,
  ASK_MAX_EVIDENCE,
  ASK_MAX_EVIDENCE_CHARS,
  ASK_MAX_NOTIFICATIONS,
  ASK_MAX_PER_SOURCE,
  ASK_MAX_PROJECTS,
  ASK_MAX_RESOLVED_ALERTS,
  ASK_MAX_TITLE_LEN,
  type AskEvidence,
  type AskEvidenceKind,
  type AskQuery,
  type AskSourceTopic,
} from "./model";

/** Timeline sources a topic speaks for. `projects` has no timeline source of
 *  its own — it is answered from project state and project-labelled events. */
const TOPIC_SOURCES: Record<AskSourceTopic, string[]> = {
  alerts: ["alert"],
  websites: ["website"],
  apis: ["api"],
  github: ["github"],
  ai: ["ai"],
  security: ["security"],
  devices: ["device"],
  storage: ["storage"],
  system: ["system", "network"],
  projects: [],
};

/** Kind priority when two candidates rank equally on severity and time. */
const KIND_RANK: Record<AskEvidenceKind, number> = {
  alert: 5,
  event: 4,
  project: 3,
  ai_usage: 2,
  notification: 1,
};

const SEV_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

/** Raw, pre-id evidence candidate. Internal to this module. */
type Candidate = {
  kind: AskEvidenceKind;
  source: string;
  ts: number | null;
  title: string;
  detail: string;
  severity: string | null;
};

/* ------------------------------------------------------------------ *
 * Project scoping
 * ------------------------------------------------------------------ */

export type ProjectResolution =
  | { kind: "none" }
  | { kind: "matched"; id: string; name: string }
  | { kind: "ambiguous"; names: string[] };

/** Whole-phrase, case-insensitive containment (boundaries are non-alphanumerics). */
function mentions(questionLower: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(questionLower);
}

/**
 * Which existing project (if any) the question is clearly about.
 *
 * Only *existing* project names are ever matched — membership is never inferred
 * from a question. When several projects match and none of them contains the
 * others ("DevPulse API" contains "DevPulse"), the reference is ambiguous and
 * the answer is left unscoped rather than guessed.
 */
export function resolveProject(
  question: string,
  projects: readonly { id: string; name: string }[],
): ProjectResolution {
  const q = question.toLowerCase();
  const matched = projects.filter((p) => mentions(q, p.name));
  if (matched.length === 0) return { kind: "none" };
  if (matched.length === 1) {
    return { kind: "matched", id: matched[0].id, name: matched[0].name };
  }
  // Most specific match wins, but only when it genuinely subsumes the others.
  const byLength = [...matched].sort((a, b) => b.name.length - a.name.length);
  const longest = byLength[0];
  const subsumesAll = byLength
    .slice(1)
    .every((p) => longest.name.toLowerCase().includes(p.name.toLowerCase()));
  if (subsumesAll) return { kind: "matched", id: longest.id, name: longest.name };
  return { kind: "ambiguous", names: byLength.map((p) => p.name) };
}

/* ------------------------------------------------------------------ *
 * Candidate sources (storage reads only)
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

/** Newest first, highest severity first, bounded to `max`. */
function takeAlerts(alerts: readonly AlertRecord[], max: number): Candidate[] {
  const ranked = [...alerts].sort((a, b) => {
    const bySev = (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0);
    return bySev !== 0 ? bySev : b.lastSeenAt - a.lastSeenAt;
  });
  return ranked.slice(0, max).map(alertCandidate);
}

/** One line per project: derived health plus the source counts behind it. */
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

/** Timeline candidates, filtered to the project or to the question's topics. */
function timelineCandidates(
  query: AskQuery,
  projectId: string | null,
  now: number,
): Candidate[] {
  let events: TimelineEvent[];
  try {
    events = buildTimeline(query.window);
  } catch {
    return []; // the timeline is unavailable — other slices still contribute
  }

  const from = now - HISTORY_RANGES[query.window];
  const allowedSources =
    projectId !== null || query.topics.length === 0
      ? null
      : new Set(query.topics.flatMap((t) => TOPIC_SOURCES[t]));

  const out: Candidate[] = [];
  for (const e of events) {
    if (e.ts < from) continue;
    if (projectId !== null) {
      if (e.metadata?.projectId !== projectId) continue;
    } else if (allowedSources && !allowedSources.has(e.source)) {
      continue;
    }
    out.push(eventCandidate(e));
    // The timeline is newest-first and already capped; this bounds the scan so a
    // busy history cannot make ranking the dominant cost of a question.
    if (out.length >= ASK_MAX_EVIDENCE * 20) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Ranking, bounding and id assignment
 * ------------------------------------------------------------------ */

/**
 * Rank candidates and keep a bounded, source-balanced slice: severity first,
 * then evidence kind, then recency, with a per-source cap so one chatty source
 * cannot fill the whole prompt. Pure and deterministic — equal inputs always
 * produce the same selection. The input is not mutated.
 */
export function selectEvidence(
  candidates: readonly Candidate[],
  max: number = ASK_MAX_EVIDENCE,
): Candidate[] {
  if (max <= 0) return [];
  const ranked = [...candidates].sort((a, b) => {
    const bySev = (SEV_RANK[b.severity ?? ""] ?? 0) - (SEV_RANK[a.severity ?? ""] ?? 0);
    if (bySev !== 0) return bySev;
    const byKind = KIND_RANK[b.kind] - KIND_RANK[a.kind];
    if (byKind !== 0) return byKind;
    return (b.ts ?? 0) - (a.ts ?? 0);
  });

  const perSource = new Map<string, number>();
  const kept: Candidate[] = [];
  for (const c of ranked) {
    if (kept.length >= max) break;
    const n = perSource.get(c.source) ?? 0;
    if (n >= ASK_MAX_PER_SOURCE) continue;
    perSource.set(c.source, n + 1);
    kept.push(c);
  }
  return kept;
}

/** Trim to a cap; never returns a partial-character string. */
function trimTo(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Assign request-local ids and enforce the text budget. An item that would
 * exceed the remaining character budget ends the list rather than being sent
 * truncated — the model only ever sees whole evidence items.
 */
export function toEvidenceItems(selected: readonly Candidate[]): AskEvidence[] {
  const items: AskEvidence[] = [];
  let budget = ASK_MAX_EVIDENCE_CHARS;
  for (const c of selected) {
    const title = trimTo(c.title, ASK_MAX_TITLE_LEN);
    const detail = trimTo(c.detail, ASK_MAX_DETAIL_LEN);
    const cost = title.length + detail.length;
    if (cost > budget) break;
    budget -= cost;
    items.push({
      id: `E${items.length + 1}`,
      kind: c.kind,
      source: c.source,
      ts: c.ts,
      title,
      detail,
    });
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function safeProjects(): ProjectSummary[] {
  try {
    return listProjects();
  } catch {
    return [];
  }
}

/**
 * Gather the bounded evidence for one interpreted question.
 *
 * Returns [] when DevPulse holds nothing relevant — the caller answers honestly
 * ("insufficient evidence") instead of paying for a hollow model call. Never
 * throws: an unavailable source simply contributes nothing.
 */
export function gatherEvidence(query: AskQuery, now: number): AskEvidence[] {
  const candidates: Candidate[] = [];
  const projects = safeProjects();
  const scope = resolveProject(query.question, projects);

  const wants = (t: AskSourceTopic) =>
    query.topics.length === 0 || query.topics.includes(t);

  // --- alerts: the current health truth, always in scope -----------------
  const scoped = scope.kind === "matched" ? getProjectSafe(scope.id) : null;
  if (scoped) {
    candidates.push(...takeAlerts(scoped.alerts, ASK_MAX_ACTIVE_ALERTS));
  } else {
    try {
      candidates.push(...takeAlerts(readAlerts("active"), ASK_MAX_ACTIVE_ALERTS));
    } catch {
      /* alert store unavailable — other slices still contribute */
    }
  }

  // A question about something that has since cleared also reaches resolved
  // alerts inside the question's window.
  if (query.includeResolved) {
    try {
      const from = now - HISTORY_RANGES[query.window];
      const resolved = readAlerts("resolved").filter(
        (a) => (a.resolvedAt ?? a.lastSeenAt) >= from,
      );
      candidates.push(...takeAlerts(resolved, ASK_MAX_RESOLVED_ALERTS));
    } catch {
      /* resolved slice unavailable */
    }
  }

  // --- unified timeline: the normalized view of every monitoring source ---
  candidates.push(...timelineCandidates(query, scoped?.id ?? null, now));

  // --- project state: when scoped, or when the question is about projects --
  if (scoped) {
    candidates.push(...projectCandidatesFor(scoped));
  } else if (scope.kind === "ambiguous") {
    // Never guess: the candidate projects are named so the model can say the
    // question is ambiguous instead of silently answering about the wrong one.
    candidates.push(...projects.slice(0, ASK_MAX_PROJECTS).map(projectCandidate));
  } else if (wants("projects")) {
    candidates.push(...projects.slice(0, ASK_MAX_PROJECTS).map(projectCandidate));
  }

  // --- AI usage aggregate -------------------------------------------------
  if (wants("ai")) {
    try {
      candidates.push(aiUsageCandidate(query, now));
    } catch {
      /* AI usage unavailable */
    }
  }

  // --- notification inbox (only when the question is about notifications) --
  if (wants("alerts") && mentionsNotification(query.question)) {
    try {
      for (const n of listRecentNotifications(ASK_MAX_NOTIFICATIONS)) {
        candidates.push({
          kind: "notification",
          source: "notification",
          ts: n.createdAt,
          severity: n.severity,
          title: `Notification · ${n.transition} · ${n.title}`,
          detail: n.message,
        });
      }
    } catch {
      /* inbox unavailable */
    }
  }

  return toEvidenceItems(selectEvidence(candidates));
}

/** The scoped project's own derived state plus each of its unhealthy sources. */
function projectCandidatesFor(detail: ProjectDetail): Candidate[] {
  const out: Candidate[] = [projectCandidate(detail)];
  for (const s of detail.sources) {
    if (s.health === "healthy") continue; // only what is not well needs explaining
    out.push({
      kind: "project",
      source: "project",
      ts: s.checkedAt,
      severity:
        s.health === "critical" ? "critical" : s.health === "warn" ? "warning" : null,
      title: `Project source · ${s.name}`,
      detail: `${s.type} ${s.detail} · observed state ${s.health}`,
    });
  }
  return out;
}

function getProjectSafe(id: string) {
  try {
    return getProject(id);
  } catch {
    return null;
  }
}

function mentionsNotification(question: string): boolean {
  return /(^|[^a-z0-9])notifications?([^a-z0-9]|$)/i.test(question);
}

/** One aggregate line for AI spend/volume over the question's window. */
function aiUsageCandidate(query: AskQuery, now: number): Candidate {
  const s = readAiUsage(query.windowHours * 3_600_000);
  const models = s.byModel
    .slice(0, 3)
    .map((m) => `${m.model} ${m.requests}`)
    .join(", ");
  return {
    kind: "ai_usage",
    source: "ai",
    ts: now,
    severity: null,
    title: `AI usage · last ${query.windowHours}h`,
    detail:
      `${s.requests} request${s.requests === 1 ? "" : "s"} ` +
      `(${s.success} ok, ${s.failures} failed) · ${s.totalTokens} tokens` +
      (s.estimatedCostUsd != null ? ` · $${s.estimatedCostUsd.toFixed(4)} est` : "") +
      (models ? ` · models ${models}` : ""),
  };
}
