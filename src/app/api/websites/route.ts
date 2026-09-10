import { getWebsiteResults, type CheckResult } from "@/lib/monitoring/websites";
import {
  readWebsiteSummaries,
  DAY_MS,
  type SiteHistorySummary,
} from "@/lib/monitoring/storage";
import { ensureSchedulerStarted } from "@/lib/scheduler";
import { getLatestWebsites } from "@/lib/scheduler/store";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type WebsiteHistory = Record<string, SiteHistorySummary>;

export async function GET() {
  try {
    ensureSchedulerStarted();

    // Current results come from the last scheduled check run. Requesting this
    // endpoint no longer triggers a fresh set of site checks; the scheduler's
    // own cadence drives them. The on-demand check is a cold-start fallback
    // only (before the first scheduled run has produced anything).
    const latest = getLatestWebsites();
    const results: CheckResult[] = latest
      ? latest.value
      : await getWebsiteResults();

    // 24h history from stored samples. Independent of the live check: if the
    // DB is unavailable this is just empty, and the live results still return.
    const history: WebsiteHistory = readWebsiteSummaries(DAY_MS);

    const counts = { total: results.length, healthy: 0, degraded: 0, down: 0 };
    for (const r of results) counts[r.state]++;

    return Response.json(
      { generatedAt: Date.now(), results, counts, history },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "websites_unavailable" },
      { status: 503 },
    );
  }
}
