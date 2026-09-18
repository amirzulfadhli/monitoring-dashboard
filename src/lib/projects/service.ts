/**
 * Business layer over project grouping.
 *
 * Everything the Projects API and pages need lives here: CRUD, association, and
 * the derived summaries. Two rules shape all of it.
 *
 *  1. A project read is a *storage* read. Summaries are built from rows DevPulse
 *     has already persisted (the settings store for configuration, the check /
 *     snapshot tables for state). No collector is invoked, no fetch is made, and
 *     no request to a monitored source is ever triggered by opening a project.
 *
 *  2. Deleting a project is not deleting monitoring. It removes a label: the
 *     sources stay configured and every historical row stays exactly where it
 *     is. They simply become ungrouped.
 *
 * When the settings store is unavailable the project still renders, with its
 * source list empty rather than invented.
 */

import { alertConfig } from "@/lib/alerts/config";
import { readAlerts } from "@/lib/alerts/storage";
import { readLatestDeviceChecks } from "@/lib/devices/storage";
import { readLatestGithubSnapshots } from "@/lib/monitoring/github-snapshots";
import { readLatestApiChecks } from "@/lib/monitoring/api-storage";
import { readLatestWebsiteChecks } from "@/lib/monitoring/storage";
import type { MutateResult } from "@/lib/settings/service";
import {
  listApis,
  listDevices,
  listRepositories,
  listWebsites,
} from "@/lib/settings/storage";

import {
  associateSource,
  deleteProjectRow,
  disassociateSource,
  findProjectByName,
  getAssociation,
  getProjectRow,
  insertProject,
  listAssociations,
  listProjectAssociations,
  listProjectRows,
  updateProjectRow,
} from "./storage";
import { projectHealthOf } from "./health";
import {
  ALERT_SOURCE_TO_PROJECT_SOURCE,
  PROJECT_SOURCE_LABELS,
  type ProjectDetail,
  type ProjectSource,
  type ProjectSourceCounts,
  type ProjectSourceType,
  type ProjectSummary,
  type SourceHealth,
} from "./types";
import {
  validateProjectDescription,
  validateProjectName,
  validateSourceRef,
} from "./validate";

function fail(error: string): MutateResult {
  return { ok: false, error };
}

/** Source names/URLs the state lookups need; read once per build. */
type SourceIndex = {
  /** (type, id) -> the configured source, normalized for display. */
  sources: Map<string, ProjectSource>;
};

const key = (type: ProjectSourceType, id: string) => `${type}:${id}`;

/**
 * The source id an alert fingerprint ends with. Every source-level rule builds
 * its fingerprint as `<source>:<rule>:<subjectId>` (see lib/alerts/rules), so
 * the trailing segment is the source's own id — `owner/repo` for a repository,
 * the target uuid otherwise. Alerts are only ever *read* through this: no rule
 * is added, removed or reinterpreted by project grouping.
 */
function alertSubjectId(fingerprint: string): string {
  return fingerprint.slice(fingerprint.lastIndexOf(":") + 1);
}

/**
 * Latest *persisted* health per source, from the same rows the alert engine and
 * the History timeline already read. A source with no stored observation is
 * `unknown` — never assumed healthy.
 */
function healthMaps(): Map<string, { health: SourceHealth; at: number | null }> {
  const health = new Map<string, { health: SourceHealth; at: number | null }>();

  for (const c of readLatestWebsiteChecks()) {
    health.set(key("website", c.targetId), {
      health: c.state === "healthy" ? "healthy" : c.state === "degraded" ? "warn" : "critical",
      at: c.ts,
    });
  }
  for (const c of readLatestApiChecks()) {
    health.set(key("api", c.targetId), {
      health: c.state === "healthy" ? "healthy" : c.state === "degraded" ? "warn" : "critical",
      at: c.ts,
    });
  }
  // Same window the alert engine uses for a device's latest state, so a project
  // and an alert never disagree about how recently a device was observed.
  for (const c of readLatestDeviceChecks(Date.now() - alertConfig.devices.historyMs)) {
    health.set(key("device", c.deviceId), {
      health: c.reachable ? "healthy" : "critical",
      at: c.ts,
    });
  }
  for (const s of readLatestGithubSnapshots()) {
    health.set(key("repository", s.repoKey), {
      health: s.state === "attention" ? "warn" : "healthy",
      at: s.ts,
    });
  }
  return health;
}

