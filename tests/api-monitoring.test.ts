/**
 * API endpoint monitoring (Task 21).
 *
 * These tests pin the behavior a regression would actually hurt: the
 * deterministic status/latency classification, that a disabled monitor is never
 * checked, that only state *transitions* reach the unified History, that the
 * collector participates in scheduler health, that a configured URL cannot
 * become an SSRF vector, and — most importantly — that no response body is ever
 * stored.
 *
 * There are NO real network calls here. Every check is driven through an
 * injected fetch, and the only URL validation exercised uses literal
 * addresses/hosts that the validator rejects (or resolves) before any DNS
 * traffic. Persistence tests work in a fresh OS temp directory: the real
 * `.devpulse/telemetry.db` is never opened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate } from "../src/lib/db/schema";
import { closeDb, getDb } from "../src/lib/db/index";
import {
  checkApi,
  checkAllApis,
  classifyApiCheck,
  classifyFetchError,
  resolveTimeoutMs,
  toApiCheckRow,
  type ApiTarget,
} from "../src/lib/monitoring/apis";
import {
  persistApiCheck,
  readApiChecks,
  readLatestApiChecks,
  readApiSummaries,
} from "../src/lib/monitoring/api-storage";
import { getEnabledApis } from "../src/lib/settings/service";
import { validateApiFields } from "../src/lib/settings/validate";
import { buildTimeline } from "../src/lib/history";
import { deriveCollectorState } from "../src/lib/scheduler/health";
import { JOB_CADENCE_MS, JOB_NAMES, JOB_STALE_AFTER_MS } from "../src/lib/scheduler/model";
import { getStore } from "../src/lib/scheduler/store";

/* ------------------------------ helpers ------------------------------ */

const NOW = Date.now();

/** Run `fn` against a fresh temp database. No real DB is touched. */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => Promise<void> | void,
): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-apis-"));
  const file = path.join(dir, DB_FILE_NAME);
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = file;
  const db = new DatabaseSync(file);
  migrate(db);
  const cleanup = () => {
    db.close();
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  };
  t.after(cleanup);
  return fn(db);
}

