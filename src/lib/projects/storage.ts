/**
 * Persistence for project grouping.
 *
 * Lives in the same on-disk SQLite database as every other DevPulse table, in
 * its own two tables (see lib/db/schema migration 6). Nothing here reads or
 * writes a check/snapshot table: a project references sources by their existing
 * stable ids and copies none of their data.
 *
 * Every call is wrapped so an unavailable database degrades to null/false
 * rather than breaking the pages and routes that read projects.
 */

import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";

import type { Project, ProjectSourceType } from "./types";

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
};

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Every project, oldest first. null => the database is unavailable. */
export function listProjectRows(): Project[] | null {
  const d = getDb();
  if (!d) return null;
  try {
    const rows = d
      .prepare(
        `SELECT id, name, description, createdAt, updatedAt
           FROM projects ORDER BY createdAt ASC, id ASC`,
      )
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  } catch {
    return null;
  }
}

/** One project by id, or null when it does not exist / the DB is unavailable. */
export function getProjectRow(id: string): Project | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d
      .prepare(
        `SELECT id, name, description, createdAt, updatedAt FROM projects WHERE id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  } catch {
    return null;
  }
}

/**
 * Look up a project by name, case-insensitively (the unique index is on
 * `name COLLATE NOCASE`, so this is the same rule the store enforces).
 * `exceptId` excludes one project so an update can keep its own name.
 */
export function findProjectByName(name: string, exceptId?: string): Project | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d
      .prepare(
        `SELECT id, name, description, createdAt, updatedAt
           FROM projects
          WHERE name COLLATE NOCASE = ? COLLATE NOCASE AND id IS NOT ? LIMIT 1`,
      )
      .get(name.trim(), exceptId ?? null) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  } catch {
    return null;
  }
}

/** Insert a project. null => duplicate name (unique index) or DB failure. */
export function insertProject(input: {
  name: string;
  description: string | null;
}): Project | null {
  const d = getDb();
  if (!d) return null;
  const now = Date.now();
  const id = randomUUID();
  const name = input.name.trim();
  try {
    d.prepare(
      `INSERT INTO projects (id, name, description, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, input.description, now, now);
    return { id, name, description: input.description, createdAt: now, updatedAt: now };
  } catch {
    return null;
  }
}

/** Update any subset of a project's name/description. */
export function updateProjectRow(
  id: string,
  patch: { name?: string; description?: string | null },
): boolean {
  const d = getDb();
  if (!d) return false;
  const now = Date.now();
  const sets: string[] = ["updatedAt = ?"];
  const args: (string | number | null)[] = [now];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name.trim());
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    args.push(patch.description);
  }
  args.push(id);
  try {
    const r = d
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/**
 * Delete a project and its association rows, in one transaction.
 *
 * Nothing else is deleted: the sources it grouped and every row of their
 * monitoring history stay exactly as they are — they simply become ungrouped.
 */
export function deleteProjectRow(id: string): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    d.exec("BEGIN");
    const r = d.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    d.prepare(`DELETE FROM project_sources WHERE projectId = ?`).run(id);
    d.exec("COMMIT");
    return Number(r.changes) > 0;
  } catch {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Source associations
 * ------------------------------------------------------------------ */

export type AssociationRow = {
  projectId: string;
  sourceType: ProjectSourceType;
  sourceId: string;
  createdAt: number;
};

/** Every association in the store. null => the database is unavailable. */
export function listAssociations(): AssociationRow[] | null {
  const d = getDb();
  if (!d) return null;
  try {
    return d
      .prepare(
        `SELECT projectId, sourceType, sourceId, createdAt
           FROM project_sources ORDER BY createdAt ASC`,
      )
      .all() as unknown as AssociationRow[];
  } catch {
    return null;
  }
}

/** Associations belonging to one project. [] on DB failure. */
export function listProjectAssociations(projectId: string): AssociationRow[] {
  const d = getDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT projectId, sourceType, sourceId, createdAt
           FROM project_sources WHERE projectId = ? ORDER BY createdAt ASC`,
      )
      .all(projectId) as unknown as AssociationRow[];
  } catch {
    return [];
  }
}

/** Which project a source belongs to, or null when it is ungrouped. */
export function getAssociation(
  sourceType: ProjectSourceType,
  sourceId: string,
): AssociationRow | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d
      .prepare(
        `SELECT projectId, sourceType, sourceId, createdAt
           FROM project_sources WHERE sourceType = ? AND sourceId = ?`,
      )
      .get(sourceType, sourceId) as AssociationRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Put a source in a project, moving it there if it already belongs to another
 * one. The composite primary key makes this a single statement and makes the
 * one-project-per-source invariant structural: there is no way to write a second
 * membership row for the same source.
 */
export function associateSource(
  projectId: string,
  sourceType: ProjectSourceType,
  sourceId: string,
): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO project_sources (projectId, sourceType, sourceId, createdAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(sourceType, sourceId)
         DO UPDATE SET projectId = excluded.projectId, createdAt = excluded.createdAt`,
    ).run(projectId, sourceType, sourceId, Date.now());
    return true;
  } catch {
    return false;
  }
}

/** Remove a source from whichever project holds it. */
export function disassociateSource(
  sourceType: ProjectSourceType,
  sourceId: string,
): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(`DELETE FROM project_sources WHERE sourceType = ? AND sourceId = ?`)
      .run(sourceType, sourceId);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}
