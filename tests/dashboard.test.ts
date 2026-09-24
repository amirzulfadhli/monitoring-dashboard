/**
 * Overview customization (Task 31).
 *
 * DevPulse's Overview is a fixed set of sections the user may hide and reorder —
 * not a widget canvas. What a regression would actually hurt, and what is pinned
 * here:
 *
 *   - the default layout is every section, in the Task 30 order;
 *   - show/hide and move up/down behave, including at the ends of the list;
 *   - a persisted order survives a round trip through storage;
 *   - a preference is untrusted input: unknown ids are dropped (never rendered),
 *     duplicates keep their first entry, and anything malformed falls back to the
 *     default dashboard rather than an empty one;
 *   - a *hide everything* preference is honored, not silently undone;
 *   - a section added after a preference was saved appears rather than vanishing;
 *   - the settings API refuses anything but a complete list of known ids.
 *
 * Pure functions plus one temp-database round trip. No network, no AI calls, and
 * the real `.devpulse/telemetry.db` is never opened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { closeDb, getDb } from "../src/lib/db/index";
import {
  DASHBOARD_SECTIONS,
  DASHBOARD_SECTION_IDS,
  canMoveSection,
  dashboardSectionMeta,
  defaultDashboardLayout,
  isDashboardSectionId,
  isSectionVisible,
  moveSection,
  normalizeDashboardLayout,
  setSectionVisible,
  validateDashboardLayout,
  visibleSectionIds,
  type DashboardSectionId,
} from "../src/lib/dashboard/model";
import {
  readDashboardLayoutValue,
  writeDashboardLayoutValue,
} from "../src/lib/settings/storage";
import { getDashboardLayout, saveDashboardLayout } from "../src/lib/settings/service";

/** The order Task 30 rendered the Overview in; the default must reproduce it. */
const TASK_30_ORDER: DashboardSectionId[] = [
  "metrics",
  "details",
  "collectors",
  "projects",
  "history",
  "intelligence",
];

/* --------------------------- default layout --------------------------- */

test("default layout shows every registered section in the Task 30 order", () => {
  const layout = defaultDashboardLayout();
  assert.deepEqual(
    layout.sections.map((s) => s.id),
    TASK_30_ORDER,
  );
  assert.ok(layout.sections.every((s) => s.visible));
  assert.deepEqual(visibleSectionIds(layout), TASK_30_ORDER);
});

test("the registry has no duplicate ids and every id has a label", () => {
  assert.equal(new Set(DASHBOARD_SECTION_IDS).size, DASHBOARD_SECTION_IDS.length);
  for (const id of DASHBOARD_SECTION_IDS) {
    assert.ok(dashboardSectionMeta(id)?.label, `missing label for ${id}`);
    assert.ok(isDashboardSectionId(id));
  }
});

/* ------------------------------ show / hide ------------------------------ */

test("hiding a section removes it from what renders, keeping the rest", () => {
  const layout = setSectionVisible(defaultDashboardLayout(), "details", false);
  assert.equal(isSectionVisible(layout, "details"), false);
  assert.deepEqual(visibleSectionIds(layout), [
    "metrics",
    "collectors",
    "projects",
    "history",
    "intelligence",
  ]);
  // The hidden section keeps its place in the stored order.
  assert.equal(layout.sections.length, DASHBOARD_SECTION_IDS.length);
});

test("showing a hidden section puts it back where it was", () => {
  const hidden = setSectionVisible(defaultDashboardLayout(), "details", false);
  const shown = setSectionVisible(hidden, "details", true);
  assert.deepEqual(visibleSectionIds(shown), TASK_30_ORDER);
});

test("an unknown id is refused by the show/hide setter", () => {
  const layout = defaultDashboardLayout();
  const next = setSectionVisible(layout, "nope" as DashboardSectionId, false);
  assert.equal(next, layout, "an unknown id must leave the layout untouched");
});

/* -------------------------------- ordering -------------------------------- */

test("move up swaps with the previous section", () => {
  const layout = moveSection(defaultDashboardLayout(), "details", -1);
  assert.deepEqual(
    layout.sections.map((s) => s.id),
    ["details", "metrics", "collectors", "projects", "history", "intelligence"],
  );
});

test("move down swaps with the next section", () => {
  const layout = moveSection(defaultDashboardLayout(), "metrics", 1);
  assert.deepEqual(
    layout.sections.map((s) => s.id),
    ["details", "metrics", "collectors", "projects", "history", "intelligence"],
  );
});

test("the first section cannot move up and the last cannot move down", () => {
  const layout = defaultDashboardLayout();
  assert.equal(canMoveSection(layout, "metrics", -1), false);
  assert.equal(canMoveSection(layout, "intelligence", 1), false);
  assert.equal(moveSection(layout, "metrics", -1), layout);
  assert.equal(moveSection(layout, "intelligence", 1), layout);
});

