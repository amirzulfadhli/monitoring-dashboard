/**
 * Builds the bounded, prioritized evidence window for explaining one alert.
 *
 * The window is centered on the alert's first occurrence (±30 min). Because the
 * alert source + nearby correlated point events are the strong signals, we draw
 * normalized events from the shared History timeline (reused infra) and filter
 * them to the window, then add the subject alert and nearby other alerts from
 * persisted alert state. This keeps the evidence small and relevant — never the
 * full 24h timeline. Alert events from the timeline are dropped in favour of the
 * richer, controlled subject/nearby events built here (so nothing is duplicated).
 */

import { buildTimeline } from "@/lib/history";
import { readAlerts } from "../storage";
import type { AlertRecord } from "../model";
import { selectExplainEvidence } from "./select";
import {
  EXPLAIN_WINDOW_AFTER_MS,
  EXPLAIN_WINDOW_BEFORE_MS,
  type ExplainEvidenceEvent,
} from "./model";

/** Window bounds (start/end) and the center timestamp for ranking. */
export type ExplainWindow = { start: number; end: number; center: number };

/**
 * Compute the evidence window around an alert. For an active alert the trailing
 * edge extends to now (so the ongoing condition is visible) but still bounded by
 * the evidence budget.
 */
export function alertWindow(a: AlertRecord, now: number): ExplainWindow {
  const center = a.firstSeenAt;
  const start = center - EXPLAIN_WINDOW_BEFORE_MS;
  const end =
    a.status === "active" ? now : center + EXPLAIN_WINDOW_AFTER_MS;
  return { start, end, center };
}

function asEvent(e: ExplainEvidenceEvent): ExplainEvidenceEvent {
  return {
    id: e.id,
    ts: e.ts,
    source: e.source,
    type: e.type,
    severity: e.severity ?? null,
    title: e.title,
    description: e.description,
  };
}

/** The subject alert as the priority-#1 evidence event (stable id = fingerprint). */
function subjectEvent(a: AlertRecord): ExplainEvidenceEvent {
  return {
    id: a.fingerprint,
    ts: a.firstSeenAt,
    source: "alert",
    type: a.status === "active" ? "alert_active" : "alert_resolved",
    severity: a.severity,
    title: `Alert · ${a.title}`,
    description: a.message,
  };
}

/** Nearby other alerts whose onset falls inside the window. */
function nearbyAlertEvents(
  subject: AlertRecord,
  w: ExplainWindow,
): ExplainEvidenceEvent[] {
  const out: ExplainEvidenceEvent[] = [];
  for (const other of readAlerts("all")) {
    if (other.fingerprint === subject.fingerprint) continue;
    if (other.firstSeenAt < w.start || other.firstSeenAt > w.end) continue;
    out.push({
      id: `alert:${other.fingerprint}`,
      ts: other.firstSeenAt,
      source: "alert",
      type: other.status === "active" ? "alert_active" : "alert_resolved",
      severity: other.severity,
      title: `Alert · ${other.title}`,
      description: other.message,
    });
  }
  return out;
}

/**
 * Build the prioritized evidence (<= budget) for an alert explanation. Never
 * throws: any source slice that fails simply contributes nothing, leaving at
 * least the subject event. Returns the selected events and the window.
 */
export function buildExplainEvidence(
  a: AlertRecord,
  now: number,
): { events: ExplainEvidenceEvent[]; window: ExplainWindow } {
  const w = alertWindow(a, now);
  const subject = subjectEvent(a);

  // Normalized point events (websites, github, system/network, ai) in the window.
  let timelineEvents: ExplainEvidenceEvent[] = [];
  try {
    timelineEvents = buildTimeline("24H")
      .filter((e) => e.source !== "alert" && e.ts >= w.start && e.ts <= w.end)
      .map(asEvent);
  } catch {
    timelineEvents = [];
  }

  let nearby: ExplainEvidenceEvent[] = [];
  try {
    nearby = nearbyAlertEvents(a, w);
  } catch {
    nearby = [];
  }

  const candidates = [subject, ...nearby, ...timelineEvents];
  const events = selectExplainEvidence(
    subject.id,
    a.source,
    w.center,
    candidates,
  );
  return { events, window: w };
}
