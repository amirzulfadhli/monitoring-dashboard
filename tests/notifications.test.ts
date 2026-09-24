/**
 * Notifications (Task 27).
 *
 * The behaviour a regression would actually hurt, pinned:
 *
 *   - a transition produces exactly one notification, and re-evaluating an
 *     unchanged condition produces none;
 *   - notifications come only from the alert lifecycle, never from a raw
 *     collector result;
 *   - the master switch, the minimum severity and the desktop switch are all
 *     honored, and a *failed* desktop delivery leaves the alert, the inbox and
 *     the caller untouched;
 *   - read/unread mutation and the unread count behave;
 *   - retention bounds the table;
 *   - nothing but sanitized alert text is ever stored, and project context is a
 *     label on the notification rather than a second notification.
 *
 * There are NO real Windows notifications here: the desktop sender is replaced
 * with an in-process spy for the whole file, so no test — and therefore no
 * verification run — can display a toast. There are likewise no network calls
 * and no AI calls anywhere in this file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate } from "../src/lib/db/schema";
import { closeDb } from "../src/lib/db/index";
import { applyVerdict } from "../src/lib/alerts/storage";
import { RULES, type RuleVerdict } from "../src/lib/alerts/model";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_LIMIT,
  sanitizeNotificationText,
  shouldNotifyDesktop,
  type NotificationSettings,
  type NotificationTransition,
} from "../src/lib/notifications/model";
import {
  countNotifications,
  countUnread,
  listRecentNotifications,
  markAllRead,
  markRead,
} from "../src/lib/notifications/storage";
import {
  recordAlertTransition,
  resetDesktopSender,
  setDesktopSender,
  type DesktopPayload,
} from "../src/lib/notifications/service";
import { insertWebsite } from "../src/lib/settings/storage";
import { saveNotificationSettings } from "../src/lib/settings/service";
import { pruneExpired } from "../src/lib/maintenance";
import { RETENTION_MS } from "../src/lib/maintenance/config";
import {
  buildToastScript,
  toastInvocation,
  encodeCommand,
  TOAST_BODY_ENV,
  TOAST_TITLE_ENV,
} from "../src/lib/notifications/windows";

/* ------------------------------ harness ------------------------------ */

/**
 * Install a desktop spy for the whole file *before* any test runs, so the real
 * Windows sender is never reachable from this process.
 */
const toasts: DesktopPayload[] = [];
let toastBehaviour: "ok" | "throw" | "reject" = "ok";

setDesktopSender((payload) => {
  toasts.push(payload);
  if (toastBehaviour === "throw") throw new Error("toast boom");
  if (toastBehaviour === "reject") return Promise.reject(new Error("toast boom"));
  return undefined;
});
test.after(() => resetDesktopSender());

