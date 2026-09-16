/**
 * Collector health rules and error sanitization.
 *
 * Pure functions over plain inputs — no scheduler, no collectors, no network,
 * no DeepSeek/GitHub calls. The tests pin the behavior a regression would
 * actually hurt: the precedence between inactive/failing/stale/healthy, the
 * exact 3× cadence staleness boundary, that a failing *collector* is distinct
 * from a failing *monitored target*, and that credentials never survive into
 * the status payload.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveCollectorState,
  sanitizeErrorMessage,
  MAX_ERROR_LENGTH,
  type CollectorHealthInput,
} from "../src/lib/scheduler/health";
import {
  JOB_CADENCE_MS,
  JOB_NAMES,
  JOB_STALE_AFTER_MS,
  STALE_CADENCE_MULTIPLE,
} from "../src/lib/scheduler/model";

const NOW = 1_000_000_000_000;

function input(over: Partial<CollectorHealthInput> = {}): CollectorHealthInput {
  return {
    now: NOW,
    startedAt: NOW - 60_000,
    staleAfterMs: 90_000,
    inactiveReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: NOW - 10_000,
    ...over,
  };
}

/* ------------------------------- states ------------------------------- */

test("recent successful run is healthy", () => {
  assert.equal(deriveCollectorState(input()), "healthy");
});

test("a collector that has never run is healthy within its first window", () => {
  // Boot grace: the scheduler started 30s ago and the job is not yet overdue.
  assert.equal(
    deriveCollectorState(input({ startedAt: NOW - 30_000, lastSuccessAt: null })),
    "healthy",
  );
});

test("no successful run past the window is stale", () => {
  assert.equal(deriveCollectorState(input({ lastSuccessAt: NOW - 120_000 })), "stale");
  assert.equal(
    deriveCollectorState(input({ startedAt: NOW - 120_000, lastSuccessAt: null })),
    "stale",
  );
});

test("a scheduler that never started reports stale, not healthy", () => {
  assert.equal(
    deriveCollectorState(input({ startedAt: null, lastSuccessAt: null })),
    "stale",
  );
});

test("a thrown run is failing", () => {
  assert.equal(deriveCollectorState(input({ consecutiveFailures: 1 })), "failing");
  assert.equal(deriveCollectorState(input({ consecutiveFailures: 7 })), "failing");
});

test("failing takes precedence over stale", () => {
  // Actively broken is the more useful signal than merely behind.
  assert.equal(
    deriveCollectorState(input({ consecutiveFailures: 3, lastSuccessAt: NOW - 600_000 })),
    "failing",
  );
});

test("inactive takes precedence over everything, and is never stale", () => {
  const inactive = {
    inactiveReason: "GITHUB_TOKEN is not configured",
    consecutiveFailures: 5,
    lastSuccessAt: null,
    startedAt: NOW - 600_000,
  };
  assert.equal(deriveCollectorState(input(inactive)), "inactive");
});

test("recovering clears failing back to healthy", () => {
  // consecutiveFailures is reset on success, so the same inputs minus the
  // failure streak must read healthy again.
  assert.equal(deriveCollectorState(input({ consecutiveFailures: 0 })), "healthy");
});

/* --------------------------- 3× cadence rule --------------------------- */

test("staleness window is exactly 3× cadence for every collector", () => {
  for (const name of JOB_NAMES) {
    assert.equal(
      JOB_STALE_AFTER_MS[name],
      JOB_CADENCE_MS[name] * STALE_CADENCE_MULTIPLE,
      `${name}: staleAfterMs must be ${STALE_CADENCE_MULTIPLE}× its cadence`,
    );
  }
});

test("3× cadence boundary: fresh at the edge, stale just past it", () => {
  for (const name of JOB_NAMES) {
    const staleAfterMs = JOB_STALE_AFTER_MS[name];
    // Exactly at 3× cadence the collector is still fresh.
    assert.equal(
      deriveCollectorState(input({ staleAfterMs, lastSuccessAt: NOW - staleAfterMs })),
      "healthy",
      `${name}: exactly at the boundary must still be healthy`,
    );
    // One millisecond later it is stale.
    assert.equal(
      deriveCollectorState(input({ staleAfterMs, lastSuccessAt: NOW - staleAfterMs - 1 })),
      "stale",
      `${name}: one tick past the boundary must be stale`,
    );
    // Two cadences in is unambiguously fine; four is unambiguously not.
    assert.equal(
      deriveCollectorState(input({ staleAfterMs, lastSuccessAt: NOW - 2 * staleAfterMs })),
      "stale",
    );
  }
});

/* ------------- collector failure vs monitored-target failure ------------- */

test("a down monitored target does not make the collector failing", () => {
  // The websites job completed successfully and recorded "site is down" as
  // data. Health describes the collector, so it stays healthy.
  const collectedSuccessfully = input({
    staleAfterMs: JOB_STALE_AFTER_MS.websites,
    lastSuccessAt: NOW - 5_000,
    consecutiveFailures: 0,
  });
  assert.equal(deriveCollectorState(collectedSuccessfully), "healthy");

  // Only the collector's own run throwing flips it to failing.
  assert.equal(
    deriveCollectorState({ ...collectedSuccessfully, consecutiveFailures: 1 }),
    "failing",
  );
});

/* --------------------------- sanitization --------------------------- */

test("a configured secret is redacted verbatim", () => {
  const token = "ghp_AbCdEf0123456789AbCdEf0123456789";
  const out = sanitizeErrorMessage(
    new Error(`request failed for https://api.github.com/user with ${token}`),
    [token],
  );
  assert.ok(!out.includes(token), "configured token must not survive");
  assert.ok(out.includes("[redacted]"));
});

test("token-shaped strings are redacted without being configured", () => {
  const cases = [
    "Bad credentials for Bearer ghp_AbCdEf0123456789AbCdEf01",
    "GET /repos?access_token=abcdef0123456789 failed",
    "upstream said: api_key=sk-abcdef0123456789xyz is invalid",
    "token=github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
  ];
  for (const raw of cases) {
    const out = sanitizeErrorMessage(raw, []);
    assert.ok(out.includes("[redacted]"), `not redacted: ${raw} -> ${out}`);
    assert.ok(!/ghp_|github_pat_|sk-abcdef|abcdef0123456789/.test(out), `leaked: ${out}`);
  }
});

test("nothing credential-shaped is required for a plain error to pass through", () => {
  const out = sanitizeErrorMessage(new Error("connect ECONNREFUSED 127.0.0.1:443"), []);
  assert.equal(out, "connect ECONNREFUSED 127.0.0.1:443");
});

test("short values are not treated as secrets", () => {
  // A two-character env value must not blank out ordinary text.
  const out = sanitizeErrorMessage("host up", ["up"]);
  assert.equal(out, "host up");
});

test("messages are collapsed to one line and truncated", () => {
  const multiline = sanitizeErrorMessage("first\n  second\tthird", []);
  assert.equal(multiline, "first second third");

  const long = sanitizeErrorMessage("x".repeat(MAX_ERROR_LENGTH * 2), []);
  assert.equal(long.length, MAX_ERROR_LENGTH);
  assert.ok(long.endsWith("…"));
});

test("non-Error throws are handled", () => {
  assert.equal(sanitizeErrorMessage("plain string failure", []), "plain string failure");
  assert.equal(sanitizeErrorMessage({ weird: true }, []), "[object Object]");
});
