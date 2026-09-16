import { getDeviceResults, getLocalMachine, type DeviceCheckResult } from "@/lib/devices";
import { DAY_MS, readDeviceSummaries, type DeviceHistorySummary } from "@/lib/devices/storage";
import { ensureSchedulerStarted, getSchedulerStatus } from "@/lib/scheduler";
import { getLatestDevices } from "@/lib/scheduler/store";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type DeviceHistory = Record<string, DeviceHistorySummary>;

/**
 * GET /api/devices — the latest reachability results plus 24h summaries.
 *
 * Nothing here checks a device on demand: the scheduler's `devices` job owns the
 * cadence. The on-demand call is a cold-start fallback only, for the window
 * before the first scheduled run has produced anything.
 *
 * `collector` reports whether DevPulse is *able* to monitor devices at all, and
 * is read from the scheduler job rather than inferred from the results: an
 * unreachable device is an observation about that device, never a collector
 * failure, so the page can show "device unreachable" and "collector healthy" at
 * the same time.
 *
 * The local machine is described (hostname + platform) so the page can name this
 * host explicitly, but no CPU/memory/network data is served from here — that
 * continues to come from the telemetry API.
 */
export async function GET() {
  try {
    ensureSchedulerStarted();

    const latest = getLatestDevices();
    const results: DeviceCheckResult[] = latest
      ? latest.value
      : await getDeviceResults();

    // 24h history from stored rows; empty (not an error) when the DB is absent.
    const history: DeviceHistory = readDeviceSummaries(DAY_MS);

    const counts = { total: results.length, reachable: 0, unreachable: 0 };
    for (const r of results) {
      if (r.reachable) counts.reachable++;
      else counts.unreachable++;
    }

    const job = getSchedulerStatus().jobs.devices;
    const collector = {
      state: job.state,
      cadenceMs: job.cadenceMs,
      staleAfterMs: job.staleAfterMs,
      inactiveReason: job.inactiveReason,
      lastSuccessAt: job.lastSuccessAt,
      lastError: job.lastError,
    };

    return Response.json(
      {
        generatedAt: Date.now(),
        localMachine: getLocalMachine(),
        results,
        counts,
        history,
        collector,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "devices_unavailable" }, { status: 503 });
  }
}
