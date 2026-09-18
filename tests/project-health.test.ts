/**
 * Deterministic project health (Task 26).
 *
 * Two layers are covered. The first exercises the pure rules directly, with a
 * fixed clock, so the precedence (critical > degraded > unknown > healthy), the
 * staleness handling and the reason text are pinned exactly. The second drives
 * the same evaluation through the project service against a real temp database,
 * proving the states come from persisted rows — and that evaluating health
 * performs no network I/O, creates no alert and writes no history.
 *
 * There are NO real network calls and no AI calls anywhere in this file.
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
import { insertApi, insertDevice, insertRepository } from "../src/lib/settings/storage";
import { persistApiCheck } from "../src/lib/monitoring/api-storage";
import { persistWebsiteCheck } from "../src/lib/monitoring/storage";
import { persistDeviceCheck } from "../src/lib/devices/storage";
import { applyVerdict, readAlerts } from "../src/lib/alerts/storage";
import { buildTimeline } from "../src/lib/history";
import {
  MAX_PROJECT_HEALTH_REASONS,
  SOURCE_STALE_AFTER_MS,
  projectHealthOf,
} from "../src/lib/projects/health";
import {
  associateSourceToProject,
  createProject,
  getProject,
  listProjects,
} from "../src/lib/projects/service";
import { listProjectRows } from "../src/lib/projects/storage";
import type { ProjectHealthSource } from "../src/lib/projects/types";

/* ------------------------------ fixtures ------------------------------ */

/** A fixed clock: the rules read `now` from the caller, never from a clock. */
const NOW = 1_700_000_000_000;

/** A normalized source, i.e. the output shape of a server-side state lookup. */
function source(
  over: Partial<ProjectHealthSource> & { type: ProjectHealthSource["type"]; name: string },
): ProjectHealthSource {
  return {
    id: `${over.type}-1`,
    health: "healthy",
    checkedAt: NOW - 1_000, // fresh by default
    enabled: true,
    ...over,
  };
}

const messages = (sources: ProjectHealthSource[]) =>
  projectHealthOf(sources, NOW).reasons.map((r) => r.message);

/* ------------------------------ pure rules ---------------------------- */

test("health: a project with no sources is unknown, and claims nothing", () => {
  const health = projectHealthOf([], NOW);
  assert.equal(health.state, "unknown");
  assert.deepEqual(health.reasons, []);
  assert.deepEqual(health.counts, { total: 0, healthy: 0, warn: 0, critical: 0, unknown: 0 });
  assert.equal(health.evaluatedAt, NOW);
});

test("health: a source with no stored observation is unknown, never healthy", () => {
  const health = projectHealthOf(
    [source({ type: "website", name: "Docs", health: "unknown", checkedAt: null })],
    NOW,
  );
  assert.equal(health.state, "unknown");
  assert.deepEqual(messages([source({ type: "website", name: "Docs", health: "unknown", checkedAt: null })]), [
    "Website Docs has no monitoring data",
  ]);
});

test("health: all sources fresh and healthy is the only path to healthy", () => {
  const sources = [
    source({ type: "website", id: "w1", name: "Docs" }),
    source({ type: "api", id: "a1", name: "Production" }),
    source({ type: "device", id: "d1", name: "ESP32 Node" }),
    source({ type: "repository", id: "r1", name: "devpulse" }),
  ];
  const health = projectHealthOf(sources, NOW);
  assert.equal(health.state, "healthy");
  assert.deepEqual(health.reasons, []);
  assert.deepEqual(health.counts, { total: 4, healthy: 4, warn: 0, critical: 0, unknown: 0 });
});

test("health: one degraded source degrades the project, and names it", () => {
  const health = projectHealthOf(
    [
      source({ type: "website", id: "w1", name: "Docs" }),
      source({ type: "website", id: "w2", name: "Blog", health: "warn" }),
    ],
    NOW,
  );
  assert.equal(health.state, "degraded");
  assert.deepEqual(health.reasons.map((r) => r.message), ["Website Blog is degraded"]);
  assert.equal(health.reasons[0].code, "degraded");
});

test("health: a down source is critical, with wording per source kind", () => {
  assert.deepEqual(
    messages([
      source({ type: "website", id: "w1", name: "Docs", health: "critical" }),
      source({ type: "api", id: "a1", name: "Production", health: "critical" }),
    ]),
    ["Website Docs is down", "API Production is down"],
  );

  const device = projectHealthOf(
    [source({ type: "device", id: "d1", name: "ESP32 Node", health: "critical" })],
    NOW,
  );
  assert.equal(device.state, "critical");
  assert.deepEqual(device.reasons.map((r) => r.message), ["Device ESP32 Node is unreachable"]);
  assert.equal(device.reasons[0].code, "unreachable");
});

