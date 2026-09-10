import { getGitHubResult } from "@/lib/monitoring/github";
import { persistGithubSnapshots } from "@/lib/monitoring/github-snapshots";
import { ensureSchedulerStarted } from "@/lib/scheduler";
import { getLatestGithub } from "@/lib/scheduler/store";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/github
 *
 * Serves the most recent scheduler-collected monitor result. Requesting this
 * endpoint (including from the GitHub page's own poll) no longer spends GitHub
 * API quota; the scheduler's cadence decides when GitHub is actually called.
 *
 * The live monitor run below is the cold-start fallback used only before the
 * first scheduled run has produced a result.
 */
export async function GET() {
  try {
    ensureSchedulerStarted();

    const latest = getLatestGithub();
    if (latest) {
      return Response.json(latest.value, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const result = await getGitHubResult();
    // After a successful monitor run, persist compact health snapshots. This is
    // the monitor's trigger point (mirrors /api/websites); a persistence failure
    // must never break the live result, so it is isolated.
    try {
      persistGithubSnapshots(result.repos);
    } catch {
      // Snapshot persistence is best-effort; live monitoring still succeeds.
    }
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "github_unavailable" }, { status: 503 });
  }
}
