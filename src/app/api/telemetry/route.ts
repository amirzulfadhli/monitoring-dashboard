import { collectTelemetry } from "@/lib/telemetry";
import { persistSnapshot } from "@/lib/telemetry/storage";

// Server-only collector; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await collectTelemetry();
    // Persist a row for historical monitoring. Guarded to ~30s inside storage;
    // a failure here must not affect the live response.
    const sys = snapshot.system;
    const net = snapshot.network;
    if (sys || net) {
      persistSnapshot({
        ts: snapshot.collectedAt,
        cpuPct: sys?.cpuUsagePct ?? null,
        usedMem: sys?.usedMem ?? null,
        availMem: sys?.availMem ?? null,
        rxRate: net?.rxRate ?? null,
        txRate: net?.txRate ?? null,
        rxTotal: net?.rxTotal ?? null,
        txTotal: net?.txTotal ?? null,
      });
    }
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "telemetry_unavailable" },
      { status: 503 },
    );
  }
}
