import { buildTimeline } from "@/lib/history";
import { HISTORY_RANGES, type HistoryRangeKey } from "@/lib/history/model";

// Unified history timeline; runs on the server against local persisted storage.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const range = (new URL(request.url).searchParams.get("range") ?? "24H") as HistoryRangeKey;
  if (!(range in HISTORY_RANGES)) {
    return Response.json({ error: "invalid_range" }, { status: 400 });
  }
  // Sources are already reduced and bounded; a per-source failure yields an
  // empty slice, never a dropped response — so this only 503s on an unexpected
  // error that escapes every guard.
  try {
    const events = buildTimeline(range);
    return Response.json(
      { range, count: events.length, events },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "history_unavailable" }, { status: 503 });
  }
}
