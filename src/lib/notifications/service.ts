/**
 * Notification service.
 *
 * The single entry point the alert lifecycle calls when something meaningful
 * changes. It is deliberately *not* a monitor: it never runs a rule, reads a
 * collector result or talks to the network. Its input is always a transition the
 * alert store has already committed, and its job is to record it once and, at
 * most, show a Windows toast about it.
 *
 * The lifecycle contract, in one place:
 *
 *   - The alert store calls `recordAlertTransition` only when a statement
 *     actually changed a row (a new alert, a recurrence, a severity increase or
 *     a resolution). A verdict that merely refreshes an unchanged, still-active
 *     alert calls nothing — that is what makes repeated evaluation idempotent.
 *   - The id derived from (fingerprint, transition, instant) is the table's
 *     primary key, so even a repeated call cannot produce a duplicate row.
 *   - Preferences are advisory to delivery only after that point: with
 *     notifications disabled nothing is stored, and with notifications enabled
 *     an alert below the minimum severity is not stored either.
 *   - Desktop delivery is strictly best-effort and is fired after the row is
 *     committed. A toast that fails to appear changes nothing about the alert,
 *     the notification or the scheduler.
 */

import type { AlertSource, Severity } from "@/lib/alerts/model";
import { getAssociation, getProjectRow } from "@/lib/projects/storage";
import { ALERT_SOURCE_TO_PROJECT_SOURCE } from "@/lib/projects/types";
import { getNotificationSettings } from "@/lib/settings/service";

import {
  meetsMinSeverity,
  notificationId,
  sanitizeNotificationText,
  shouldNotifyDesktop,
  type NotificationRecord,
  type NotificationTransition,
} from "./model";
import { insertNotification, type NewNotification } from "./storage";
import { sendWindowsToast } from "./windows";

/** The alert fields a notification is derived from — all already-sanitized. */
export type AlertTransitionInput = {
  fingerprint: string;
  source: AlertSource;
  severity: Severity;
  title: string;
  message: string;
  transition: NotificationTransition;
  /** Epoch ms the transition was observed. */
  at: number;
};

/* ------------------------------------------------------------------ *
 * Desktop delivery
 * ------------------------------------------------------------------ */

/** What a desktop sender receives. Only the two lines a toast can show. */
export type DesktopPayload = { title: string; message: string };

/** A desktop delivery attempt. May be sync or async, may throw or reject. */
export type DesktopSender = (payload: DesktopPayload) => void | Promise<void>;

// The Windows sender resolves to "was it shown", which is recorded nowhere: the
// inbox row is the durable record and the toast is a convenience on top of it.
const defaultDesktopSender: DesktopSender = async (payload) => {
  await sendWindowsToast(payload);
};

let desktopSender: DesktopSender = defaultDesktopSender;

/**
 * Replace the desktop sender. The default is the real Windows toast; tests
 * install a spy here so no verification run can ever display one.
 */
export function setDesktopSender(sender: DesktopSender): void {
  desktopSender = sender;
}

/** Restore the real Windows toast sender. */
export function resetDesktopSender(): void {
  desktopSender = defaultDesktopSender;
}

/**
 * Fire a desktop toast. Never awaited by the caller, never throws, and never
 * lets a rejection escape — a delivery failure must leave alert evaluation,
 * the scheduler and the persisted notification completely untouched.
 */
function deliverDesktop(payload: DesktopPayload): void {
  try {
    void Promise.resolve(desktopSender(payload)).catch(() => {
      // A failed toast is not an error worth surfacing: the inbox row is the
      // durable record, and the OS notification is a convenience on top of it.
    });
  } catch {
    // Same reasoning for a sender that throws synchronously.
  }
}

/* ------------------------------------------------------------------ *
 * Project context
 * ------------------------------------------------------------------ */

/**
 * The project the alert's source belongs to, or null when it is ungrouped or
 * machine-level. This is a *label* on the notification — it never creates a
 * second notification, and a project with three failing sources produces three
 * source notifications, not four.
 */
function projectNameFor(source: AlertSource, fingerprint: string): string | null {
  const type = ALERT_SOURCE_TO_PROJECT_SOURCE[source];
  if (!type) return null; // system / ai / security / storage are machine-level
  // Every source-level rule builds its fingerprint as
  // `<source>:<rule>:<sourceId>`, so the trailing segment is the source id.
  const sourceId = fingerprint.slice(fingerprint.lastIndexOf(":") + 1);
  if (!sourceId) return null;
  const association = getAssociation(type, sourceId);
  if (!association) return null;
  const project = getProjectRow(association.projectId);
  return project ? sanitizeNotificationText(project.name) || null : null;
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

/**
 * Record one alert lifecycle transition. Returns the stored notification, or
 * null when nothing was stored (notifications disabled, below the minimum
 * severity, a duplicate id, or an unavailable database).
 *
 * Never throws.
 */
export function recordAlertTransition(
  input: AlertTransitionInput,
): NotificationRecord | null {
  try {
    const settings = getNotificationSettings();
    if (!settings.enabled) return null;
    if (!meetsMinSeverity(settings, input.severity)) return null;

    const title = sanitizeNotificationText(input.title);
    const message = sanitizeNotificationText(input.message);
    if (!title) return null;

    const record: NewNotification = {
      id: notificationId(input.fingerprint, input.transition, input.at),
      fingerprint: input.fingerprint,
      transition: input.transition,
      source: input.source,
      severity: input.severity,
      title,
      message,
      projectName: projectNameFor(input.source, input.fingerprint),
      createdAt: input.at,
    };

    // The primary key is the idempotency guarantee: if this occurrence was
    // already recorded, no row is written and no toast is shown for it.
    if (!insertNotification(record)) return null;

    const stored: NotificationRecord = { ...record, readAt: null };

    // After the row is committed. The stored notification does not depend on
    // the toast appearing, and the toast never blocks the caller.
    if (
      process.platform === "win32" &&
      shouldNotifyDesktop(settings, input.transition, input.severity)
    ) {
      deliverDesktop({ title: stored.title, message: stored.message });
    }

    return stored;
  } catch {
    // Notification recording must never break alert evaluation.
    return null;
  }
}