/** A fresh database per test, in an OS temp directory. Never the real one. */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => void | Promise<void>,
): void | Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-notifications-"));
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = path.join(dir, DB_FILE_NAME);
  const db = new DatabaseSync(process.env.DEVPULSE_DB_PATH);
  migrate(db);
  t.after(() => {
    db.close();
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return fn(db);
}

/** Preferences for a test. Defaults to "everything on" so transitions record. */
function prefs(over: Partial<NotificationSettings> = {}): NotificationSettings {
  return { enabled: true, desktop: false, minSeverity: "warning", ...over };
}

/** A verdict shaped exactly like the ones the alert rules emit. */
function verdict(over: Partial<RuleVerdict> = {}): RuleVerdict {
  return {
    fingerprint: "websites:website_down:site-1",
    source: "websites",
    ruleId: RULES.WEBSITE_DOWN,
    severity: "critical",
    title: "Alpha is down",
    message: "The last check did not receive a response.",
    active: true,
    ...over,
  };
}

/** A healthy verdict for the same fingerprint — the resolution half. */
function healthy(over: Partial<RuleVerdict> = {}): RuleVerdict {
  return verdict({ active: false, severity: "info", ...over });
}

/** Install prefs directly in app_settings, the way the settings API does. */
function configure(p: NotificationSettings): void {
  const r = saveNotificationSettings(p);
  assert.equal(r.ok, true, "notification settings should persist");
}

function transitions(): string[] {
  return listRecentNotifications().map((n) => `${n.fingerprint}|${n.transition}`);
}

/* --------------------------- open / idempotency --------------------------- */

test("an opening alert creates exactly one notification", (t) =>
  withTempDb(t, () => {
    configure(prefs());
    const AT = 1_700_000_000_000;

    applyVerdict(verdict(), AT);

    const all = listRecentNotifications();
    assert.equal(all.length, 1);
    assert.equal(all[0].transition, "opened");
    assert.equal(all[0].severity, "critical");
    assert.equal(all[0].title, "Alpha is down");
    assert.equal(all[0].message, "The last check did not receive a response.");
    assert.equal(all[0].fingerprint, "websites:website_down:site-1");
    assert.equal(all[0].source, "websites");
    assert.equal(all[0].createdAt, AT);
    assert.equal(all[0].readAt, null);
    assert.equal(countUnread(), 1);
  }));

test("repeated evaluation of an unchanged alert creates no duplicate", (t) =>
  withTempDb(t, () => {
    configure(prefs());

    // Ten evaluation cycles of the same sustained condition. The alert store
    // refreshes one row each time; none of those refreshes is a transition.
    for (let i = 0; i < 10; i++) applyVerdict(verdict(), 1_700_000_000_000 + i * 30_000);

    assert.equal(countNotifications(), 1);
    assert.deepEqual(transitions(), ["websites:website_down:site-1|opened"]);
  }));

test("resolution creates exactly one notification", (t) =>
  withTempDb(t, () => {
    configure(prefs());
    const AT = 1_700_000_000_000;

    applyVerdict(verdict(), AT);
    applyVerdict(healthy(), AT + 30_000);

    const all = listRecentNotifications();
    assert.equal(all.length, 2);
    // Newest first: the resolution.
    assert.equal(all[0].transition, "resolved");
    // The resolution describes the alert that closed, not the healthy verdict
    // that closed it (whose own text describes the recovery).
    assert.equal(all[0].title, "Alpha is down");
    assert.equal(all[0].severity, "critical");
    assert.equal(all[1].transition, "opened");
  }));

test("repeated resolved evaluation creates no duplicate", (t) =>
  withTempDb(t, () => {
    configure(prefs());

    applyVerdict(verdict(), 1_700_000_000_000);
    for (let i = 0; i < 10; i++) applyVerdict(healthy(), 1_700_000_030_000 + i * 30_000);

    assert.equal(countNotifications(), 2, "one open + one resolve, ever");
  }));

test("a recurrence after a resolution opens a fresh notification", (t) =>
  withTempDb(t, () => {
    configure(prefs());

    applyVerdict(verdict(), 1_700_000_000_000);
    applyVerdict(healthy(), 1_700_000_030_000);
    applyVerdict(verdict(), 1_700_000_060_000);

    // Newest first: the re-opening is a new occurrence, not a duplicate of the
    // first one, so all three transitions are recorded.
    assert.deepEqual(transitions(), [
      "websites:website_down:site-1|opened",
      "websites:website_down:site-1|resolved",
      "websites:website_down:site-1|opened",
    ]);
  }));

test("a severity escalation creates one notification, a de-escalation none", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));

    applyVerdict(verdict({ severity: "warning" }), 1_700_000_000_000);
    // Still active, same severity: not a transition.
    applyVerdict(verdict({ severity: "warning" }), 1_700_000_030_000);
    // Worsens: a transition.
    applyVerdict(verdict({ severity: "critical" }), 1_700_000_060_000);
    // Improves while still open: deliberately not surfaced.
    applyVerdict(verdict({ severity: "warning" }), 1_700_000_090_000);

    // Newest first.
    assert.deepEqual(transitions(), [
      "websites:website_down:site-1|escalated",
      "websites:website_down:site-1|opened",
    ]);
  }));

