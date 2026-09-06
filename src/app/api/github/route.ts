import { getGitHubResult } from "@/lib/monitoring/github";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getGitHubResult();
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "github_unavailable" }, { status: 503 });
  }
}
