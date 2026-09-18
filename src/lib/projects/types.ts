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
  health: SourceHealthCounts;
};

/** A project plus the sources it currently groups. */
export type ProjectDetail = Project & {
  sources: ProjectSource[];
  counts: ProjectSourceCounts;
  health: SourceHealthCounts;
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
