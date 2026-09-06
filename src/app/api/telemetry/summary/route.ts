import { readSummary } from "@/lib/telemetry/storage";

// Server-only aggregate over persisted history; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 86_400_000; // 24h — matches the Overview "Last 24 hours" panel

export async function GET() {
  try {
    const summary = readSummary(WINDOW_MS);
    return Response.json(
      { windowMs: WINDOW_MS, ...summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "history_unavailable" }, { status: 503 });
  }
}
