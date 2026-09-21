/**
 * The deterministic pre-summary.
 *
 * Before any model call, DevPulse reduces the period's already-persisted rows to
 * a handful of counts. This is what the brief's numbers are allowed to come
 * from: the model is handed the counts as structured evidence and is forbidden
 * from inventing any it was not given.
 *
 * It is a *reduction*, not a second monitoring system. Nothing here collects,
 * probes, recomputes a threshold or derives a new signal — each field is the
 * size of a set of rows DevPulse already stored, and a measurement that was
 * never recorded is simply absent rather than estimated. It is a pure function
 * of its inputs (no clock, no I/O), so the same period always yields the same
 * pre-summary.
 */

import type { AlertRecord } from "@/lib/alerts/model";
import type { TimelineEvent } from "@/lib/history/model";
import type { UsageRowForHistory } from "@/lib/monitoring/ai-storage";
import type { NotificationRecord } from "@/lib/notifications/model";
import type { ProjectSummary } from "@/lib/projects/types";

import type { BriefPreSummary } from "./model";

/** Everything the pre-summary is derived from — already read and bounded. */
export type PreSummaryInput = {
  /** Every currently-active alert (current condition, not period-restricted). */
  activeAlerts: readonly AlertRecord[];
  /** Alert lifecycle transitions recorded inside the period. */
  notifications: readonly NotificationRecord[];
  /** Derived project health, evaluated once by the caller. */
  projects: readonly ProjectSummary[];
  /** Timeline events whose timestamp falls inside the period. */
  events: readonly TimelineEvent[];
  /** AI usage rows whose timestamp falls inside the period. */
  aiRows: readonly UsageRowForHistory[];
};

/** Timeline state values that mean a website/API is not serving correctly. */
const FAILING_STATES = new Set(["down", "degraded"]);

function countEvents(
  events: readonly TimelineEvent[],
  source: TimelineEvent["source"],
  onlyFailingStates = false,
): number {
  let n = 0;
  for (const e of events) {
    if (e.source !== source) continue;
    if (onlyFailingStates && !FAILING_STATES.has(String(e.metadata?.state))) continue;
    n++;
  }
  return n;
}

/**
 * Reduce the period's rows to the deterministic pre-summary. Pure: never
 * throws, never reads, never mutates its input.
 */
export function buildPreSummary(input: PreSummaryInput): BriefPreSummary {
  const activeAlerts = { total: 0, critical: 0, warning: 0 };
  for (const a of input.activeAlerts) {
    activeAlerts.total++;
    if (a.severity === "critical") activeAlerts.critical++;
    else if (a.severity === "warning") activeAlerts.warning++;
  }

  let alertsOpened = 0;
  let alertsEscalated = 0;
  let alertsResolved = 0;
  for (const n of input.notifications) {
    if (n.transition === "opened") alertsOpened++;
    else if (n.transition === "escalated") alertsEscalated++;
    else if (n.transition === "resolved") alertsResolved++;
  }

  const projects = { total: 0, critical: 0, degraded: 0, unknown: 0 };
  for (const p of input.projects) {
    projects.total++;
    if (p.health.state === "critical") projects.critical++;
    else if (p.health.state === "degraded") projects.degraded++;
    else if (p.health.state === "unknown") projects.unknown++;
  }

  let requests = 0;
  let failures = 0;
  let totalTokens = 0;
  let cost = 0;
  let hasCost = false;
  for (const r of input.aiRows) {
    requests++;
    // Claude Code ingestion only ever writes successful rows; a direct DeepSeek
    // failure has no usage at all. A row therefore counts as a failure only when
    // it recorded neither tokens nor a cost.
    if (r.totalTokens == null && r.estimatedCostUsd == null) failures++;
    totalTokens += r.totalTokens ?? 0;
    if (r.estimatedCostUsd != null) {
      cost += r.estimatedCostUsd;
      hasCost = true;
    }
  }

  return {
    activeAlerts,
    alertsOpened,
    alertsEscalated,
    alertsResolved,
    projects,
    websiteFailures: countEvents(input.events, "website", true),
    apiFailures: countEvents(input.events, "api", true),
    deviceReachabilityTransitions: countEvents(input.events, "device"),
    securityFindings: countEvents(input.events, "security"),
    storageThresholdEvents: countEvents(input.events, "storage"),
    ai: {
      requests,
      failures,
      totalTokens,
      estimatedCostUsd: hasCost ? Number(cost.toFixed(4)) : null,
    },
  };
}
