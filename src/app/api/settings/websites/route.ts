import {
  createWebsite,
  removeWebsite,
  updateWebsiteFields,
} from "@/lib/settings/service";
import { bad, notFound, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const toIntOrNull = (v: unknown): number | null | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined;

/** POST /api/settings/websites — create a monitored website. */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  const expectedStatus = toIntOrNull(body.expectedStatus);
  const result = await createWebsite({
    name: typeof body.name === "string" ? body.name : "",
    url: typeof body.url === "string" ? body.url : "",
    ...(expectedStatus !== undefined ? { expectedStatus } : {}),
  });
  return result.ok ? ok(null) : bad(result.error);
}

/** PUT /api/settings/websites — update fields or enable/disable a website. */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  if (typeof body.id !== "string" || !body.id) return bad("id is required.");

  const patch: {
    name?: string;
    url?: string;
    expectedStatus?: number | null;
    enabled?: boolean;
  } = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.url === "string") patch.url = body.url;
  if (body.expectedStatus !== undefined) {
    const s = toIntOrNull(body.expectedStatus);
    if (s === undefined) return bad("expectedStatus must be an integer or null.");
    patch.expectedStatus = s;
  }
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) return bad("Nothing to update.");

  const result = await updateWebsiteFields(body.id, patch);
  return result.ok ? ok(null) : bad(result.error);
}

/** DELETE /api/settings/websites?id=... — stop monitoring a website. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id is required.");
  const result = removeWebsite(id);
  return result.ok ? ok(null) : notFound(result.error);
}
