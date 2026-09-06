import { getGitHubResult } from "@/lib/monitoring/github";
import { persistGithubSnapshots } from "@/lib/monitoring/github-snapshots";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
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