/* ------------------------------ preferences ------------------------------ */

test("notifications disabled stores nothing at all", (t) =>
  withTempDb(t, () => {
    configure(prefs({ enabled: false }));

    applyVerdict(verdict(), 1_700_000_000_000);
    applyVerdict(healthy(), 1_700_000_030_000);

    assert.equal(countNotifications(), 0);
    assert.equal(toasts.length, 0);
  }));

test("minimum severity filters notifications", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "critical", desktop: true }));

    // Informational and warning alerts are below the bar — and `info` cannot
    // even be selected as a minimum, so informational events are silent by
    // construction.
    applyVerdict(verdict({ fingerprint: "a:b:1", severity: "info" }), 1_700_000_000_000);
    applyVerdict(verdict({ fingerprint: "a:b:2", severity: "warning" }), 1_700_000_030_000);
    assert.equal(countNotifications(), 0);

    applyVerdict(verdict({ fingerprint: "a:b:3", severity: "critical" }), 1_700_000_060_000);
    assert.equal(countNotifications(), 1);
    assert.equal(listRecentNotifications()[0].fingerprint, "a:b:3");
  }));

test("a warning-only minimum lets warnings through", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));

    applyVerdict(verdict({ severity: "warning" }), 1_700_000_000_000);
    applyVerdict(verdict({ fingerprint: "a:b:2", severity: "info" }), 1_700_000_030_000);

    assert.equal(countNotifications(), 1);
    assert.equal(listRecentNotifications()[0].severity, "warning");
  }));

test("the defaults are conservative", () => {
  assert.equal(DEFAULT_NOTIFICATION_SETTINGS.enabled, true);
  // No desktop toast until it is explicitly turned on.
  assert.equal(DEFAULT_NOTIFICATION_SETTINGS.desktop, false);
  // Only critical alerts notify out of the box.
  assert.equal(DEFAULT_NOTIFICATION_SETTINGS.minSeverity, "critical");
  // An informational event can never qualify, whatever else is configured.
  assert.equal(
    shouldNotifyDesktop(
      { enabled: true, desktop: true, minSeverity: "warning" },
      "opened",
      "info",
    ),
    false,
  );
});

/* --------------------------- desktop delivery --------------------------- */

test("desktop delivery is skipped when desktop notifications are disabled", (t) =>
  withTempDb(t, () => {
    configure(prefs({ desktop: false, minSeverity: "warning" }));
    toasts.length = 0;

    applyVerdict(verdict(), 1_700_000_000_000);

    assert.equal(countNotifications(), 1, "the inbox still records it");
    assert.equal(toasts.length, 0);
  }));

test("desktop delivery fires for a high-value open, never for a resolution", (t) =>
  withTempDb(t, () => {
    configure(prefs({ desktop: true, minSeverity: "critical" }));
    toasts.length = 0;

    applyVerdict(verdict(), 1_700_000_000_000);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, "Alpha is down");

    applyVerdict(healthy(), 1_700_000_030_000);
    assert.equal(toasts.length, 1, "a resolution never shows a toast");
  }));

test("desktop delivery is skipped below the minimum severity", (t) =>
  withTempDb(t, () => {
    configure(prefs({ desktop: true, minSeverity: "critical" }));
    toasts.length = 0;

    applyVerdict(verdict({ severity: "warning" }), 1_700_000_000_000);

    assert.equal(toasts.length, 0);
  }));

