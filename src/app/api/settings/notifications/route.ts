import {
  getNotificationSettings,
  saveNotificationSettings,
} from "@/lib/settings/service";
import type { NotificationSettings } from "@/lib/notifications/model";
import { bad, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Parse the three-scalar preference triplet. Returns undefined when the body is
 * not a complete, correctly-typed object — a partial patch is refused rather
 * than merged, so the persisted value is always one consistent set.
 */
function parseSettings(v: unknown): NotificationSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  if (typeof s.enabled !== "boolean" || typeof s.desktop !== "boolean") return undefined;
  if (typeof s.minSeverity !== "string") return undefined;
  return {
    enabled: s.enabled,
    desktop: s.desktop,
    minSeverity: s.minSeverity as NotificationSettings["minSeverity"],
  };
}

/** GET /api/settings/notifications — the effective preferences. */
export async function GET() {
  return ok(getNotificationSettings());
}

/**
 * PUT /api/settings/notifications — persist the preference triplet.
 * Server-side validation in lib/settings rejects anything outside the two
 * supported minimum severities, so the client cannot widen notification scope.
 */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");

  const parsed = parseSettings(body.notifications ?? body);
  if (!parsed) return bad("Provide 'enabled', 'desktop' and 'minSeverity'.");

  const result = saveNotificationSettings(parsed);
  if (!result.ok) return bad(result.error);
  return ok(getNotificationSettings());
}