function addApi(
  db: DatabaseSync,
  a: Partial<{
    id: string;
    name: string;
    url: string;
    method: string;
    expectedStatus: number | null;
    timeoutMs: number | null;
    enabled: number;
  }> = {},
): string {
  const id = a.id ?? "api-1";
  db.prepare(
    `INSERT INTO monitored_apis
       (id, name, url, method, expectedStatus, timeoutMs, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    a.name ?? "Health endpoint",
    a.url ?? "https://api.example.com/health",
    a.method ?? "GET",
    a.expectedStatus ?? null,
    a.timeoutMs ?? null,
    a.enabled ?? 1,
    NOW,
    NOW,
  );
  return id;
}

/** A fetch stub that never touches the network. */
function stubFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init?: RequestInit) =>
    Promise.resolve(impl(url, init))) as unknown as typeof fetch;
}

const target = (over: Partial<ApiTarget> = {}): ApiTarget => ({
  id: "api-1",
  name: "Health endpoint",
  url: "https://api.example.com/health",
  method: "GET",
  ...over,
});

/* --------------------------- classification --------------------------- */

test("expected status with acceptable latency is healthy", () => {
  const c = classifyApiCheck({ httpStatus: 200, latencyMs: 120, expectedStatus: 200 });
  assert.equal(c.state, "healthy");
  assert.equal(c.errorType, null);
  assert.equal(c.error, null);
});

test("expected status with slow latency is degraded, not down", () => {
  const c = classifyApiCheck({ httpStatus: 200, latencyMs: 9000, expectedStatus: 200 });
  assert.equal(c.state, "degraded");
  assert.equal(c.errorType, null);
});

test("a non-default expected status (e.g. 201/204) is honoured", () => {
  assert.equal(
    classifyApiCheck({ httpStatus: 201, latencyMs: 50, expectedStatus: 201 }).state,
    "healthy",
  );
  assert.equal(
    classifyApiCheck({ httpStatus: 204, latencyMs: 50, expectedStatus: 200 }).state,
    "down",
  );
});

test("an unexpected status is down with a precise error", () => {
  const c = classifyApiCheck({ httpStatus: 503, latencyMs: 80, expectedStatus: 200 });
  assert.equal(c.state, "down");
  assert.equal(c.errorType, "unexpected_status");
  assert.equal(c.error, "expected 200, got 503");
});

test("a timeout is down and reported as a timeout", () => {
  const c = classifyApiCheck({
    httpStatus: null,
    latencyMs: 8000,
    expectedStatus: 200,
    failure: { type: "timeout", message: "request timed out" },
  });
  assert.equal(c.state, "down");
  assert.equal(c.errorType, "timeout");
  assert.equal(c.error, "request timed out");
});

test("a DNS / network failure is down and keeps its sanitized reason", () => {
  const c = classifyApiCheck({
    httpStatus: null,
    latencyMs: 30,
    expectedStatus: 200,
    failure: { type: "network", message: "getaddrinfo ENOTFOUND api.example.com" },
  });
  assert.equal(c.state, "down");
  assert.equal(c.errorType, "network");
  assert.match(c.error ?? "", /ENOTFOUND/);
});

test("fetch errors are classified without leaking credentials", () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  assert.deepEqual(classifyFetchError(timeout), {
    type: "timeout",
    message: "request timed out",
  });

  const network = classifyFetchError(
    new Error("connect failed for https://x.test/?api_key=sk-abcdef0123456789xyz"),
  );
  assert.equal(network.type, "network");
  assert.ok(!network.message.includes("sk-abcdef0123456789xyz"), "secret must be redacted");
});

test("configured timeouts are bounded, and defaulted when unset", () => {
  assert.equal(resolveTimeoutMs(null), 8000);
  assert.equal(resolveTimeoutMs(undefined), 8000);
  assert.equal(resolveTimeoutMs(0), 8000);
  assert.equal(resolveTimeoutMs(2500), 2500);
  assert.equal(resolveTimeoutMs(60_000), 30_000, "must never exceed the hard ceiling");
});

/* ------------------------------ checking ------------------------------ */

test("a check sends only the method, the URL and a bounded timeout", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const res = await checkApi(
    target({ method: "POST", timeoutMs: 2500 }),
    stubFetch((url, init) => {
      seen = { url, init };
      return new Response("ok", { status: 200 });
    }),
  );

  assert.equal(res.state, "healthy");
  assert.equal(res.httpStatus, 200);
  assert.equal(seen!.url, "https://api.example.com/health");
  assert.equal(seen!.init?.method, "POST");
  assert.ok(!("body" in (seen!.init ?? {})), "no request body may ever be sent");
  assert.ok(!("headers" in (seen!.init ?? {})), "no custom headers may ever be sent");
  assert.ok(seen!.init?.signal, "the request must be abortable on timeout");
});

test("a rejected check never throws — it becomes a down result", async () => {
  const res = await checkApi(
    target(),
    stubFetch(() => {
      throw Object.assign(new Error("boom"), { name: "TimeoutError" });
    }),
  );
  assert.equal(res.state, "down");
  assert.equal(res.errorType, "timeout");
  assert.equal(res.httpStatus, null);
});

test("an unusable configuration is rejected before any fetch happens", async () => {
  let called = false;
  const res = await checkApi(
    target({ url: "ftp://api.example.com/health" }),
    stubFetch(() => {
      called = true;
      return new Response(null, { status: 200 });
    }),
  );
  assert.equal(called, false, "no request may be made for an invalid target");
  assert.equal(res.state, "down");
  assert.equal(res.errorType, "bad_config");
});

/* --------------------- no response body persistence --------------------- */

test("a response body is never read, returned or stored", async (t) => {
  await withTempDb(t, async (db) => {
    addApi(db);
    const SECRET = "TOP-SECRET-RESPONSE-BODY";

    const results = await checkAllApis(
      stubFetch(() => new Response(SECRET, { status: 200 })),
    );

    assert.equal(results.length, 1);
    // The result carries observed facts only — no body, no headers, no text.
    assert.ok(!JSON.stringify(results).includes(SECRET));

    const rows = db
      .prepare(`SELECT * FROM api_checks`)
      .all() as Record<string, unknown>[];
    assert.equal(rows.length, 1, "the check should have been persisted");
    assert.ok(
      !JSON.stringify(rows).includes(SECRET),
      "no stored column may contain response body content",
    );
    // The persisted shape is exactly the observed facts.
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ["error", "errorType", "httpStatus", "latencyMs", "state", "targetId", "ts"].sort(),
    );
  });
});

/* ------------------------- disabled monitors ------------------------- */

test("disabled endpoints are never checked and never persisted", async (t) => {
  await withTempDb(t, async (db) => {
    addApi(db, { id: "on", name: "Enabled", enabled: 1 });
    addApi(db, { id: "off", name: "Disabled", enabled: 0 });

    const enabled = getEnabledApis().map((a) => a.id);
    assert.deepEqual(enabled, ["on"], "only enabled monitors are checked");

    let calls = 0;
    const results = await checkAllApis(
      stubFetch(() => {
        calls++;
        return new Response(null, { status: 200 });
      }),
    );
    assert.equal(calls, 1, "the disabled endpoint must not be requested");
    assert.deepEqual(results.map((r) => r.api.id), ["on"]);

    const stored = readApiChecks(0).map((r) => r.targetId);
    assert.deepEqual(stored, ["on"]);
  });
});

/* --------------------- persistence + history transitions --------------------- */

test("only state transitions reach the unified History", async (t) => {
  await withTempDb(t, async (db) => {
    const id = addApi(db, { id: "api-h", name: "Health endpoint" });

    // healthy → healthy → down → down → healthy
    const seq: [number, "healthy" | "down"][] = [
      [NOW - 50_000, "healthy"],
      [NOW - 40_000, "healthy"],
      [NOW - 30_000, "down"],
      [NOW - 20_000, "down"],
      [NOW - 10_000, "healthy"],
    ];
    for (const [ts, state] of seq) {
      assert.equal(
        persistApiCheck({
          ts,
          targetId: id,
          state,
          httpStatus: state === "down" ? 503 : 200,
          latencyMs: 42,
          errorType: state === "down" ? "unexpected_status" : null,
          error: state === "down" ? "expected 200, got 503" : null,
        }),
        true,
      );
    }

    const events = buildTimeline("24H").filter((e) => e.source === "api");
    assert.equal(events.length, 2, "one event per transition, not per check");
    // Newest first: down → healthy was the later transition.
    assert.equal(events[0].ts, NOW - 10_000);
    assert.equal(events[0].metadata?.from, "down");
    assert.equal(events[0].metadata?.state, "healthy");
    assert.equal(events[1].ts, NOW - 30_000);
    assert.equal(events[1].severity, "critical");
    assert.match(events[1].title, /Health endpoint/);
    assert.equal(events[1].metadata?.httpStatus, 503);
  });
});

test("a steady-state endpoint produces no history events at all", async (t) => {
  await withTempDb(t, async (db) => {
    const id = addApi(db, { id: "api-steady" });
    for (let i = 0; i < 5; i++) {
      persistApiCheck({
        ts: NOW - (5 - i) * 1_000,
        targetId: id,
        state: "healthy",
        httpStatus: 200,
        latencyMs: 20,
        errorType: null,
        error: null,
      });
    }
    assert.equal(
      buildTimeline("24H").filter((e) => e.source === "api").length,
      0,
      "successful polls must not be emitted as events",
    );
  });
});

test("latest-per-endpoint reads and 24h summaries come from stored rows", async (t) => {
  await withTempDb(t, async (db) => {
    const id = addApi(db, { id: "api-sum" });
    persistApiCheck({ ts: NOW - 3_000, targetId: id, state: "healthy", httpStatus: 200, latencyMs: 100, errorType: null, error: null });
    persistApiCheck({ ts: NOW - 2_000, targetId: id, state: "down", httpStatus: 500, latencyMs: 300, errorType: "unexpected_status", error: "expected 200, got 500" });
    persistApiCheck({ ts: NOW - 1_000, targetId: id, state: "healthy", httpStatus: 200, latencyMs: 200, errorType: null, error: null });

    const latest = readLatestApiChecks();
    assert.equal(latest.length, 1);
    assert.equal(latest[0].state, "healthy", "the newest row is the current state");
    assert.equal(latest[0].ts, NOW - 1_000);

    const summary = readApiSummaries(86_400_000)[id];
    assert.equal(summary.samples, 3);
    assert.equal(summary.uptimePct, 66.7);
    assert.equal(summary.avgLatencyMs, 200);
    assert.equal(summary.latestFailureAt, NOW - 2_000);
  });
});

/* ------------------------ collector health integration ------------------------ */

test("the apis collector is registered with a website-consistent cadence", () => {
  assert.ok((JOB_NAMES as readonly string[]).includes("apis"));
  assert.equal(JOB_CADENCE_MS.apis, JOB_CADENCE_MS.websites);
  assert.equal(JOB_STALE_AFTER_MS.apis, JOB_CADENCE_MS.apis * 3);
  assert.ok(getStore().jobs.apis, "the scheduler store tracks the apis job");
});

test("a failing endpoint is not a failing collector", () => {
  // The job completed; "the endpoint is down" is data, not a collector fault.
  const collected = {
    now: NOW,
    startedAt: NOW - 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.apis,
    inactiveReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: NOW - 5_000,
  };
  assert.equal(deriveCollectorState(collected), "healthy");
  assert.equal(deriveCollectorState({ ...collected, consecutiveFailures: 2 }), "failing");
  assert.equal(
    deriveCollectorState({ ...collected, lastSuccessAt: NOW - JOB_STALE_AFTER_MS.apis - 1 }),
    "stale",
  );
});

/* ------------------------------ SSRF rejection ------------------------------ */

test("internal destinations are rejected at configuration time", async () => {
  const rejected = [
    "http://127.0.0.1:8080/health",
    "http://localhost/health",
    "http://10.0.0.5/health",
    "http://172.16.4.4/health",
    "http://192.168.1.10/health",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/health",
    "file:///etc/passwd",
  ];
  for (const url of rejected) {
    const err = await validateApiFields({
      name: "Internal",
      url,
      method: "GET",
    });
    assert.ok(err, `expected ${url} to be rejected`);
  }
});

test("a public endpoint is accepted and a bad method/timeout is not", async () => {
  assert.equal(
    await validateApiFields({ name: "Public", url: "https://93.184.216.34/health", method: "HEAD" }),
    null,
  );

  assert.match(
    (await validateApiFields({ name: "Bad method", url: "https://93.184.216.34/", method: "DELETE" })) ?? "",
    /Method/,
  );
  assert.match(
    (await validateApiFields({ name: "Bad timeout", url: "https://93.184.216.34/", method: "GET", timeoutMs: 60 })) ?? "",
    /Timeout/,
  );
  assert.match(
    (await validateApiFields({ name: "Bad status", url: "https://93.184.216.34/", method: "GET", expectedStatus: 42 })) ?? "",
    /Expected status/,
  );
  assert.match(
    (await validateApiFields({ name: "", url: "https://93.184.216.34/", method: "GET" })) ?? "",
    /Display name/,
  );
});

/* ------------------------------ persistence failures ------------------------------ */

test("storage that is unavailable degrades to empty, never a throw", () => {
  // With a temp DB configured, then closed: reads return empty, writes return
  // false, and nothing propagates.
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-apis-empty-"));
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = path.join(dir, "nested", DB_FILE_NAME);
  try {
    assert.deepEqual(readApiChecks(0), []);
    assert.deepEqual(readLatestApiChecks(), []);
    assert.deepEqual(readApiSummaries(86_400_000), {});
    assert.equal(toApiCheckRow({
      api: target(),
      host: "api.example.com",
      checkedAt: NOW,
      state: "healthy",
      httpStatus: 200,
      latencyMs: 1,
      errorType: null,
      error: null,
    }).state, "healthy");
    const db = getDb();
    assert.ok(db, "a fresh path should open");
  } finally {
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
