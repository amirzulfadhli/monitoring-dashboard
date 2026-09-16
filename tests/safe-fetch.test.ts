/**
 * Redirect SSRF hardening for monitored targets (Task 21 follow-up).
 *
 * Configuration-time validation alone was not enough: `redirect: "follow"` let
 * an approved public URL answer 302 with a Location pointing at loopback or a
 * private address, and the runtime followed it after validation had passed.
 * These tests pin the replacement behavior — every hop re-validated with the
 * same rules, a bounded chain, one shared deadline.
 *
 * There are NO real network calls. The fetcher is always a stub, and the URLs
 * used are literal addresses, which the validator classifies locally (a literal
 * IP is never a DNS query). "Public" here is 93.184.216.34 — a real public
 * address that is nonetheless never contacted, because the stub answers first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  safeFetch,
  SafeFetchError,
  MAX_REDIRECTS,
} from "../src/lib/monitoring/safe-fetch";
import { checkApi, classifyFetchError } from "../src/lib/monitoring/apis";

/* ------------------------------ helpers ------------------------------ */

const PUBLIC = "https://93.184.216.34/health";
const PUBLIC_2 = "https://93.184.216.35/health";

type Call = { url: string; init?: RequestInit };

/** A fetch stub that records every call and never touches the network. */
function stub(
  handler: (url: string, init: RequestInit | undefined, call: number) => Response,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init, calls.length));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

/* --------------------------- allowed redirects --------------------------- */

test("a public → public redirect is followed to the final response", async () => {
  const { impl, calls } = stub((url) =>
    url === PUBLIC ? redirect(PUBLIC_2) : new Response("ok", { status: 200 }),
  );

  const res = await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.equal(res.status, 200, "the destination response is what callers see");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, PUBLIC_2);
});

test("redirects are requested manually, so nothing is followed implicitly", async () => {
  const { impl, calls } = stub(() => new Response(null, { status: 200 }));

  await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.equal(calls[0].init?.redirect, "manual");
});

test("a relative Location is resolved against the current URL", async () => {
  const { impl, calls } = stub((url) =>
    url === PUBLIC ? redirect("/v2/health") : new Response(null, { status: 204 }),
  );

  const res = await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.equal(res.status, 204);
  assert.equal(calls[1].url, "https://93.184.216.34/v2/health");
});

test("a POST is downgraded to GET across a 303, as fetch itself would", async () => {
  const { impl, calls } = stub((url) =>
    url === PUBLIC ? redirect(PUBLIC_2, 303) : new Response(null, { status: 200 }),
  );

  await safeFetch(PUBLIC, { method: "POST", timeoutMs: 5000, fetchImpl: impl });

  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[1].init?.method, "GET", "303 must not re-POST");
});

/* --------------------------- blocked redirects --------------------------- */

test("a public → loopback redirect is blocked and never requested", async () => {
  const { impl, calls } = stub(() => redirect("http://127.0.0.1:8080/admin"));

  await assert.rejects(
    () => safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl }),
    (e: unknown) => {
      assert.ok(e instanceof SafeFetchError);
      assert.equal(e.type, "redirect_blocked");
      return true;
    },
  );
  assert.equal(calls.length, 1, "the internal destination must never be fetched");
});

test("a public → private (RFC1918) redirect is blocked", async () => {
  for (const internal of [
    "http://10.0.0.5/health",
    "http://192.168.1.10/health",
    "http://172.16.4.4/health",
    "http://169.254.169.254/latest/meta-data", // link-local metadata service
    "http://[::1]/health",
    "http://[fd00::1]/health", // ULA
  ]) {
    const { impl, calls } = stub(() => redirect(internal));
    await assert.rejects(
      () => safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl }),
      (e: unknown) => e instanceof SafeFetchError && e.type === "redirect_blocked",
      `expected ${internal} to be blocked`,
    );
    assert.equal(calls.length, 1, `${internal} must never be fetched`);
  }
});

test("a redirect to a non-http protocol or to embedded credentials is blocked", async () => {
  for (const bad of ["file:///etc/passwd", "https://user:pw@93.184.216.35/"]) {
    const { impl } = stub(() => redirect(bad));
    await assert.rejects(
      () => safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl }),
      (e: unknown) => e instanceof SafeFetchError && e.type === "redirect_blocked",
      `expected ${bad} to be blocked`,
    );
  }
});

