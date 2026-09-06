/**
 * Small helpers for the Settings API. Mutations are validated server-side in
 * src/lib/settings (service + validate) — these routes are thin adapters that
 * never trust client shape beyond well-typed fields.
 */

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function ok(data: unknown) {
  return Response.json({ ok: true, ...(data ? { data } : {}) }, { status: 200 });
}

export function bad(message: string) {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export function notFound(message = "Not found") {
  return Response.json({ ok: false, error: message }, { status: 404 });
}