test("health: a repository needing attention only degrades the project", () => {
  const health = projectHealthOf(
    [source({ type: "repository", id: "r1", name: "devpulse", health: "warn" })],
    NOW,
  );
  assert.equal(health.state, "degraded");
  assert.deepEqual(health.reasons.map((r) => r.message), ["Repository devpulse needs attention"]);
});

test("health: critical outranks degraded, unknown and healthy", () => {
  const health = projectHealthOf(
    [
      source({ type: "website", id: "w1", name: "Docs" }),
      source({ type: "website", id: "w2", name: "Blog", health: "warn" }),
      source({ type: "api", id: "a1", name: "Unknown API", health: "unknown", checkedAt: null }),
      source({ type: "api", id: "a2", name: "Production", health: "critical" }),
    ],
    NOW,
  );
  assert.equal(health.state, "critical");
  assert.deepEqual(health.counts, { total: 4, healthy: 1, warn: 1, critical: 1, unknown: 1 });
  // The reason list leads with what defines the state.
  assert.equal(health.reasons[0].message, "API Production is down");
});

test("health: unknown outranks healthy — absent evidence is not good news", () => {
  const health = projectHealthOf(
    [
      source({ type: "website", id: "w1", name: "Docs" }),
      source({ type: "api", id: "a1", name: "Production", health: "unknown", checkedAt: null }),
    ],
    NOW,
  );
  assert.equal(health.state, "unknown");
});

test("health: stale healthy data is degraded, and stale failures stay failures", () => {
  const staleAt = NOW - SOURCE_STALE_AFTER_MS.website - 1;

  const staleHealthy = projectHealthOf(
    [source({ type: "website", id: "w1", name: "Docs", health: "healthy", checkedAt: staleAt })],
    NOW,
  );
  assert.equal(staleHealthy.state, "degraded");
  assert.deepEqual(staleHealthy.reasons.map((r) => r.message), ["Website Docs data is stale"]);
  assert.equal(staleHealthy.reasons[0].code, "stale");

  // An observation exactly at the boundary is still current.
  const boundary = projectHealthOf(
    [
      source({
        type: "website",
        id: "w1",
        name: "Docs",
        health: "healthy",
        checkedAt: NOW - SOURCE_STALE_AFTER_MS.website,
      }),
    ],
    NOW,
  );
  assert.equal(boundary.state, "healthy");

  // Age does not launder a failure into health.
  const staleDown = projectHealthOf(
    [source({ type: "website", id: "w1", name: "Docs", health: "critical", checkedAt: staleAt })],
    NOW,
  );
  assert.equal(staleDown.state, "critical");
  assert.equal(staleDown.reasons[0].code, "down");
});

test("health: the staleness window per kind is the collector's own", () => {
  // Reused from lib/scheduler/model (3 cadences), not invented for projects.
  assert.equal(SOURCE_STALE_AFTER_MS.website, 180_000);
  assert.equal(SOURCE_STALE_AFTER_MS.api, 180_000);
  assert.equal(SOURCE_STALE_AFTER_MS.device, 180_000);
  assert.equal(SOURCE_STALE_AFTER_MS.repository, 270_000);
});

test("health: a disabled source is unknown — it is not being watched", () => {
  const health = projectHealthOf(
    [source({ type: "website", id: "w1", name: "Docs", enabled: false })],
    NOW,
  );
  assert.equal(health.state, "unknown");
  assert.deepEqual(health.reasons.map((r) => r.message), ["Website Docs is disabled"]);
  assert.equal(health.reasons[0].code, "disabled");
});

test("health: a clock skew in the future never reads as stale", () => {
  const health = projectHealthOf(
    [source({ type: "website", id: "w1", name: "Docs", checkedAt: NOW + 60_000 })],
    NOW,
  );
  assert.equal(health.state, "healthy");
});

test("health: recovery to healthy is just a fresh healthy observation", () => {
  const broken = source({ type: "website", id: "w1", name: "Docs", health: "critical" });
  assert.equal(projectHealthOf([broken], NOW).state, "critical");
  assert.equal(projectHealthOf([source({ type: "website", id: "w1", name: "Docs" })], NOW).state, "healthy");
});