test("desktop delivery failure does not affect the alert or the inbox", (t) =>
  withTempDb(t, async (db) => {
    configure(prefs({ desktop: true, minSeverity: "critical" }));

    // One fingerprint per failure mode, so each scenario starts from nothing.
    const cases = [
      { behaviour: "throw", fingerprint: "websites:website_down:site-throw" },
      { behaviour: "reject", fingerprint: "websites:website_down:site-reject" },
    ] as const;

    for (const { behaviour, fingerprint } of cases) {
      toasts.length = 0;
      toastBehaviour = behaviour;

      const at = 1_700_000_000_000;
      // Must not throw, must not reject, must not roll anything back.
      assert.doesNotThrow(() => applyVerdict(verdict({ fingerprint }), at));

      const alert = db
        .prepare(`SELECT status, severity FROM alerts WHERE fingerprint = ?`)
        .get(fingerprint) as { status: string; severity: string };
      assert.equal(alert.status, "active", `alert survives a ${behaviour} sender`);

      const stored = listRecentNotifications().filter((n) => n.fingerprint === fingerprint);
      assert.equal(stored.length, 1, `inbox row survives a ${behaviour} sender`);
      assert.equal(stored[0].transition, "opened");

      // Let the rejected promise settle so nothing escapes as unhandled.
      await Promise.resolve();
      await Promise.resolve();

      // Resolution under a failing sender is unaffected too, and the scheduler
      // is untouched: the guard is that none of these calls ever threw.
      assert.doesNotThrow(() => applyVerdict(healthy({ fingerprint }), at + 30_000));
      const afterResolution = listRecentNotifications().filter(
        (n) => n.fingerprint === fingerprint,
      );
      assert.equal(afterResolution.length, 2);
      assert.equal(afterResolution[0].transition, "resolved");
    }

    toastBehaviour = "ok";
  }));

/* ------------------------------- read state ------------------------------- */

test("mark read and mark all read move the unread count", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));
    applyVerdict(verdict({ fingerprint: "a:b:1" }), 1_700_000_000_000);
    applyVerdict(verdict({ fingerprint: "a:b:2" }), 1_700_000_030_000);
    applyVerdict(verdict({ fingerprint: "a:b:3" }), 1_700_000_060_000);
    assert.equal(countUnread(), 3);

    const [newest] = listRecentNotifications();
    assert.equal(markRead(newest.id, 1_700_000_090_000), true);
    assert.equal(countUnread(), 2);

    // Idempotent: reading it again changes nothing and is not an error.
    assert.equal(markRead(newest.id, 1_700_000_090_001), false);
    assert.equal(countUnread(), 2);

    // An unknown id is a no-op rather than a throw.
    assert.equal(markRead("does-not-exist", 1_700_000_090_002), false);

    assert.equal(markAllRead(1_700_000_095_000), 2);
    assert.equal(countUnread(), 0);
    assert.equal(markAllRead(1_700_000_095_001), 0);

    // Reading does not delete anything.
    assert.equal(countNotifications(), 3);
  }));

test("the inbox is bounded to the most recent notifications", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));
    for (let i = 0; i < NOTIFICATION_LIMIT + 20; i++) {
      applyVerdict(verdict({ fingerprint: `a:b:${i}` }), 1_700_000_000_000 + i * 1_000);
    }

    assert.equal(countNotifications(), NOTIFICATION_LIMIT + 20, "all rows are stored");
    assert.equal(listRecentNotifications().length, NOTIFICATION_LIMIT, "reads are bounded");
    // Newest first.
    const recent = listRecentNotifications();
    assert.equal(recent[0].fingerprint, `a:b:${NOTIFICATION_LIMIT + 19}`);
  }));

/* ------------------------------- retention ------------------------------- */

test("retention prunes old notifications and keeps recent ones", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));
    const now = 1_800_000_000_000;
    const old = now - RETENTION_MS.notifications - 60_000;
    const recent = now - 60_000;

    applyVerdict(verdict({ fingerprint: "a:b:old" }), old);
    applyVerdict(verdict({ fingerprint: "a:b:recent" }), recent);

    assert.equal(countNotifications(), 2);
    pruneExpired(now);

    const left = listRecentNotifications();
    assert.equal(left.length, 1);
    assert.equal(left[0].fingerprint, "a:b:recent");
  }));

/* -------------------------- provenance and safety -------------------------- */

