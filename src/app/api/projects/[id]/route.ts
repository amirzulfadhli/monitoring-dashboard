import { deleteProject, getProject, updateProject } from "@/lib/projects/service";
import { readJson } from "@/app/api/settings/helpers";

/**
 * One project: read, rename/re-describe, delete.
 *
 * GET returns the project with the sources it groups and their latest *stored*
 * state. It is a pure storage read — no collector runs and no monitored source
 * is contacted to render a project page.
 *
 * DELETE removes the project and its membership rows only. The sources it
 * grouped stay configured and every historical row stays where it is; they
 * simply become ungrouped.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error: string) => Response.json({ ok: false, error }, { status: 400 });
const notFound = (error: string) => Response.json({ ok: false, error }, { status: 404 });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const project = getProject(decodeURIComponent(id));
    if (!project) return notFound("Project not found.");
    return Response.json(
      { generatedAt: Date.now(), project },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "projects_unavailable" }, { status: 503 });
  }
}

/** PUT /api/projects/[id] — update name and/or description. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");

  const result = updateProject(decodeURIComponent(id), {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
  });
  return result.ok ? Response.json({ ok: true }) : bad(result.error);
}

/** DELETE /api/projects/[id] — remove the project; its sources become ungrouped. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = deleteProject(decodeURIComponent(id));
  return result.ok ? Response.json({ ok: true }) : notFound(result.error);
}
