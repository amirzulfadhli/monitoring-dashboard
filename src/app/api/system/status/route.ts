import { ensureSchedulerStarted, getSchedulerStatus } from "@/lib/scheduler";

// Server-only; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/system/status
 *
 * Read-only monitoring/scheduler status: per-job last run, last success, last
 * error, run/skip/failure counts, and an overall freshness verdict for the
 * Overview indicator. No secrets are exposed (never the GitHub token itself).
 *
 * Calling this also guarantees the scheduler is running, which makes the
 * status endpoint a useful self-heal if the instrumentation hook did not run.
 */
export async function GET() {
  try {
    ensureSchedulerStarted();
    return Response.json(getSchedulerStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "status_unavailable" }, { status: 503 });
  }
}
