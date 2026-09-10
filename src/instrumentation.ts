/**
 * Next.js instrumentation hook — runs once per server process, before the
 * first request. This is where DevPulse's background monitoring scheduler is
 * started, so monitoring no longer depends on a dashboard tab being open.
 *
 * DevPulse V1 assumes a persistent Node process (`next dev` / `next start`).
 * There is no serverless deployment: an ephemeral runtime has no process
 * lifetime to schedule against, so background collection would silently stop.
 * See src/lib/scheduler/index.ts.
 */
export async function register(): Promise<void> {
  // Node runtime only; the scheduler drives OS sampling and SQLite.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureSchedulerStarted } = await import("./lib/scheduler");
  ensureSchedulerStarted();
}
