import { NOTIFICATION_LIMIT } from "@/lib/notifications/model";
import { countUnread, listRecentNotifications } from "@/lib/notifications/storage";
import { getNotificationSettings } from "@/lib/settings/service";

// Server-only; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications
 *
 * The notification inbox: a bounded list of recent notifications plus the unread
 * count. Read-only, and a pure storage read — it evaluates no rule, runs no
 * collector and triggers no desktop delivery, so polling it is free.
 *
 * The effective preferences are included so the inbox can explain an empty list
 * ("notifications are off" / "minimum severity is critical") instead of looking
 * broken. They contain no secrets.
 */
export async function GET() {
  try {
    const settings = getNotificationSettings();
    return Response.json(
      {
        generatedAt: Date.now(),
        limit: NOTIFICATION_LIMIT,
        unread: countUnread(),
        settings,
        notifications: listRecentNotifications(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Storage failure degrades to an empty inbox, never a 500.
    return Response.json(
      {
        generatedAt: Date.now(),
        limit: NOTIFICATION_LIMIT,
        unread: 0,
        notifications: [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