test("a move steps over hidden sections, since only shown ones have a position", () => {
  // History sits between projects and intelligence and is not on screen, so
  // moving intelligence up must swap it with projects.
  const hidden = setSectionVisible(defaultDashboardLayout(), "history", false);
  const moved = moveSection(hidden, "intelligence", -1);
  assert.deepEqual(visibleSectionIds(moved), [
    "metrics",
    "details",
    "collectors",
    "intelligence",
    "projects",
  ]);
});

/* ------------------------- persisted order round trip ------------------------- */

test("a saved order and visibility survive normalization unchanged", () => {
  let layout = defaultDashboardLayout();
  layout = moveSection(layout, "intelligence", -1);
  layout = setSectionVisible(layout, "metrics", false);

  const roundTripped = normalizeDashboardLayout(JSON.parse(JSON.stringify(layout)));
  assert.deepEqual(roundTripped, layout);
  assert.deepEqual(visibleSectionIds(roundTripped), [
    "details",
    "collectors",
    "projects",
    "intelligence",
    "history",
  ]);
});

/* ------------------------------ untrusted input ------------------------------ */

test("unknown section ids are dropped, never treated as a component", () => {
  const layout = normalizeDashboardLayout({
    sections: [
      { id: "metrics", visible: true },
      { id: "../../../etc/passwd", visible: true },
      { id: "<script>alert(1)</script>", visible: true },
      { id: "IntelligencePanel", visible: true },
      { id: "history", visible: false },
    ],
  });
  // The known entries are kept; the intruders are gone, and every id that
  // survives is one the registry owns.
  assert.deepEqual(
    layout.sections.map((s) => s.id).slice(0, 2),
    ["metrics", "history"],
  );
  for (const s of layout.sections) assert.ok(isDashboardSectionId(s.id));
  // Sections the attacker omitted are appended, shown — never silently lost.
  assert.deepEqual(visibleSectionIds(layout), [
    "metrics",
    "details",
    "collectors",
    "projects",
    "intelligence",
  ]);
});

test("duplicate ids keep their first entry", () => {
  const layout = normalizeDashboardLayout({
    sections: [
      { id: "history", visible: false },
      { id: "history", visible: true },
      { id: "metrics", visible: true },
    ],
  });
  assert.deepEqual(
    layout.sections.map((s) => s.id),
    ["history", "metrics", "details", "collectors", "projects", "intelligence"],
  );
  assert.equal(isSectionVisible(layout, "history"), false);
});

test("malformed preferences fall back to the default dashboard", () => {
  const defaults = TASK_30_ORDER;
  for (const bad of [
    null,
    undefined,
    42,
    "metrics,details",
    [],
    {},
    { sections: "not-an-array" },
    { sections: null },
    { sections: [null, 7, "metrics", {}] },
    { sections: [{ id: "unknown", visible: true }] },
    { sections: [{ visible: true }] },
  ]) {
    const layout = normalizeDashboardLayout(bad);
    assert.deepEqual(
      visibleSectionIds(layout),
      defaults,
      `expected the default dashboard for ${JSON.stringify(bad)}`,
    );
  }
});

test("a non-boolean visibility is treated as shown rather than hidden", () => {
  const layout = normalizeDashboardLayout({
    sections: [{ id: "metrics", visible: "false" }],
  });
  assert.equal(isSectionVisible(layout, "metrics"), true);
});

test("a section added after a preference was saved is appended, shown", () => {
  // An older install saved only the four sections that existed then.
  const older = normalizeDashboardLayout({
    sections: [
      { id: "metrics", visible: true },
      { id: "collectors", visible: false },
      { id: "history", visible: true },
      { id: "intelligence", visible: true },
    ],
  });
  assert.equal(older.sections.length, DASHBOARD_SECTION_IDS.length);
  // Nothing new is hidden by appearing, and the saved choices are intact.
  assert.deepEqual(visibleSectionIds(older), [
    "metrics",
    "history",
    "intelligence",
    "details",
    "projects",
  ]);
});

/* ---------------------------- hide everything ---------------------------- */

test("hiding every section is honored, not silently undone", () => {
  let layout = defaultDashboardLayout();
  for (const id of DASHBOARD_SECTION_IDS) layout = setSectionVisible(layout, id, false);

  const stored = normalizeDashboardLayout(JSON.parse(JSON.stringify(layout)));
  assert.equal(stored.sections.length, DASHBOARD_SECTION_IDS.length);
  assert.ok(stored.sections.every((s) => !s.visible));
  assert.deepEqual(visibleSectionIds(stored), [], "the Overview must render no sections");
});

/* ------------------------------ API validation ------------------------------ */

