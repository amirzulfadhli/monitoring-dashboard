import { evaluateAlerts, listAlerts } from "@/lib/alerts/engine";
import type { AlertQueryStatus } from "@/lib/alerts/storage";
import { ensureSchedulerStarted } from "@/lib/scheduler";

// Server-only; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/alerts?status=active|resolved|all
 *
 * The scheduler evaluates alerts on its own cadence; this route serves the
 * stored state. `evaluateAlerts()` stays as the cold-start fallback and is
 * itself guarded to a modest interval, so a request returns fast and never
 * performs a live external fetch (rules run over persisted source state).
 * Only the three whitelisted status values are accepted — no arbitrary
 * SQL/filter expressions are ever exposed.
 */
export async function GET(req: Request) {
  try {
    ensureSchedulerStarted();

    const url = new URL(req.url);
    const raw = (url.searchParams.get("status") ?? "active").toLowerCase();
    const status: AlertQueryStatus =
      raw === "resolved" ? "resolved" : raw === "all" ? "all" : "active";

    // Runs the guarded evaluation (idempotent within its interval), then serves
    // the stored state. Defaults to active.
    const counts = await evaluateAlerts();
    const alerts = listAlerts(status);

    return Response.json(
      { status, generatedAt: Date.now(), counts, alerts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Persistence/evaluation failure must degrade gracefully, not 500.
    return Response.json(
      {
        status: "active",
        generatedAt: Date.now(),
        counts: { active: 0, critical: 0, warning: 0, info: 0, resolvedRecent: 0 },
        alerts: [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