test("no notification is created from raw collector data", (t) =>
  withTempDb(t, (db) => {
    configure(prefs({ minSeverity: "warning" }));

    // A raw collector result landing in its history table is *not* an alert and
    // must produce nothing: the alert lifecycle is the only trigger.
    db.prepare(
      `INSERT INTO website_checks (ts, targetId, state, httpStatus, latencyMs, errorType, error)
       VALUES (?, 'site-1', 'down', NULL, NULL, 'timeout', 'no response')`,
    ).run(1_700_000_000_000);
    db.prepare(
      `INSERT INTO device_checks (ts, deviceId, reachable, latencyMs, errorType, error)
       VALUES (?, 'dev-1', 0, NULL, 'timeout', 'no reply')`,
    ).run(1_700_000_000_000);

    assert.equal(countNotifications(), 0);
    assert.equal(countUnread(), 0);

    // Only the lifecycle emits — and only the transition, not each evaluation.
    applyVerdict(verdict(), 1_700_000_001_000);
    assert.equal(countNotifications(), 1);
  }));

test("only sanitized alert text is stored", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));

    // A hypothetical future rule leaking control characters / an over-long blob.
    const nasty = `line one\nline two\t\u0007 ${"x".repeat(1000)}`;
    applyVerdict(verdict({ title: nasty, message: nasty }), 1_700_000_000_000);

    const [n] = listRecentNotifications();
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(n.title));
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(n.message));
    assert.ok(n.title.length <= 300);
    assert.ok(n.message.length <= 300);
    assert.ok(n.title.startsWith("line one line two"));

    assert.equal(sanitizeNotificationText("  a\n b  "), "a b");
    assert.equal(sanitizeNotificationText(undefined), "");
    assert.ok(sanitizeNotificationText("y".repeat(500)).endsWith("…"));
  }));

test("sanitizing strips control characters and nothing wider", () => {
  // The class is exactly C0 + DEL + C1. It used to be written with a raw byte
  // for U+009F, which in a UTF-8 source became two code units and widened the
  // range to U+007f-U+00C2 — so ordinary accented letters were blanked too.
  for (const c of ["\u0000", "\u0007", "\u001f", "\u007f", "\u0080", "\u009f"]) {
    assert.equal(
      sanitizeNotificationText(`x${c}y`),
      "x y",
      `U+${c.codePointAt(0)!.toString(16)} must be stripped`,
    );
  }
  for (const c of ["Â", "é", "—", "中"]) {
    assert.equal(
      sanitizeNotificationText(`x${c}y`),
      `x${c}y`,
      `U+${c.codePointAt(0)!.toString(16)} is text, not control, and must survive`,
    );
  }
  // A non-breaking space is whitespace, so the collapse rule flattens it —
  // wider than the control class, but that predates and is unrelated to it.
  assert.equal(sanitizeNotificationText("x y"), "x y");
});

test("project context is a label, not a second notification", (t) =>
  withTempDb(t, (db) => {
    configure(prefs({ minSeverity: "warning" }));

    const siteId = insertWebsite({
      name: "Alpha",
      url: "https://example.com/",
      expectedStatus: null,
    })!.id;

    const now = Date.now();
    const projectId = "p-1";
    db.prepare(
      `INSERT INTO projects (id, name, description, createdAt, updatedAt)
       VALUES (?, 'Storefront', NULL, ?, ?)`,
    ).run(projectId, now, now);
    db.prepare(
      `INSERT INTO project_sources (projectId, sourceType, sourceId, createdAt)
       VALUES (?, 'website', ?, ?)`,
    ).run(projectId, siteId, now);

    applyVerdict(
      verdict({ fingerprint: `websites:website_down:${siteId}` }),
      1_700_000_000_000,
    );

    const all = listRecentNotifications();
    assert.equal(all.length, 1, "one notification, not one per project");
    assert.equal(all[0].projectName, "Storefront");

    // Ungrouped and machine-level sources carry no project, and still notify.
    applyVerdict(verdict({ fingerprint: "websites:website_down:un-grouped" }), 1_700_000_030_000);
    applyVerdict(
      verdict({ fingerprint: "system:cpu_high:x", source: "system" }),
      1_700_000_060_000,
    );
    const byFingerprint = new Map(listRecentNotifications().map((n) => [n.fingerprint, n]));
    assert.equal(byFingerprint.get("websites:website_down:un-grouped")?.projectName, null);
    assert.equal(byFingerprint.get("system:cpu_high:x")?.projectName, null);
  }));

