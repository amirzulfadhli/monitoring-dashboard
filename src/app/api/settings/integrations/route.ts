/**
 * GET /api/settings/integrations
 *
 * Reports only whether each integration's credential is CONFIGURED (present in
 * the server environment). It never returns the secret, a prefix, a length, or
 * any masked portion — credentials are configured through .env.local / process
 * environment, never through this app or SQLite.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      github: { configured: !!process.env.GITHUB_TOKEN },
      deepseek: { configured: !!process.env.DEEPSEEK_API_KEY },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
