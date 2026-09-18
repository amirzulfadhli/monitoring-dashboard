/**
 * Canonical shapes for DevPulse Projects.
 *
 * A project is a pure organizational layer over sources DevPulse already
 * monitors. It owns no data of its own: no checks, no snapshots, no members, no
 * schedules, no permissions. Removing a project removes a label — never a
 * source and never a row of monitoring history.
 *
 * Machine-level sources (the local system, storage volumes, security posture)
 * are deliberately not associable: they describe this machine, not a project.
 */

import type { AlertRecord } from "@/lib/alerts/model";

/** Source kinds a project may group. Four existing monitored_* collections. */
export const PROJECT_SOURCE_TYPES = [
  "website",
  "repository",
  "api",
  "device",
] as const;
export type ProjectSourceType = (typeof PROJECT_SOURCE_TYPES)[number];

/** Alert `source` value -> the project source kind it belongs to. */
export const ALERT_SOURCE_TO_PROJECT_SOURCE: Record<string, ProjectSourceType> = {
  websites: "website",
  apis: "api",
  devices: "device",
  github: "repository",
};

/** Human label per source kind (UI chips, messages). */
export const PROJECT_SOURCE_LABELS: Record<ProjectSourceType, string> = {
  website: "Website",
  repository: "Repository",
  api: "API",
  device: "Device",
};

export type Project = {
  id: string;
  name: string;
  /** Optional free text. Null when unset. */
  description: string | null;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
};

/**
 * Normalized health of a grouped source, derived only from state DevPulse has
 * already persisted. `unknown` means no observation is stored yet — it is never
 * a substitute for "healthy".
 */
export type SourceHealth = "healthy" | "warn" | "critical" | "unknown";

/** One source currently associated with a project, with its latest stored state. */
export type ProjectSource = {
  type: ProjectSourceType;
  /** The source's own stable id (website/api/device uuid, or owner/repo). */
  id: string;
  name: string;
  /** Owner/repo for a repository; host for a device; URL otherwise. */
  detail: string;
  enabled: boolean;
  health: SourceHealth;
  /** Epoch ms of the state that produced `health`, or null when unknown. */
  checkedAt: number | null;
};

/** Counts used by the projects list for a concise observed-status summary. */
export type SourceHealthCounts = {
  total: number;
  healthy: number;
  warn: number;
  critical: number;
  unknown: number;
};

/**
 * Health of a whole project. Four states, no score: a project is a group of
 * things DevPulse watches, so its health is the worst thing being watched, not
 * a weighted number. The rules live in ./health.
 */
export type ProjectHealthState = "healthy" | "degraded" | "critical" | "unknown";

/** Why a source is not healthy. One code per observable condition. */
export type ProjectHealthReasonCode =
  | "down" // website / API returned a failing check
  | "degraded" // website / API returned a partial failure
  | "unreachable" // device did not answer
  | "attention" // repository needs a human look
  | "stale" // the stored observation is too old to be evidence
  | "no_data" // nothing has ever been observed
  | "disabled"; // deliberately not monitored

/**
 * The normalized project-health input: the shape every source kind is reduced
 * to. It is a subset of ProjectSource, so the sources a project already resolves
 * are passed straight in — there is no second model to keep in step.
 */
export type ProjectHealthSource = {
  type: ProjectSourceType;
  /** The source's own id, so a reason can name a source unambiguously. */
  id: string;
  name: string;
  health: SourceHealth;
  /** Epoch ms of the observation behind `health`; null when there is none. */
  checkedAt: number | null;
  enabled: boolean;
};

/** One deterministic, observable reason a project is not healthy. */
export type ProjectHealthReason = {
  type: ProjectSourceType;
  /** The source's own id — two sources may share a display name. */
  id: string;
  name: string;
  /** The source's normalized state at evaluation time. */
  state: SourceHealth;
  code: ProjectHealthReasonCode;
  /** Human sentence built from the code — never generated, never narrated. */
  message: string;
};

/** The derived health of a project. Pure output of ./health#projectHealthOf. */
export type ProjectHealth = {
  state: ProjectHealthState;
  reasons: ProjectHealthReason[];
  counts: SourceHealthCounts;
  /** Epoch ms the evaluation ran; every input is as of this instant. */
  evaluatedAt: number;
};

export type ProjectSourceCounts = {
  total: number;
  website: number;
  repository: number;
  api: number;
  device: number;
};

/** A project as shown in the list: metadata plus derived source summaries. */
export type ProjectSummary = Project & {
  sources: ProjectSourceCounts;
  /** Derived project health: state, deterministic reasons, per-state counts. */
  health: ProjectHealth;
};

/** A project plus the sources it currently groups. */
export type ProjectDetail = Project & {
  sources: ProjectSource[];
  counts: ProjectSourceCounts;
  /** Derived project health: state, deterministic reasons, per-state counts. */
  health: ProjectHealth;
  /**
   * Configured sources that are not in this project, so the detail page can
   * offer assignment without a second round-trip. Derived from the same
   * settings read — nothing is collected to produce it.
   */
  unassigned: ProjectSource[];
  /**
   * Existing alerts whose source is currently in this project. These are the
   * source-level alerts created by the ordinary rules — Task 25 adds no
   * project-level rule, and nothing here changes alert semantics.
   */
  alerts: AlertRecord[];
};
