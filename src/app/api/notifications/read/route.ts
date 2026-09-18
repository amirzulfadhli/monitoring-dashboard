import { countUnread, markAllRead, markRead } from "@/lib/notifications/storage";
import { bad, ok, readJson } from "@/app/api/settings/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/read
 *
 * Body: `{ "id": "<notification id>" }` to mark one read, or `{ "all": true }`
 * to mark every unread notification read. Both are idempotent, so a retry or a
 * double-click is a no-op rather than an error.
 *
 * The only accepted input is an id (used solely as a bound SQL parameter) or the
 * literal `all` flag — no filter expression, no list of ids and no arbitrary
 * column is ever taken from the request.
 *
 * The response returns the new unread count so the caller never has to re-fetch
 * the whole inbox just to update a badge.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");

  const now = Date.now();
  try {
    if (body.all === true) {
      const changed = markAllRead(now);
      return ok({ changed, unread: countUnread() });
    }

    if (typeof body.id === "string" && body.id.length > 0 && body.id.length <= 512) {
      const changed = markRead(body.id, now);
      return ok({ changed, unread: countUnread() });
    }

    return bad("Provide a notification 'id' or 'all: true'.");
  } catch {
    return bad("Could not update notifications.");
  }
}
