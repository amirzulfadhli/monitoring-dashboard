import { createProject, listProjects } from "@/lib/projects/service";
import { readJson } from "@/app/api/settings/helpers";

/**
 * Project grouping.
 *
 * A project is a label over sources DevPulse already monitors. Nothing here
 * checks, fetches or collects anything: GET serves persisted configuration plus
 * the latest *stored* state of each grouped source, so opening a project never
 * costs a network call to anything it groups.
 *
 * Persistence failures degrade to an empty list rather than a 500 — projects are
 * an organizational layer and must never be able to break the dashboard.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** GET /api/projects — every project with its source counts and status summary. */
export async function GET() {
  try {
    const projects = listProjects();
    return Response.json({ generatedAt: Date.now(), count: projects.length, projects }, noStore);
  } catch {
    return Response.json({ generatedAt: Date.now(), count: 0, projects: [] }, noStore);
  }
}

/** POST /api/projects — create a project. */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  const result = createProject({
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
  });
  return result.ok
    ? Response.json({ ok: true }, { status: 200 })
    : Response.json({ ok: false, error: result.error }, { status: 400 });
}
