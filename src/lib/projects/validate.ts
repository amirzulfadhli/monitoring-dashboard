/**
 * Server-side validation for project mutations.
 *
 * Projects are a grouping layer, so the surface is small: a name, an optional
 * description, and a (type, id) pair naming an existing source. Bounds mirror
 * the existing Settings validators (see lib/settings/validate) so a project name
 * is refused for the same reasons a display name is.
 *
 * Every function returns an error string, or null when the input is valid.
 */

import { PROJECT_SOURCE_TYPES, type ProjectSourceType } from "./types";

/** Longest accepted project name. Matches the display-name bound used elsewhere. */
export const MAX_PROJECT_NAME_LENGTH = 120;
/** Longest accepted description. */
export const MAX_PROJECT_DESCRIPTION_LENGTH = 500;

export function validateProjectName(name: unknown): string | null {
  if (typeof name !== "string") return "Project name is required.";
  const n = name.trim();
  if (!n) return "Project name is required.";
  if (n.length > MAX_PROJECT_NAME_LENGTH) return "Project name is too long.";
  // Control characters would be invisible in the UI and unreproducible in a
  // URL-adjacent context; they are refused rather than stripped.
  if (/[\u0000-\u001f\u007f]/.test(n)) return "Project name contains invalid characters.";
  return null;
}

export function validateProjectDescription(description: unknown): string | null {
  if (description == null) return null; // optional
  if (typeof description !== "string") return "Description must be text.";
  if (description.trim().length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    return "Description is too long.";
  }
  return null;
}

/** A source type must be one of the four groupable kinds. */
export function validateSourceType(type: unknown): string | null {
  if (typeof type !== "string" || !(PROJECT_SOURCE_TYPES as readonly string[]).includes(type)) {
    return `Source type must be one of ${PROJECT_SOURCE_TYPES.join(", ")}.`;
  }
  return null;
}

/**
 * A source id is always the source's own persisted primary key — a uuid for
 * websites/apis/devices, `owner/repo` for repositories. It is never
 * re-interpreted, so the only check that matters is that it is a non-empty,
 * bounded string; existence is verified against the settings store by the
 * service layer.
 */
export function validateSourceId(id: unknown): string | null {
  if (typeof id !== "string") return "Source id is required.";
  const s = id.trim();
  if (!s) return "Source id is required.";
  if (s.length > 200) return "Source id is too long.";
  if (/[\u0000-\u001f\u007f]/.test(s)) return "Source id contains invalid characters.";
  return null;
}

export type SourceRefError = { error: string };

/**
 * Validate a (type, id) pair. Returns the narrowed type when valid, or an error
 * string. Kept as one helper so associate and disassociate cannot drift apart.
 */
export function validateSourceRef(
  type: unknown,
  id: unknown,
): { ok: true; type: ProjectSourceType; id: string } | { ok: false; error: string } {
  const byType = validateSourceType(type);
  if (byType) return { ok: false, error: byType };
  const byId = validateSourceId(id);
  if (byId) return { ok: false, error: byId };
  return { ok: true, type: type as ProjectSourceType, id: (id as string).trim() };
}
