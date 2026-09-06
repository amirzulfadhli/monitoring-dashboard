import { getState } from "@/lib/intelligence/service";

// Read-only: reflects the latest persisted analysis. Never runs a model call,
// so page loads and polling can render an existing brief at zero AI cost.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = getState();
  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
}
