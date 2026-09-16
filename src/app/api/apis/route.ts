import { getApiResults, type ApiCheckResult } from "@/lib/monitoring/apis";
import {
  readApiSummaries,
  DAY_MS,
  type ApiHistorySummary,
} from "@/lib/monitoring/api-storage";
import { ensureSchedulerStarted } from "@/lib/scheduler";
import { getLatestApis } from "@/lib/scheduler/store";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ApiHistory = Record<string, ApiHistorySummary>;

/**
 * GET /api/apis — the latest API check results plus 24h summaries.
 *
 * Nothing here triggers a check on demand: the scheduler's `apis` job owns the
 * cadence. The on-demand call is a cold-start fallback only, for the window
 * before the first scheduled run has produced anything.
 */
export async function GET() {
  try {
    ensureSchedulerStarted();

    const latest = getLatestApis();
    const results: ApiCheckResult[] = latest ? latest.value : await getApiResults();

    // 24h history from stored rows; empty (not an error) when the DB is absent.
    const history: ApiHistory = readApiSummaries(DAY_MS);

    const counts = { total: results.length, healthy: 0, degraded: 0, down: 0 };
    for (const r of results) counts[r.state]++;

    return Response.json(
      { generatedAt: Date.now(), results, counts, history },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "apis_unavailable" }, { status: 503 });
  }
}