test("health: reasons are bounded, deterministic and stably ordered", () => {
  // Worst first, then source kind in canonical order, then name.
  const sources = [
    source({ type: "device", id: "d1", name: "Zeta", health: "unknown", checkedAt: null }),
    source({ type: "website", id: "w2", name: "Beta", health: "critical" }),
    source({ type: "api", id: "a1", name: "Prod", health: "critical" }),
    source({ type: "website", id: "w1", name: "Alpha", health: "critical" }),
  ];
  const first = projectHealthOf(sources, NOW);
  const second = projectHealthOf([...sources].reverse(), NOW);

  assert.deepEqual(first, second, "input order must not change the result");
  assert.equal(first.reasons.length, MAX_PROJECT_HEALTH_REASONS);
  assert.deepEqual(first.reasons.map((r) => r.message), [
    "Website Alpha is down",
    "Website Beta is down",
    "API Prod is down",
  ]);
});

/* ---------------------------- integration ----------------------------- */

function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => void,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-health-"));
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

function project(name: string): string {
  assert.ok(createProject({ name }).ok);
  const row = (listProjectRows() ?? []).find((p) => p.name === name);
  assert.ok(row);
  return row.id;
}

function website(db: DatabaseSync, id: string, name: string): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO monitored_websites (id, name, url, expectedStatus, enabled, createdAt, updatedAt)
     VALUES (?, ?, 'https://example.com/', NULL, 1, ?, ?)`,
  ).run(id, name, now, now);
  return id;
}

/** Persist a github snapshot; the table is small and the fixture keeps its ids. */
function repoSnapshot(db: DatabaseSync, repoKey: string, state: string, ts = Date.now()): void {
  db.prepare(
    `INSERT INTO github_snapshots (ts, repoKey, repoName, displayName, state)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ts, repoKey, repoKey.split("/")[1], repoKey, state);
}

function websiteCheck(targetId: string, state: "healthy" | "degraded" | "down", ts = Date.now()) {
  persistWebsiteCheck({
    ts,
    targetId,
    state,
    httpStatus: state === "down" ? 503 : 200,
    latencyMs: state === "healthy" ? 40 : null,
    errorType: state === "down" ? "unexpected_status" : null,
    error: state === "down" ? "503" : null,
  });
}

/** Same shape as websiteCheck, for the API endpoints. */
function apiCheck(targetId: string, state: "healthy" | "degraded" | "down", ts = Date.now()) {
  persistApiCheck({
    ts,
    targetId,
    state,
    httpStatus: state === "down" ? 503 : 200,
    latencyMs: state === "healthy" ? 40 : null,
    errorType: state === "down" ? "unexpected_status" : null,
    error: state === "down" ? "503" : null,
  });
}

test("service: project health is derived from persisted source state", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Storefront");
    assert.equal(getProject(pid)?.health.state, "unknown"); // no sources yet

    const site = website(db, "w-store", "Storefront");
    const apiId = insertApi({
      name: "Shop",
      url: "https://shop.test/health",
      method: "GET",
      expectedStatus: null,
      timeoutMs: null,
    })!.id;
    assert.ok(associateSourceToProject(pid, "website", site).ok);
    assert.ok(associateSourceToProject(pid, "api", apiId).ok);
    assert.equal(getProject(pid)?.health.state, "unknown"); // grouped, never observed

    websiteCheck(site, "healthy");
    apiCheck(apiId, "healthy");
    let health = getProject(pid)!.health;
    assert.equal(health.state, "healthy");
    assert.equal(health.counts.healthy, 2);
    assert.deepEqual(health.reasons, []);

    // A degraded observation degrades the project.
    apiCheck(apiId, "degraded", Date.now() + 1);
    health = getProject(pid)!.health;
    assert.equal(health.state, "degraded");
    assert.deepEqual(health.reasons.map((r) => r.message), ["API Shop is degraded"]);

    // And a failure makes it critical, even though the website is fine.
    apiCheck(apiId, "down", Date.now() + 2);
    health = getProject(pid)!.health;
    assert.equal(health.state, "critical");
    assert.deepEqual(health.reasons.map((r) => r.message), ["API Shop is down"]);
    assert.equal(health.counts.healthy, 1);

    // Recovery: a fresh healthy row is all it takes.
    apiCheck(apiId, "healthy", Date.now() + 3);
    assert.equal(getProject(pid)!.health.state, "healthy");

    // The list view derives the same verdict.
    assert.equal(listProjects()[0].health.state, "healthy");
    assert.equal(listProjects()[0].health.counts.total, 2);
  });
});

