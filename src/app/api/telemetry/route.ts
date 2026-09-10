import { collectTelemetry } from "@/lib/telemetry";
import { persistSnapshot } from "@/lib/telemetry/storage";
import { ensureSchedulerStarted } from "@/lib/scheduler";
import { getLatestTelemetry } from "@/lib/scheduler/store";

// Server-only collector; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/telemetry
 *
 * Serves the most recent scheduler-collected snapshot. Browser polling is a
 * read of already-captured state and never spawns a fresh OS collection, so
 * N open tabs cannot multiply PowerShell/OS sampling.
 *
 * The collector is only invoked here as a cold-start fallback (the scheduler's
 * first sample lands ~2s after boot).
 */
export async function GET() {
  try {
    ensureSchedulerStarted();

    const latest = getLatestTelemetry();
    if (latest) {
      return Response.json(latest.value, {
        headers: { "Cache-Control": "no-store" },
      });
    }

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
