import {
  associateSourceToProject,
  disassociateSourceFromProject,
} from "@/lib/projects/service";
import { getAssociation } from "@/lib/projects/storage";
import { validateSourceRef } from "@/lib/projects/validate";
import { readJson } from "@/app/api/settings/helpers";

/**
 * Membership of one project.
 *
 * POST assigns an existing monitored source (website, repository, API or
 * device) to the project. A source already grouped elsewhere is *moved* — V1
 * allows at most one project per source.
 *
 * DELETE unassigns. The source keeps being monitored exactly as before; only the
 * grouping is removed. Neither verb creates, configures or checks a source, so
 * this cannot be used to add something to monitoring.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error: string) => Response.json({ ok: false, error }, { status: 400 });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");

  const result = associateSourceToProject(decodeURIComponent(id), body.type, body.id);
  return result.ok ? Response.json({ ok: true }) : bad(result.error);
}

/** DELETE /api/projects/[id]/sources?type=website&id=... — unassign a source. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const sourceId = url.searchParams.get("id");

  // The path names the project, so a source held by a *different* project is
  // not silently ungrouped through this URL.
  const ref = validateSourceRef(type, sourceId);
  if (!ref.ok) return bad(ref.error);
  if (getAssociation(ref.type, ref.id)?.projectId !== decodeURIComponent(id)) {
    return bad("Source is not assigned to this project.");
  }

  const result = disassociateSourceFromProject(ref.type, ref.id);
  return result.ok ? Response.json({ ok: true }) : bad(result.error);
}