/**
 * Every configured source, keyed by (type, id). Built from the settings store
 * only — this is configuration, not observation, so no check is performed.
 */
function sourceIndex(): SourceIndex {
  const sources = new Map<string, ProjectSource>();

  for (const w of listWebsites() ?? []) {
    sources.set(key("website", w.id), {
      type: "website",
      id: w.id,
      name: w.name,
      detail: w.url,
      enabled: w.enabled,
      health: "unknown",
      checkedAt: null,
    });
  }
  for (const a of listApis() ?? []) {
    sources.set(key("api", a.id), {
      type: "api",
      id: a.id,
      name: a.name,
      detail: a.url,
      enabled: a.enabled,
      health: "unknown",
      checkedAt: null,
    });
  }
  for (const d of listDevices() ?? []) {
    sources.set(key("device", d.id), {
      type: "device",
      id: d.id,
      name: d.name,
      detail: d.host,
      enabled: d.enabled,
      health: "unknown",
      checkedAt: null,
    });
  }
  for (const r of listRepositories() ?? []) {
    sources.set(key("repository", r.id), {
      type: "repository",
      id: r.id,
      name: r.displayName || r.id,
      detail: r.id,
      enabled: r.enabled,
      health: "unknown",
      checkedAt: null,
    });
  }
  return { sources };
}

function emptyCounts(): ProjectSourceCounts {
  return { total: 0, website: 0, repository: 0, api: 0, device: 0 };
}

/** Resolve the sources of one project, dropping any dangling association. */
function resolveSources(
  associations: { sourceType: ProjectSourceType; sourceId: string }[],
  index: SourceIndex,
  health: Map<string, { health: SourceHealth; at: number | null }>,
): ProjectSource[] {
  const out: ProjectSource[] = [];
  for (const a of associations) {
    const source = index.sources.get(key(a.sourceType, a.sourceId));
    // A source removed from Settings leaves no membership behind (the settings
    // service clears it), but an association written by an older build could
    // still dangle — it is skipped rather than rendered as a nameless row.
    if (!source) continue;
    const h = health.get(key(a.sourceType, a.sourceId));
    out.push({ ...source, health: h?.health ?? "unknown", checkedAt: h?.at ?? null });
  }
  return out;
}

