import { getDashboardLayout, saveDashboardLayout } from "@/lib/settings/service";
import { bad, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/settings/dashboard — the effective (normalized) Overview layout. */
export async function GET() {
  return ok(getDashboardLayout());
}

/**
 * PUT /api/settings/dashboard — persist which Overview sections are shown, and
 * in what order.
 *
 * The body is `{ dashboard: { sections: [{ id, visible }] } }` (a bare layout is
 * also accepted). Validation in lib/settings/dashboard rejects anything but a
 * complete list of known section ids, so a preference can never name a component
 * or carry anything but a section id and a boolean.
 */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");

  const result = saveDashboardLayout(body.dashboard ?? body);
  if (!result.ok) return bad(result.error);
  return ok(getDashboardLayout());
}
