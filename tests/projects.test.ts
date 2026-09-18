/**
 * Project grouping (Task 25).
 *
 * These tests pin the behavior a regression would actually hurt: that a project
 * is only ever a label over sources DevPulse already monitors, that the
 * one-project-per-source rule is structural rather than conventional, that
 * deleting a project (or unassigning a source) leaves every source and every
 * historical row exactly where it was, that reading a project never reaches the
 * network, and that History labels events with the source's current project
 * without rewriting or duplicating a single event.
 *
 * There are NO real network calls here: every read runs against a fresh OS temp
 * database, and the one test that could plausibly fetch instead fails the global
 * `fetch` first. The real `.devpulse/telemetry.db` is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate, SCHEMA_VERSION } from "../src/lib/db/schema";
import { closeDb } from "../src/lib/db/index";
import {
  insertApi,
  insertDevice,
  insertRepository,
  insertWebsite,
  listApis,
  listDevices,
  listWebsites,
} from "../src/lib/settings/storage";
import { removeDevice, removeWebsite } from "../src/lib/settings/service";
import { persistWebsiteCheck, readWebsiteChecks } from "../src/lib/monitoring/storage";
import { applyVerdict } from "../src/lib/alerts/storage";
import {
  associateSourceToProject,
  createProject,
  deleteProject,
  disassociateSourceFromProject,
  getProject,
  listProjects,
  projectMembership,
  updateProject,
} from "../src/lib/projects/service";
import {
  getAssociation,
  listAssociations,
  listProjectRows,
} from "../src/lib/projects/storage";
import {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  validateProjectName,
  validateSourceRef,
} from "../src/lib/projects/validate";
import { buildTimeline } from "../src/lib/history";

const HOUR = 3_600_000;

/* ------------------------------ harness ------------------------------ */

/** Run `fn` against a fresh temp database. The real DB is never touched. */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => void,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-projects-"));
  const file = path.join(dir, DB_FILE_NAME);
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = file;
  const db = new DatabaseSync(file);
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

/**
 * A configured website with a fixed id, so a test can attach check history to
 * it. Real configuration mints a uuid (insertWebsite); history fixtures simply
 * need a stable target id.
 */