test("service: an unreachable device is critical, and a stale one is not healthy", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Nodes");
    const device = insertDevice({ name: "ESP32 Node", host: "esp32.local", type: "server" })!;
    assert.ok(associateSourceToProject(pid, "device", device.id).ok);

    // Old reachable evidence is stale, not healthy.
    persistDeviceCheck({
      device,
      checkedAt: Date.now() - SOURCE_STALE_AFTER_MS.device - 60_000,
      reachable: true,
      latencyMs: 3,
      errorType: null,
      error: null,
    });
    let health = getProject(pid)!.health;
    assert.equal(health.state, "degraded");
    assert.deepEqual(health.reasons.map((r) => r.message), ["Device ESP32 Node data is stale"]);

    persistDeviceCheck({
      device,
      checkedAt: Date.now(),
      reachable: false,
      latencyMs: null,
      errorType: "timeout",
      error: "no response within 1000 ms",
    });
    health = getProject(pid)!.health;
    assert.equal(health.state, "critical");
    assert.deepEqual(health.reasons.map((r) => r.message), ["Device ESP32 Node is unreachable"]);

    void db;
  });
});

test("service: repositories map attention to degraded and missing data to unknown", (t) => {
  withTempDb(t, (db) => {
    const pid = project("Platform");

    // No snapshot has ever been stored for this repo (e.g. no token configured).
    assert.ok(insertRepository({ owner: "acme", repo: "silent", displayName: "acme/silent" }));
    assert.ok(associateSourceToProject(pid, "repository", "acme/silent").ok);
    assert.equal(getProject(pid)!.health.state, "unknown");
    assert.deepEqual(getProject(pid)!.health.reasons.map((r) => r.message), [
      "Repository acme/silent has no monitoring data",
    ]);

    assert.ok(insertRepository({ owner: "acme", repo: "api", displayName: "acme/api" }));
    assert.ok(associateSourceToProject(pid, "repository", "acme/api").ok);
    repoSnapshot(db, "acme/api", "attention");

    // A known problem is reported over absent information: the unobserved repo
    // is still counted (and named in the counts), but it does not mask the
    // repository that actually needs attention.
    const health = getProject(pid)!.health;
    assert.equal(health.state, "degraded");
    assert.deepEqual(health.counts, { total: 2, healthy: 0, warn: 1, critical: 0, unknown: 1 });
    assert.deepEqual(health.reasons.map((r) => r.message), [
      "Repository acme/api needs attention",
      "Repository acme/silent has no monitoring data",
    ]);

    repoSnapshot(db, "acme/silent", "healthy");
    assert.equal(getProject(pid)!.health.state, "degraded");
  });
});

test("service: evaluating health is a pure read — no network, no alert, no history", (t) => {
  withTempDb(t, (db) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("project health must not perform network I/O");
    }) as typeof globalThis.fetch;

    try {
      const pid = project("Storefront");
      const site = website(db, "w-store", "Storefront");
      assert.ok(associateSourceToProject(pid, "website", site).ok);
      websiteCheck(site, "down", Date.now());

      // The source's own alert, raised by the ordinary rules — DevPulse is not
      // asked to raise a second one because a project happens to group it.
      applyVerdict(
        {
          fingerprint: `websites:down:${site}`,
          source: "websites",
          ruleId: "website_down",
          severity: "critical",
          title: "Website down",
          message: "not responding",
          active: true,
        },
        Date.now(),
      );

      const alertsBefore = readAlerts("active");
      const historyBefore = buildTimeline("24H").length;

      // Read it many times: a derived value must not accumulate anything.
      for (let i = 0; i < 5; i++) {
        assert.equal(getProject(pid)!.health.state, "critical");
        assert.equal(listProjects()[0].health.state, "critical");
      }

      const alertsAfter = readAlerts("active");
      assert.deepEqual(
        alertsAfter.map((a) => a.fingerprint),
        alertsBefore.map((a) => a.fingerprint),
        "no project-level alert may be raised for a problem an alert already covers",
      );
      assert.equal(alertsAfter.length, 1);
      assert.equal(alertsAfter[0].fingerprint, `websites:down:${site}`);
      assert.equal(
        buildTimeline("24H").length,
        historyBefore,
        "no history event may be written by a read",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
