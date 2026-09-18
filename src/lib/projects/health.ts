/**
 * Deterministic project health.
 *
 * A project is a group of things DevPulse already monitors, so its health is
 * read off the *state those sources are already in* — never off a score, a
 * weight, a percentage or a model. Everything here is a pure function of
 * (normalized source states, now): same inputs, same output, no I/O, no clock
 * of its own, no collector, no network.
 *
 * The rules, in one place:
 *
 *   1. Normalize each source to healthy | warn | critical | unknown.
 *   2. Take the worst normalized state, with unknown ranked *above* healthy:
 *      a source nobody has observed is not evidence that a project is fine.
 *   3. Name the sources responsible, bounded and ordered deterministically.
 *
 * Precedence: critical > degraded > unknown > healthy.
 *
 * Nothing here infers intent, reliability, SLA or business impact — those are
 * not observable, and DevPulse does not pretend otherwise.
 */

import { JOB_STALE_AFTER_MS } from "@/lib/scheduler/model";

import {
  PROJECT_SOURCE_LABELS,
  PROJECT_SOURCE_TYPES,
  type ProjectHealth,
  type ProjectHealthReason,
  type ProjectHealthReasonCode,
  type ProjectHealthSource,
  type ProjectHealthState,
  type ProjectSourceType,
  type SourceHealth,
  type SourceHealthCounts,
} from "./types";

/**
 * How old an observation may be before it stops counting as current.
 *
 * Deliberately the *existing* staleness rule (three collector cadences — see
 * lib/scheduler/model) rather than a window invented for projects, so a project
 * and the collector-health panel can never disagree about what "stale" means.
 */
export const SOURCE_STALE_AFTER_MS: Record<ProjectSourceType, number> = {
  website: JOB_STALE_AFTER_MS.websites,
  api: JOB_STALE_AFTER_MS.apis,
  device: JOB_STALE_AFTER_MS.devices,
  repository: JOB_STALE_AFTER_MS.github,
};

/** Hard cap on returned reasons, so a large project cannot flood the UI. */
export const MAX_PROJECT_HEALTH_REASONS = 3;

/** Worst-first. `unknown` outranks `healthy`: absent evidence is not good news. */
const RANK: Record<SourceHealth, number> = {
  critical: 3,
  warn: 2,
  unknown: 1,
  healthy: 0,
};

/** Normalized source state -> the project state it implies. */
const PROJECT_STATE_OF: Record<SourceHealth, ProjectHealthState> = {
  critical: "critical",
  warn: "degraded",
  unknown: "unknown",
  healthy: "healthy",
};

/** The reason code for a source that is *not* being discounted for age. */
function codeOf(state: SourceHealth, type: ProjectSourceType): ProjectHealthReasonCode | null {
  if (state === "critical") return type === "device" ? "unreachable" : "down";
  if (state === "warn") return type === "repository" ? "attention" : "degraded";
  if (state === "unknown") return "no_data";
  return null;
}

const MESSAGE: Record<ProjectHealthReasonCode, (label: string, name: string) => string> = {
  down: (label, name) => `${label} ${name} is down`,
  degraded: (label, name) => `${label} ${name} is degraded`,
  unreachable: (label, name) => `Device ${name} is unreachable`,
  attention: (label, name) => `${label} ${name} needs attention`,
  stale: (label, name) => `${label} ${name} data is stale`,
  no_data: (label, name) => `${label} ${name} has no monitoring data`,
  disabled: (label, name) => `${label} ${name} is disabled`,
};

/**
 * Reduce one stored source to its health contribution.
 *
 * Age is handled here, and only in the safe direction:
 *  - a *stale healthy* observation is downgraded to `warn` — old good news is
 *    not current good news;
 *  - a stale failure stays a failure — a down reading does not become healthy
 *    by getting older, and it will not clear without a new observation.
 *
 * A disabled source is `unknown`: DevPulse is deliberately not collecting it, so
 * its stored state describes a past the user has opted out of continuing.
 */
function normalize(
  source: ProjectHealthSource,
  now: number,
): { state: SourceHealth; code: ProjectHealthReasonCode | null } {
  if (!source.enabled) return { state: "unknown", code: "disabled" };
  if (source.health === "unknown" || source.checkedAt == null) {
    return { state: "unknown", code: "no_data" };
  }

  const age = now - source.checkedAt;
  // A clock skew / future timestamp must not read as stale.
  const stale = age > SOURCE_STALE_AFTER_MS[source.type];
  if (stale && source.health === "healthy") return { state: "warn", code: "stale" };
  return { state: source.health, code: codeOf(source.health, source.type) };
}

/** Deterministic order: worst first, then source kind, then name. */
function compareReasons(a: ProjectHealthReason, b: ProjectHealthReason): number {
  const byState = RANK[b.state] - RANK[a.state];
  if (byState !== 0) return byState;
  const byType = PROJECT_SOURCE_TYPES.indexOf(a.type) - PROJECT_SOURCE_TYPES.indexOf(b.type);
  if (byType !== 0) return byType;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Evaluate a project's health from its sources' normalized states.
 *
 * `sources` are the project's *associated* sources; a project with none is
 * `unknown`, never healthy — the absence of monitored things is not a clean bill
 * of health.
 */
export function projectHealthOf(
  sources: readonly ProjectHealthSource[],
  now: number,
): ProjectHealth {
  const counts: SourceHealthCounts = {
    total: 0,
    healthy: 0,
    warn: 0,
    critical: 0,
    unknown: 0,
  };
  const reasons: ProjectHealthReason[] = [];

  for (const source of sources) {
    const { state, code } = normalize(source, now);
    counts.total++;
    counts[state]++;

    if (state === "healthy" || !code) continue;
    reasons.push({
      type: source.type,
      id: source.id,
      name: source.name,
      state,
      code,
      message: MESSAGE[code](PROJECT_SOURCE_LABELS[source.type], source.name),
    });
  }

  if (counts.total === 0) {
    return { state: "unknown", reasons: [], counts, evaluatedAt: now };
  }

  // Worst contribution wins. `counts` already carries the full picture, so the
  // reason list is a bounded explanation of *that* state, not a summary of all.
  let worst: SourceHealth = "healthy";
  for (const state of ["critical", "warn", "unknown", "healthy"] as const) {
    if (counts[state] > 0) {
      worst = state;
      break;
    }
  }

  reasons.sort(compareReasons);
  return {
    state: PROJECT_STATE_OF[worst],
    reasons: reasons.slice(0, MAX_PROJECT_HEALTH_REASONS),
    counts,
    evaluatedAt: now,
  };
}
