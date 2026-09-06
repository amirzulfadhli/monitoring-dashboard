import { readRange } from "@/lib/telemetry/storage";

// Historical telemetry; runs on the server against local storage.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Range windows and a target point budget so responses stay small: raw
// 30s points for short ranges, averaged buckets (downsampling) for long ones.
const RANGES = {
  "1H": { ms: 3_600_000, maxPoints: 240 },
  "24H": { ms: 86_400_000, maxPoints: 240 },
  "7D": { ms: 604_800_000, maxPoints: 240 },
  "30D": { ms: 2_592_000_000, maxPoints: 240 },
} as const;

export type RangeKey = keyof typeof RANGES;

export async function GET(request: Request) {
  const range = new URL(request.url).searchParams.get("range") ?? "1H";
  const cfg = RANGES[range as RangeKey];
  if (!cfg) {
    return Response.json({ error: "invalid_range" }, { status: 400 });
  }
  try {
    const points = readRange(cfg.ms, cfg.maxPoints);
    // Only fields the graph needs. Missing history returns an empty array,
    // which the page renders as an empty state rather than fabricating data.
    return Response.json(
      { range, points },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "history_unavailable" },
      { status: 503 },
    );
  }
}