test("the API accepts a complete, well-formed layout", () => {
  assert.equal(validateDashboardLayout(defaultDashboardLayout()), null);

  let custom = defaultDashboardLayout();
  custom = setSectionVisible(custom, "projects", false);
  custom = moveSection(custom, "history", -1);
  assert.equal(validateDashboardLayout(JSON.parse(JSON.stringify(custom))), null);
});

test("the API refuses anything but a complete list of known ids", () => {
  const cases: unknown[] = [
    null,
    "metrics",
    [],
    {},
    { sections: {} },
    { sections: [{ id: "unknown", visible: true }] },
    { sections: [{ id: "metrics", visible: "yes" }] },
    { sections: [{ id: "metrics" }] },
    { sections: [{ id: "metrics", visible: true }, { id: "metrics", visible: false }] },
    { sections: [{ id: "metrics", visible: true }] }, // incomplete
  ];
  for (const bad of cases) {
    assert.ok(
      validateDashboardLayout(bad) !== null,
      `expected a refusal for ${JSON.stringify(bad)}`,
    );
  }
});

/* --------------------------- storage round trip --------------------------- */

/** An isolated temp database, closed and removed when the test finishes. */
function tempDb(t: { after: (fn: () => void) => void }): void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-dashboard-"));
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = path.join(dir, DB_FILE_NAME);
  t.after(() => {
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** Write a raw value straight into `app_settings`, as a stale build might have. */
function writeRawLayout(value: string): void {
  const db = getDb();
  assert.ok(db, "the temp database should be open");
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('dashboard.layout', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(value);
}

test("a fresh install reads the default layout and stores nothing", (t) => {
  tempDb(t);
  assert.equal(readDashboardLayoutValue(), null);
  assert.deepEqual(visibleSectionIds(getDashboardLayout()), TASK_30_ORDER);
});

test("a saved layout round-trips through app_settings", (t) => {
  tempDb(t);

  let custom = defaultDashboardLayout();
  custom = moveSection(custom, "intelligence", -1);
  custom = setSectionVisible(custom, "collectors", false);

  assert.deepEqual(saveDashboardLayout(JSON.parse(JSON.stringify(custom))), { ok: true });
  assert.deepEqual(getDashboardLayout(), custom);
});

test("a refused save leaves the stored layout untouched", (t) => {
  tempDb(t);
  const before = getDashboardLayout();

  const result = saveDashboardLayout({
    sections: [{ id: "not-a-section", visible: true }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(getDashboardLayout(), before);
});

test("a corrupted stored preference degrades to a usable dashboard", (t) => {
  tempDb(t);

  for (const raw of [
    "{not json at all",
    "null",
    '"metrics"',
    "[]",
    '{"sections":[{"id":"../../etc/passwd","visible":true}]}',
    '{"sections":[{"id":"metrics";"visible":true}]}',
  ]) {
    writeRawLayout(raw);
    const layout = getDashboardLayout();
    assert.ok(layout.sections.length > 0, `empty dashboard for ${raw}`);
    assert.deepEqual(visibleSectionIds(layout), TASK_30_ORDER, `bad fallback for ${raw}`);
  }
});

test("a hand-written hide-everything preference is still honored", (t) => {
  tempDb(t);
  writeRawLayout(JSON.stringify(defaultDashboardLayout()).replace(/"visible":true/g, '"visible":false'));
  assert.deepEqual(visibleSectionIds(getDashboardLayout()), []);
});

test("an unavailable settings database degrades to the default dashboard", (t) => {
  // A path that cannot exist: its parent is a *file*, not a directory, so the
  // database can neither be created nor opened.
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-dashboard-"));
  const blocker = path.join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = path.join(blocker, DB_FILE_NAME);
  t.after(() => {
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(getDb(), null, "the configured path must not be openable");
  assert.equal(readDashboardLayoutValue(), null);
  assert.equal(writeDashboardLayoutValue(defaultDashboardLayout()), false);
  // Reads still answer with the default layout rather than an empty dashboard.
  assert.deepEqual(visibleSectionIds(getDashboardLayout()), TASK_30_ORDER);
});

/* ------------------------------ registry shape ------------------------------ */

test("every registry entry is a plain id label and description", () => {
  for (const s of DASHBOARD_SECTIONS) {
    assert.equal(typeof s.id, "string");
    assert.equal(typeof s.label, "string");
    assert.equal(typeof s.description, "string");
    // A section is never named by anything that could be read as a path or URL.
    assert.match(s.id, /^[a-z][a-z0-9-]*$/);
  }
});

test("normalization never mutates the value it was given", () => {
  const input = { sections: [{ id: "history", visible: false }] };
  const snapshot = JSON.stringify(input);
  normalizeDashboardLayout(input);
  assert.equal(JSON.stringify(input), snapshot);
});
