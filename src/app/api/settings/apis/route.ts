import {
  createApi,
  removeApi,
  updateApiFields,
} from "@/lib/settings/service";
import { bad, notFound, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const toIntOrNull = (v: unknown): number | null | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined;

/** POST /api/settings/apis — create a monitored API endpoint. */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  const expectedStatus = toIntOrNull(body.expectedStatus);
  const timeoutMs = toIntOrNull(body.timeoutMs);
  const result = await createApi({
    name: typeof body.name === "string" ? body.name : "",
    url: typeof body.url === "string" ? body.url : "",
    method: typeof body.method === "string" ? body.method : "GET",
    ...(expectedStatus !== undefined ? { expectedStatus } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return result.ok ? ok(null) : bad(result.error);
}

/** PUT /api/settings/apis — update fields or enable/disable an API monitor. */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  if (typeof body.id !== "string" || !body.id) return bad("id is required.");

  const patch: {
    name?: string;
    url?: string;
    method?: string;
    expectedStatus?: number | null;
    timeoutMs?: number | null;
    enabled?: boolean;
  } = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.url === "string") patch.url = body.url;
  if (typeof body.method === "string") patch.method = body.method;
  if (body.expectedStatus !== undefined) {
    const s = toIntOrNull(body.expectedStatus);
    if (s === undefined) return bad("expectedStatus must be an integer or null.");
    patch.expectedStatus = s;
  }
  if (body.timeoutMs !== undefined) {
    const t = toIntOrNull(body.timeoutMs);
    if (t === undefined) return bad("timeoutMs must be an integer or null.");
    patch.timeoutMs = t;
  }
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) return bad("Nothing to update.");

  const result = await updateApiFields(body.id, patch);
  return result.ok ? ok(null) : bad(result.error);
}

/** DELETE /api/settings/apis?id=... — stop monitoring an API endpoint. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id is required.");
  const result = removeApi(id);
  return result.ok ? ok(null) : notFound(result.error);
}
