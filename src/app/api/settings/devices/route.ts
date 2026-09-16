import { createDevice, removeDevice, updateDeviceFields } from "@/lib/settings/service";
import { bad, notFound, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Configuration for monitored devices.
 *
 * A device is a name, a host and a type. Hosts are validated and normalized
 * server-side before storage (see lib/settings/validate), so nothing that
 * reaches the DB — or later the collector's process invocation — can carry a
 * scheme, port, path, shell metacharacter or address range.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  const result = createDevice({
    name: typeof body.name === "string" ? body.name : "",
    host: typeof body.host === "string" ? body.host : "",
    ...(body.type !== undefined ? { type: body.type } : {}),
  });
  return result.ok ? ok(null) : bad(result.error);
}

/** PUT /api/settings/devices — update fields or enable/disable a device. */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");
  if (typeof body.id !== "string" || !body.id) return bad("id is required.");

  const patch: {
    name?: string;
    host?: string;
    type?: unknown;
    enabled?: boolean;
  } = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.host === "string") patch.host = body.host;
  if (body.type !== undefined) patch.type = body.type;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) return bad("Nothing to update.");

  const result = updateDeviceFields(body.id, patch);
  return result.ok ? ok(null) : bad(result.error);
}

/** DELETE /api/settings/devices?id=... — stop monitoring a device. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id is required.");
  const result = removeDevice(id);
  return result.ok ? ok(null) : notFound(result.error);
}
