import {
  createRepository,
  removeRepository,
  updateRepositoryFields,
} from "@/lib/settings/service";
import { bad, notFound, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/settings/repositories — add a monitored repository. */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  const result = await createRepository({
    owner: typeof body.owner === "string" ? body.owner : "",
    repo: typeof body.repo === "string" ? body.repo : "",
    displayName: typeof body.displayName === "string" ? body.displayName : "",
  });
  return result.ok ? ok(null) : bad(result.error);
}

/** PUT /api/settings/repositories — update or enable/disable a repository. */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  if (typeof body.id !== "string" || !body.id) return bad("id is required.");

  const patch: {
    owner?: string;
    repo?: string;
    displayName?: string;
    enabled?: boolean;
  } = {};
  if (typeof body.owner === "string") patch.owner = body.owner;
  if (typeof body.repo === "string") patch.repo = body.repo;
  if (typeof body.displayName === "string") patch.displayName = body.displayName;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) return bad("Nothing to update.");

  const result = await updateRepositoryFields(body.id, patch);
  return result.ok ? ok(null) : bad(result.error);
}

/** DELETE /api/settings/repositories?id=... — stop monitoring a repository. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id is required.");
  const result = removeRepository(id);
  return result.ok ? ok(null) : notFound(result.error);
}