function countSources(sources: ProjectSource[]): ProjectSourceCounts {
  const counts = emptyCounts();
  for (const s of sources) {
    counts.total++;
    counts[s.type]++;
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** All projects with their source counts and observed-status summary. */
export function listProjects(): ProjectSummary[] {
  const rows = listProjectRows() ?? [];
  if (rows.length === 0) return [];

  const index = sourceIndex();
  const health = healthMaps();
  const associations = listAssociations() ?? [];
  // One instant for the whole build: every project is evaluated as of the same
  // moment, so the list cannot disagree with itself about what is stale.
  const now = Date.now();

  const byProject = new Map<string, { sourceType: ProjectSourceType; sourceId: string }[]>();
  for (const a of associations) {
    const list = byProject.get(a.projectId);
    if (list) list.push(a);
    else byProject.set(a.projectId, [a]);
  }

  return rows.map((p) => {
    const sources = resolveSources(byProject.get(p.id) ?? [], index, health);
    return {
      ...p,
      sources: countSources(sources),
      health: projectHealthOf(sources, now),
    };
  });
}

/** One project with the sources it currently groups. null => not found. */
export function getProject(id: string): ProjectDetail | null {
  const project = getProjectRow(id);
  if (!project) return null;

  const associations = listProjectAssociations(id);
  const index = sourceIndex();
  const health = healthMaps();

  const sources = resolveSources(associations, index, health);
  const counts = countSources(sources);
  // Derived, not collected: the same stored states the table below renders,
  // reduced by the pure rules in ./health. No alert is raised and no history row
  // is written from here.
  const projectHealth = projectHealthOf(sources, Date.now());

  // Existing source alerts only. Read straight from storage — never through the
  // evaluator — so rendering a project cannot run a rule or reach the network.
  const memberKeys = new Set(
    associations.map((a) => `${a.sourceType}:${a.sourceId}`),
  );
  const alerts = readAlerts("active").filter((a) => {
    const type = ALERT_SOURCE_TO_PROJECT_SOURCE[a.source];
    if (!type) return false; // system / ai / security / storage alerts are machine-level
    return memberKeys.has(`${type}:${alertSubjectId(a.fingerprint)}`);
  });

  // Everything configured but not grouped here — the candidates for assignment.
  const member = new Set(associations.map((a) => key(a.sourceType, a.sourceId)));
  const unassigned = [...index.sources.entries()]
    .filter(([k]) => !member.has(k))
    .map(([, s]) => {
      const h = health.get(key(s.type, s.id));
      return { ...s, health: h?.health ?? "unknown", checkedAt: h?.at ?? null };
    });

  return { ...project, sources, counts, health: projectHealth, unassigned, alerts };
}

/**
 * `(sourceType, sourceId)` -> the project currently holding it, resolved once
 * for a whole build. The History timeline reads this to label events; it is
 * built from two small reads rather than a lookup per emitted event.
 */
export function projectMembership(): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  const projects = new Map((listProjectRows() ?? []).map((p) => [p.id, p]));
  for (const a of listAssociations() ?? []) {
    const p = projects.get(a.projectId);
    if (p) out.set(key(a.sourceType, a.sourceId), { id: p.id, name: p.name });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export function createProject(input: {
  name: unknown;
  description?: unknown;
}): MutateResult {
  const byName = validateProjectName(input.name);
  if (byName) return fail(byName);
  const byDescription = validateProjectDescription(input.description ?? null);
  if (byDescription) return fail(byDescription);

  const name = (input.name as string).trim();
  if (findProjectByName(name)) return fail("A project with this name already exists.");

  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : null;
  return insertProject({ name, description })
    ? { ok: true }
    : fail("Could not save the project (the name may already be in use).");
}

export function updateProject(
  id: string,
  patch: { name?: unknown; description?: unknown },
): MutateResult {
  if (!getProjectRow(id)) return fail("Project not found.");

  const stored: { name?: string; description?: string | null } = {};
  if (patch.name !== undefined) {
    const err = validateProjectName(patch.name);
    if (err) return fail(err);
    const name = (patch.name as string).trim();
    if (findProjectByName(name, id)) {
      return fail("A project with this name already exists.");
    }
    stored.name = name;
  }
  if (patch.description !== undefined) {
    const err = validateProjectDescription(patch.description);
    if (err) return fail(err);
    stored.description =
      typeof patch.description === "string" && patch.description.trim()
        ? patch.description.trim()
        : null;
  }
  if (Object.keys(stored).length === 0) return fail("Nothing to update.");

  return updateProjectRow(id, stored)
    ? { ok: true }
    : fail("Could not update the project (the name may already be in use).");
}

/**
 * Delete a project. Its sources and their history are untouched — they become
 * ungrouped. This is the only place a project is removed; nothing cascades.
 */
export function deleteProject(id: string): MutateResult {
  if (!getProjectRow(id)) return fail("Project not found.");
  return deleteProjectRow(id) ? { ok: true } : fail("Could not delete the project.");
}

/**
 * Assign an existing source to a project. A source already in another project is
 * moved, not duplicated (one project per source in V1).
 */
export function associateSourceToProject(
  projectId: string,
  type: unknown,
  sourceId: unknown,
): MutateResult {
  const project = getProjectRow(projectId);
  if (!project) return fail("Project not found.");

  const ref = validateSourceRef(type, sourceId);
  if (!ref.ok) return fail(ref.error);

  // The source must actually exist: a project groups monitored things, so an
  // id that names nothing is refused rather than stored as a dangling label.
  const exists = sourceIndex().sources.has(key(ref.type, ref.id));
  if (!exists) return fail(`${PROJECT_SOURCE_LABELS[ref.type]} not found.`);

  const current = getAssociation(ref.type, ref.id);
  if (current?.projectId === projectId) return { ok: true }; // already there

  return associateSource(projectId, ref.type, ref.id)
    ? { ok: true }
    : fail("Could not assign the source.");
}

/** Remove a source from its project. The source itself keeps working unchanged. */
export function disassociateSourceFromProject(
  type: unknown,
  sourceId: unknown,
): MutateResult {
  const ref = validateSourceRef(type, sourceId);
  if (!ref.ok) return fail(ref.error);
  if (!getAssociation(ref.type, ref.id)) return fail("Source is not assigned to a project.");
  return disassociateSource(ref.type, ref.id)
    ? { ok: true }
    : fail("Could not unassign the source.");
}