function website(db: DatabaseSync, id: string, name = "Storefront"): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO monitored_websites (id, name, url, expectedStatus, enabled, createdAt, updatedAt)
     VALUES (?, ?, 'https://example.com/', NULL, 1, ?, ?)`,
  ).run(id, name, now, now);
  return id;
}

/** Create a project and return its id. */
function project(name: string, description: string | null = null): string {
  const result = createProject({ name, description });
  assert.ok(result.ok, `project fixture ${name} must be created`);
  const row = (listProjectRows() ?? []).find((p) => p.name === name);
  assert.ok(row, `project fixture ${name} must be readable`);
  return row.id;
}

/* ------------------------------- schema ------------------------------- */

test("schema: projects migration is additive and versioned", (t) => {
  withTempDb(t, (db) => {
    // The project migration is v6; the schema has since moved on (v7 adds the
    // notification inbox), so the pin is on this migration having run, not on
    // the build's current version number.
    assert.ok(SCHEMA_VERSION >= 6);
    const version = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);

    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(tables.includes("projects"));
    assert.ok(tables.includes("project_sources"));
    // Nothing pre-existing was dropped or replaced by the migration.
    for (const t2 of ["history", "website_checks", "api_checks", "device_checks", "alerts"]) {
      assert.ok(tables.includes(t2), `${t2} must survive the migration`);
    }

    // The invariant is structural: (sourceType, sourceId) is the primary key.
    const pk = (
      db.prepare(`PRAGMA table_info(project_sources)`).all() as { name: string; pk: number }[]
    )
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    assert.deepEqual(pk, ["sourceType", "sourceId"]);
  });
});

test("schema: an existing database migrates in place without losing rows", (t) => {
  withTempDb(t, (db) => {
    // Simulate a version-5 database: stamp it back and confirm re-migration is
    // additive only (no table is recreated, no row is removed).
    db.prepare(
      `INSERT INTO monitored_websites (id, name, url, expectedStatus, enabled, createdAt, updatedAt)
       VALUES ('w-keep', 'Kept', 'https://example.com/', NULL, 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO website_checks (ts, targetId, state, httpStatus, latencyMs, errorType, error)
       VALUES (1, 'w-keep', 'healthy', 200, 12, NULL, NULL)`,
    ).run();
    db.exec(`PRAGMA user_version = 5`);
    migrate(db);

    const sites = listWebsites() ?? [];
    assert.equal(sites.length, 1);
    assert.equal(sites[0].id, "w-keep");
    assert.equal(readWebsiteChecks(0).length, 1);
  });
});

/* --------------------------------- CRUD -------------------------------- */

test("crud: create, list, read and update a project", (t) => {
  withTempDb(t, (db) => {
    const created = createProject({ name: " Storefront ", description: " Customer-facing " });
    assert.ok(created.ok);

    const rows = listProjectRows() ?? [];
    assert.equal(rows.length, 1);
    const p = rows[0];
    // Names and descriptions are stored trimmed.
    assert.equal(p.name, "Storefront");
    assert.equal(p.description, "Customer-facing");
    assert.ok(p.createdAt > 0 && p.updatedAt > 0);

    const summaries = listProjects();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].sources.total, 0);
    // A project with nothing grouped is unknown — never healthy.
    assert.equal(summaries[0].health.state, "unknown");
    assert.equal(summaries[0].health.counts.total, 0);

    const detail = getProject(p.id);
    assert.ok(detail);
    assert.deepEqual(detail.sources, []);
    assert.deepEqual(detail.unassigned, []);

    assert.ok(updateProject(p.id, { name: "Checkout" }).ok);
    assert.ok(updateProject(p.id, { description: null }).ok);
    const after = getProject(p.id);
    assert.equal(after?.name, "Checkout");
    assert.equal(after?.description, null);
    assert.ok((after?.updatedAt ?? 0) >= p.updatedAt);
  });
});

test("crud: invalid names and descriptions are refused", (t) => {
  withTempDb(t, (db) => {
    assert.equal(createProject({ name: "" }).ok, false);
    assert.equal(createProject({ name: "   " }).ok, false);
    assert.equal(createProject({ name: 42 }).ok, false);
    assert.equal(createProject({ name: "x".repeat(MAX_PROJECT_NAME_LENGTH + 1) }).ok, false);
    assert.equal(createProject({ name: "bad\u0000name" }).ok, false);
    assert.equal(
      createProject({ name: "ok", description: "d".repeat(MAX_PROJECT_DESCRIPTION_LENGTH + 1) })
        .ok,
      false,
    );
    assert.equal(validateProjectName("Fine name"), null);
    assert.equal(validateProjectName("x".repeat(MAX_PROJECT_NAME_LENGTH)), null);

    // Nothing invalid was persisted.
    assert.deepEqual(listProjectRows(), []);
  });
});

test("crud: duplicate names are refused, case-insensitively", (t) => {
  withTempDb(t, (db) => {
    assert.ok(createProject({ name: "Storefront" }).ok);

    const dup = createProject({ name: "storefront" });
    assert.equal(dup.ok, false);
    assert.match(dup.ok === false ? dup.error : "", /already exists/i);
    assert.equal(createProject({ name: "  STOREFRONT  " }).ok, false);
    assert.equal(listProjectRows()?.length, 1);

    // A project may keep its own name on update...
    const id = (listProjectRows() ?? [])[0].id;
    assert.ok(updateProject(id, { name: "Storefront" }).ok);
    // ...but may not take another's.
    assert.ok(createProject({ name: "Checkout" }).ok);
    const other = (listProjectRows() ?? []).find((p) => p.name === "Checkout");
    assert.ok(other);
    const clash = updateProject(other.id, { name: "STOREFRONT" });
    assert.equal(clash.ok, false);
  });
});

test("crud: unknown projects are reported, not silently created", (t) => {
  withTempDb(t, (db) => {
    assert.equal(getProject("nope"), null);
    assert.equal(updateProject("nope", { name: "x" }).ok, false);
    assert.equal(deleteProject("nope").ok, false);
    assert.equal(associateSourceToProject("nope", "website", "w-1").ok, false);
  });
});

/* ----------------------------- associations ---------------------------- */

test("associate: a configured source can be grouped, and only an existing one", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    insertWebsite({ name: "Shop", url: "https://example.com/", expectedStatus: null });
    const siteId = (listWebsites() ?? [])[0].id;

    const result = associateSourceToProject(pid, "website", siteId);
    assert.ok(result.ok);

    const detail = getProject(pid);
    assert.equal(detail?.sources.length, 1);
    assert.equal(detail?.sources[0].id, siteId);
    assert.equal(detail?.sources[0].type, "website");
    assert.equal(detail?.sources[0].name, "Shop");
    assert.equal(detail?.counts.website, 1);
    // No observation has been stored, so the state is unknown — never invented.
    assert.equal(detail?.sources[0].health, "unknown");
    assert.equal(detail?.sources[0].checkedAt, null);

    // An id that names nothing is refused rather than stored as a dangling label.
    const missing = associateSourceToProject(pid, "website", "no-such-site");
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.error : "", /not found/i);

    // So is a source kind no project may group.
    assert.equal(associateSourceToProject(pid, "storage", "C:").ok, false);
    assert.equal(associateSourceToProject(pid, "system", "local").ok, false);
    assert.equal(associateSourceToProject(pid, "", siteId).ok, false);
  });
});

test("associate: one project per source — reassignment moves, never duplicates", (t) => {
  withTempDb(t, (db) => {
    const a = project("Storefront");
    const b = project("Internal tools");
    insertWebsite({ name: "Shop", url: "https://example.com/", expectedStatus: null });
    const siteId = (listWebsites() ?? [])[0].id;

    assert.ok(associateSourceToProject(a, "website", siteId).ok);
    assert.equal(getAssociation("website", siteId)?.projectId, a);

    // Reassigning moves it.
    assert.ok(associateSourceToProject(b, "website", siteId).ok);
    assert.equal(getAssociation("website", siteId)?.projectId, b);
    assert.equal(listAssociations()?.length, 1, "a source holds exactly one membership");
    assert.equal(getProject(a)?.sources.length, 0);
    assert.equal(getProject(b)?.sources.length, 1);

    // Assigning it to where it already is stays a no-op success, not a duplicate.
    assert.ok(associateSourceToProject(b, "website", siteId).ok);
    assert.equal(listAssociations()?.length, 1);
  });
});

test("associate: all four groupable source kinds are supported", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Everything");
    insertWebsite({ name: "Shop", url: "https://example.com/", expectedStatus: null });
    insertApi({
      name: "Checkout API",
      url: "https://api.example.com/health",
      method: "GET",
      expectedStatus: null,
      timeoutMs: null,
    });
    insertDevice({ name: "Build server", host: "build-01.local", type: "server" });
    insertRepository({ owner: "acme", repo: "shop", displayName: "Shop repo" });

    const ids = {
      website: (listWebsites() ?? [])[0].id,
      api: (listApis() ?? [])[0].id,
      device: (listDevices() ?? [])[0].id,
      repository: "acme/shop",
    };
    for (const [type, id] of Object.entries(ids)) {
      const r = associateSourceToProject(pid, type, id);
      assert.ok(r.ok, `${type} must be associable`);
    }

    const detail = getProject(pid);
    assert.deepEqual(detail?.counts, {
      total: 4,
      website: 1,
      repository: 1,
      api: 1,
      device: 1,
    });
    // Devices are addressed by host, repositories by owner/repo, in the UI.
    const device = detail?.sources.find((s) => s.type === "device");
    assert.equal(device?.detail, "build-01.local");
    const repo = detail?.sources.find((s) => s.type === "repository");
    assert.equal(repo?.detail, "acme/shop");
    assert.equal(repo?.name, "Shop repo");
  });
});

test("unassign: a source leaves the project and keeps being monitored", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    insertWebsite({ name: "Shop", url: "https://example.com/", expectedStatus: null });
    const siteId = (listWebsites() ?? [])[0].id;
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    const off = disassociateSourceFromProject("website", siteId);
    assert.ok(off.ok);
    assert.equal(getAssociation("website", siteId), null);
    assert.equal(getProject(pid)?.sources.length, 0);

    // The source is still configured, and still offered for assignment.
    assert.equal(listWebsites()?.length, 1);
    assert.equal(getProject(pid)?.unassigned.length, 1);

    // Unassigning again is an error, not a silent success.
    assert.equal(disassociateSourceFromProject("website", siteId).ok, false);
    assert.equal(disassociateSourceFromProject("website", "").ok, false);
  });
});

test("unassign: removing a source from Settings clears its membership", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    insertWebsite({ name: "Shop", url: "https://example.com/", expectedStatus: null });
    const siteId = (listWebsites() ?? [])[0].id;
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    assert.ok(removeWebsite(siteId).ok);

    // No dangling membership is left behind, and the project survives.
    assert.equal(listAssociations()?.length, 0);
    assert.equal(listProjectRows()?.length, 1);
    assert.equal(getProject(pid)?.sources.length, 0);

    // Same for a device.
    insertDevice({ name: "Build", host: "build-01.local", type: "server" });
    const deviceId = (listDevices() ?? [])[0].id;
    assert.ok(associateSourceToProject(pid, "device", deviceId).ok);
    assert.ok(removeDevice(deviceId).ok);
    assert.equal(listAssociations()?.length, 0);
  });
});

/* ------------------------------- deletion ------------------------------ */

test("delete: removing a project keeps every source, grouped nowhere", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    insertWebsite({ name: "Shop", url: "https://example.com/", expectedStatus: null });
    insertDevice({ name: "Build", host: "build-01.local", type: "server" });
    const siteId = (listWebsites() ?? [])[0].id;
    const deviceId = (listDevices() ?? [])[0].id;
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);
    assert.ok(associateSourceToProject(pid, "device", deviceId).ok);

    assert.ok(deleteProject(pid).ok);

    assert.equal(listProjectRows()?.length, 0);
    assert.equal(listAssociations()?.length, 0);
    // The sources themselves are untouched and keep working ungrouped.
    assert.equal(listWebsites()?.length, 1);
    assert.equal(listDevices()?.length, 1);
    assert.equal(getProject(pid), null);
  });
});

test("delete: monitoring history survives the project it was grouped under", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    const siteId = website(db, "w-history");
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    const now = Date.now();
    persistWebsiteCheck({
      ts: now - 2 * HOUR,
      targetId: siteId,
      state: "healthy",
      httpStatus: 200,
      latencyMs: 10,
      errorType: null,
      error: null,
    });
    persistWebsiteCheck({
      ts: now - HOUR,
      targetId: siteId,
      state: "down",
      httpStatus: null,
      latencyMs: null,
      errorType: "timeout",
      error: "timed out",
    });
    const before = readWebsiteChecks(0);
    assert.equal(before.length, 2);

    assert.ok(deleteProject(pid).ok);

    // Byte-for-byte the same rows, still attached to the same target.
    assert.deepEqual(readWebsiteChecks(0), before);
    assert.equal(listWebsites()?.length, 1);
  });
});

/* ------------------------- reads touch no network ---------------------- */

test("read: a project page never collects, checks or fetches anything", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    const siteId = website(db, "w-net");
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    // A real check would have to go through fetch (or the collector). Any
    // attempt to reach out while rendering is a failure, not a slow page.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("project reads must not perform network I/O");
    }) as typeof globalThis.fetch;
    try {
      const detail = getProject(pid);
      assert.ok(detail);
      assert.equal(detail.sources.length, 1);
      // No stored observation exists, so the state is honestly unknown.
      assert.equal(detail.sources[0].health, "unknown");
      // Derived project health says the same thing, and says why.
      assert.equal(listProjects()[0].health.state, "unknown");
      assert.deepEqual(listProjects()[0].health.counts, {
        total: 1,
        healthy: 0,
        warn: 0,
        critical: 0,
        unknown: 1,
      });
      assert.match(detail.health.reasons[0].message, /has no monitoring data$/);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Once an observation *is* stored, the same read reports it — proving the
    // state comes from persisted rows rather than from a fresh probe.
    persistWebsiteCheck({
      ts: Date.now(),
      targetId: siteId,
      state: "down",
      httpStatus: 503,
      latencyMs: null,
      errorType: "unexpected_status",
      error: "503",
    });
    globalThis.fetch = (() => {
      throw new Error("project reads must not perform network I/O");
    }) as typeof globalThis.fetch;
    try {
      assert.equal(getProject(pid)?.sources[0].health, "critical");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("read: existing alerts for a grouped source surface; machine alerts do not", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    const siteId = website(db, "w-alert");
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    const now = Date.now();
    applyVerdict(
      {
        fingerprint: `websites:down:${siteId}`,
        source: "websites",
        ruleId: "website_down",
        severity: "critical",
        title: "Website down",
        message: "not responding",
        active: true,
      },
      now,
    );
    // An alert about something no project can group.
    applyVerdict(
      {
        fingerprint: "system:cpu_high",
        source: "system",
        ruleId: "cpu_high",
        severity: "warning",
        title: "CPU usage high",
        message: "sustained",
        active: true,
      },
      now,
    );

    const alerts = getProject(pid)?.alerts ?? [];
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].fingerprint, `websites:down:${siteId}`);

    // Task 25 defines no project-level rule: the alert set is exactly the
    // source-level alerts that already existed.
    const alertsAfterUnassign = (() => {
      assert.ok(disassociateSourceFromProject("website", siteId).ok);
      return getProject(pid)?.alerts ?? [];
    })();
    assert.equal(alertsAfterUnassign.length, 0);
  });
});

/* --------------------------- history labelling ------------------------- */

test("history: events carry their source's current project, unrewritten", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    const siteId = website(db, "w-timeline");
    const now = Date.now();

    persistWebsiteCheck({
      ts: now - 3 * HOUR,
      targetId: siteId,
      state: "healthy",
      httpStatus: 200,
      latencyMs: 10,
      errorType: null,
      error: null,
    });
    persistWebsiteCheck({
      ts: now - 2 * HOUR,
      targetId: siteId,
      state: "down",
      httpStatus: null,
      latencyMs: null,
      errorType: "timeout",
      error: "timed out",
    });

    // The transition exists before any project does: it carries no project.
    const ungrouped = buildTimeline("24H").filter((e) => e.source === "website");
    assert.equal(ungrouped.length, 1);
    assert.equal(ungrouped[0].metadata?.projectId, undefined);
    const baseline = { ...ungrouped[0] };

    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    const grouped = buildTimeline("24H").filter((e) => e.source === "website");
    assert.equal(grouped.length, 1);
    // Same event — same id, same timestamp, same description. Only a label was
    // added; nothing was rewritten, duplicated or re-timestamped.
    assert.equal(grouped[0].id, baseline.id);
    assert.equal(grouped[0].ts, baseline.ts);
    assert.equal(grouped[0].description, baseline.description);
    assert.equal(grouped[0].metadata?.projectId, pid);
    assert.equal(grouped[0].metadata?.projectName, "Storefront");

    // LIMITATION, asserted deliberately: the event happened before the
    // association, yet carries it — DevPulse stores only the current
    // membership, not membership as of the event. Representing the latter would
    // need event-sourced association history, which Task 25 does not add.
    const row = (listProjectRows() ?? [])[0];
    assert.ok(grouped[0].ts < row.createdAt);

    // Membership is exposed for filtering, and is dropped on unassignment.
    assert.equal(projectMembership().get(`website:${siteId}`)?.id, pid);
    assert.ok(disassociateSourceFromProject("website", siteId).ok);
    assert.equal(projectMembership().size, 0);
    const after = buildTimeline("24H").filter((e) => e.source === "website");
    assert.equal(after[0].metadata?.projectId, undefined);
  });
});

test("history: machine-level events are never project-labelled", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    const siteId = website(db, "w-mixed");
    assert.ok(associateSourceToProject(pid, "website", siteId).ok);

    const now = Date.now();
    applyVerdict(
      {
        fingerprint: "system:cpu_high",
        source: "system",
        ruleId: "cpu_high",
        severity: "warning",
        title: "CPU usage high",
        message: "sustained",
        active: true,
      },
      now,
    );

    const events = buildTimeline("24H");
    const machine = events.filter((e) => e.source === "alert");
    assert.ok(machine.length >= 1);
    for (const e of machine) {
      assert.equal(e.metadata?.projectId, undefined);
    }
  });
});

/* ------------------------------ validation ----------------------------- */

test("validation: source refs reject unknown kinds and unsafe ids", () => {
  assert.deepEqual(validateSourceRef("website", "w-1"), {
    ok: true,
    type: "website",
    id: "w-1",
  });
  assert.equal(validateSourceRef("storage", "C:").ok, false);
  assert.equal(validateSourceRef("website", "").ok, false);
  assert.equal(validateSourceRef("website", null).ok, false);
  assert.equal(validateSourceRef("website", "a".repeat(201)).ok, false);
  assert.equal(validateSourceRef("website", "bad\u0000id").ok, false);
  // A repository id is an owner/repo pair and is accepted verbatim.
  assert.deepEqual(validateSourceRef("repository", "acme/shop"), {
    ok: true,
    type: "repository",
    id: "acme/shop",
  });
});

test("stores: no DeepSeek or AI module is reachable from project reads", async () => {
  // Structural guard: the project modules must not import the AI/explain
  // surface, so grouping can never trigger a model call.
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "src/lib/projects/service.ts",
    "src/lib/projects/storage.ts",
    "src/lib/projects/types.ts",
    "src/lib/projects/validate.ts",
  ]) {
    const src = readFileSync(path.join(process.cwd(), file), "utf8");
    for (const forbidden of ["deepseek", "DeepSeek", "lib/ai", "explain"]) {
      assert.ok(
        !src.includes(forbidden),
        `${file} must not reference ${forbidden}`,
      );
    }
  }
});