/* ------------------------- windows toast delivery ------------------------- */

test("toast content travels in the environment, never in argv or the script", () => {
  const malicious = {
    title: "'; Remove-Item -Recurse C:\\ #",
    message: "$(Get-Process) & <script>alert(1)</script>",
  };

  const a = toastInvocation({ title: "safe", message: "safe" });
  const b = toastInvocation(malicious);

  // The script and the argv are byte-identical whatever the payload is: there
  // is no path by which content can become PowerShell.
  assert.deepEqual(a.args, b.args);
  assert.equal(a.args[3], encodeCommand(buildToastScript()));
  assert.ok(!b.args.some((arg) => arg.includes("Remove-Item")));

  // The script is a constant that never contains the content.
  assert.ok(!buildToastScript().includes("Remove-Item"));
  assert.ok(!buildToastScript().includes("<script>"));
  // Nor does it build the command by interpolating anything from the payload.
  assert.equal(buildToastScript(), buildToastScript());

  // The payload is carried as data in two clearly-named environment variables.
  assert.equal(b.env[TOAST_TITLE_ENV], malicious.title);
  assert.equal(b.env[TOAST_BODY_ENV], malicious.message);
  assert.deepEqual(Object.keys(b.env).sort(), [TOAST_BODY_ENV, TOAST_TITLE_ENV].sort());
});

test("toast fields are flattened and bounded, and encoding is UTF-16LE base64", () => {
  const inv = toastInvocation({ title: "a\nb\u0007c", message: "z".repeat(500) });
  assert.equal(inv.env[TOAST_TITLE_ENV], "a b c");
  assert.equal(inv.env[TOAST_BODY_ENV].length, 200);

  const encoded = encodeCommand("hi");
  assert.equal(encoded, Buffer.from("hi", "utf16le").toString("base64"));
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "hi");
});

test("the toast script escapes content inside the markup", () => {
  const script = buildToastScript();
  // Content is XML-escaped before it is placed in the toast document.
  assert.ok(script.includes("[System.Security.SecurityElement]::Escape($t)"));
  assert.ok(script.includes("[System.Security.SecurityElement]::Escape($b)"));
  // And it is read from the environment, not from argv.
  assert.ok(script.includes(`$env:${TOAST_TITLE_ENV}`));
  assert.ok(script.includes(`$env:${TOAST_BODY_ENV}`));
});

/* -------------------------- direct service call -------------------------- */

test("recordAlertTransition can be driven directly and is idempotent", (t) =>
  withTempDb(t, () => {
    configure(prefs({ minSeverity: "warning" }));
    const base = {
      fingerprint: "apis:api_down:target-9",
      source: "apis" as const,
      severity: "critical" as const,
      title: "Prod API is down",
      message: "The last check did not receive a response.",
      transition: "opened" as NotificationTransition,
      at: 1_700_000_000_000,
    };

    assert.ok(recordAlertTransition(base));
    // Same occurrence, same instant: absorbed by the primary key.
    assert.equal(recordAlertTransition(base), null);
    assert.equal(countNotifications(), 1);

    // A different instant is a different occurrence.
    assert.ok(recordAlertTransition({ ...base, at: base.at + 1 }));
    assert.equal(countNotifications(), 2);

    // Disabled: nothing is recorded even for a fresh occurrence.
    configure(prefs({ enabled: false }));
    assert.equal(recordAlertTransition({ ...base, at: base.at + 2 }), null);
    assert.equal(countNotifications(), 2);
  }));
