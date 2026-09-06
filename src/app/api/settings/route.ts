import { getSettingsBundle } from "@/lib/settings/service";

// Server-only; the Settings page reads its full configuration here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/settings — full configuration bundle.
 *
 * This is a local-first, unauthenticated tool; the mutation routes below are
 * intentionally narrow and must not be treated as suitable for a public
 * internet deployment. Responses never contain API keys.
 */
export async function GET() {
  try {
    const bundle = getSettingsBundle();
    return Response.json(bundle, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "settings_unavailable" }, { status: 503 });
  }
}
