/**
 * Persistence for the notification inbox.
 *
 * Lives in the same on-disk SQLite database as every other DevPulse table, in
 * its own `notifications` table (see lib/db/schema migration 7). It reads
 * nothing else: the alert lifecycle is what decides a transition, and this table
 * only records that one happened.
 *
 * Row identity is the deterministic id built by the service layer, so the
 * primary key — not a check-then-insert dance — is what makes repeated
 * evaluation idempotent.
 *
 * Every call is wrapped: an unavailable database degrades to an empty inbox or
 * a no-op write rather than breaking alert evaluation.
 */

import { getDb } from "@/lib/db";

import {
  NOTIFICATION_LIMIT,
  type NotificationRecord,
  type NotificationTransition,
} from "./model";
import type { AlertSource, Severity } from "@/lib/alerts/model";

type Row = {
  id: string;
  fingerprint: string;
  transition: string;
  source: string;
  severity: string;
  title: string;
  message: string;
  projectName: string | null;
  createdAt: number;
  readAt: number | null;
};

function toRecord(r: Row): NotificationRecord {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    transition: r.transition as NotificationTransition,
    source: r.source as AlertSource,
    severity: r.severity as Severity,
    title: r.title,
    message: r.message,
    projectName: r.projectName,
    createdAt: r.createdAt,
    readAt: r.readAt,
  };
}

/** The row shape the service hands to storage — id included, fully built. */
export type NewNotification = Omit<NotificationRecord, "readAt">;

/**
 * Store one notification. Returns true only when a row was actually created, so
 * the caller can tell a genuine transition from a re-evaluation of one it has
 * already recorded.
 */
export function insertNotification(n: NewNotification): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(
        `INSERT OR IGNORE INTO notifications
           (id, fingerprint, transition, source, severity, title, message,
            projectName, createdAt, readAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        n.id,
        n.fingerprint,
        n.transition,
        n.source,
        n.severity,
        n.title,
        n.message,
        n.projectName,
        n.createdAt,
      );
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/** Recent notifications, newest first. Bounded — there is no paging in V1. */
export function listRecentNotifications(limit = NOTIFICATION_LIMIT): NotificationRecord[] {
  const d = getDb();
  if (!d) return [];
  const bounded = Math.max(1, Math.min(Math.trunc(limit), NOTIFICATION_LIMIT));
  try {
    const rows = d
      .prepare(
        `SELECT id, fingerprint, transition, source, severity, title, message,
                projectName, createdAt, readAt
           FROM notifications
          ORDER BY createdAt DESC, id DESC
          LIMIT ?`,
      )
      .all(bounded) as unknown as Row[];
    return rows.map(toRecord);
  } catch {
    return [];
  }
}

/** How many notifications are still unread. 0 on DB failure. */
export function countUnread(): number {
  const d = getDb();
  if (!d) return 0;
  try {
    const r = d
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE readAt IS NULL`)
      .get() as { n: number } | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Mark one notification read. Idempotent: re-reading an already-read row is a
 * no-op rather than an error, so a double-click cannot fail.
 */
export function markRead(id: string, now: number): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const r = d
      .prepare(`UPDATE notifications SET readAt = ? WHERE id = ? AND readAt IS NULL`)
      .run(now, id);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/** Mark every unread notification read. Returns how many rows changed. */
export function markAllRead(now: number): number {
  const d = getDb();
  if (!d) return 0;
  try {
    const r = d
      .prepare(`UPDATE notifications SET readAt = ? WHERE readAt IS NULL`)
      .run(now);
    return Number(r.changes);
  } catch {
    return 0;
  }
}

/** Total stored notifications (verification / retention checks). */
export function countNotifications(): number {
  const d = getDb();
  if (!d) return 0;
  try {
    const r = d.prepare(`SELECT COUNT(*) AS n FROM notifications`).get() as
      | { n: number }
      | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}