/* ----------------------------- chain bounds ----------------------------- */

test("the redirect chain is bounded and cannot loop forever", async () => {
  // Every hop redirects to another (public, valid) address.
  let n = 0;
  const { impl, calls } = stub(() => redirect(`https://93.184.216.${40 + n++}/health`));

  await assert.rejects(
    () => safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl }),
    (e: unknown) => e instanceof SafeFetchError && e.type === "redirect_limit",
  );
  assert.equal(
    calls.length,
    MAX_REDIRECTS + 1,
    "the initial request plus the bounded number of followed hops",
  );
});

test("a chain within the limit still resolves", async () => {
  let n = 0;
  const { impl } = stub(() =>
    n < MAX_REDIRECTS ? redirect(`https://93.184.216.${50 + n++}/health`) : new Response(null, { status: 200 }),
  );

  const res = await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });
  assert.equal(res.status, 200);
});

/* ------------------------ missing / invalid Location ------------------------ */

test("a 3xx with no Location is returned as the final response, not chased", async () => {
  const { impl, calls } = stub(() => new Response(null, { status: 302 }));

  const res = await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.equal(res.status, 302, "the caller still sees the status it must report");
  assert.equal(calls.length, 1);
});

test("an empty Location header is treated as missing", async () => {
  const { impl, calls } = stub(
    () => new Response(null, { status: 301, headers: { location: "" } }),
  );

  const res = await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.equal(res.status, 301);
  assert.equal(calls.length, 1);
});

test("an unparsable Location is refused rather than guessed at", async () => {
  const { impl, calls } = stub(
    () => new Response(null, { status: 302, headers: { location: "http://" } }),
  );

  await assert.rejects(
    () => safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl }),
    (e: unknown) => e instanceof SafeFetchError && e.type === "bad_redirect",
  );
  assert.equal(calls.length, 1);
});

/* --------------------------- timeout behavior --------------------------- */

test("one deadline covers the whole chain, preserving the caller's bound", async () => {
  const { impl, calls } = stub((url) =>
    url === PUBLIC ? redirect(PUBLIC_2) : new Response(null, { status: 200 }),
  );

  await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.ok(calls[0].init?.signal, "the request must be abortable");
  assert.equal(
    calls[1].init?.signal,
    calls[0].init?.signal,
    "one signal for every hop: redirects must not multiply the timeout budget",
  );
});

test("a non-redirect response is passed through untouched", async () => {
  const { impl, calls } = stub(() => new Response(null, { status: 503 }));

  const res = await safeFetch(PUBLIC, { timeoutMs: 5000, fetchImpl: impl });

  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

/* ---------------------- integration: API endpoint monitor ---------------------- */

test("an API check that is redirected to loopback is reported as blocked", async () => {
  const { impl, calls } = stub(() => redirect("http://127.0.0.1:9000/metrics"));

  const res = await checkApi(
    { id: "api-1", name: "Health", url: PUBLIC, method: "GET" },
    impl,
  );

  assert.equal(res.state, "down");
  assert.equal(res.errorType, "redirect_blocked");
  assert.equal(res.httpStatus, null);
  assert.equal(calls.length, 1, "the internal destination must never be requested");
  assert.match(res.error ?? "", /Internal \/ local destinations are not allowed/);
});

test("an API check that is redirected to a public endpoint stays healthy", async () => {
  const { impl } = stub((url) =>
    url === PUBLIC ? redirect(PUBLIC_2) : new Response(null, { status: 200 }),
  );

  const res = await checkApi(
    { id: "api-1", name: "Health", url: PUBLIC, method: "GET" },
    impl,
  );

  assert.equal(res.state, "healthy");
  assert.equal(res.httpStatus, 200);
});

test("a refused redirect keeps its own error kind through classification", () => {
  const blocked = classifyFetchError(
    new SafeFetchError("redirect_blocked", "redirect blocked: internal"),
  );
  assert.deepEqual(blocked, {
    type: "redirect_blocked",
    message: "redirect blocked: internal",
  });

  // Ordinary failures still classify exactly as before.
  assert.equal(classifyFetchError(new Error("ECONNREFUSED")).type, "network");
});
