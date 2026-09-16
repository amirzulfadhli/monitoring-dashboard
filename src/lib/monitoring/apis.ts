/**
 * API endpoint monitoring.
 *
 * Deliberately a sibling of the website monitor rather than a generalization of
 * it: the two share their shape (bounded timeout, deterministic classification,
 * per-target isolation, sanitized errors) but an API check additionally carries
 * a method and a per-target timeout. Nothing about request bodies, custom
 * headers, credentials or secret storage exists here — a check is always a
 * bodiless GET/HEAD/POST against a URL that already passed the SSRF validator
 * when it was configured.
 *
 * Response bodies are never read, never buffered and never stored: only the
 * status, the latency and a short sanitized error survive a check.
 */

import { getEnabledApis } from "@/lib/settings/service";
import { sanitizeErrorMessage } from "@/lib/scheduler/health";

import { persistApiCheck, type ApiCheckRow } from "./api-storage";

/** Explicit thresholds live here, in one place. */
const DEFAULT_TIMEOUT_MS = 8000; // a broken endpoint must never stall the check
const MAX_TIMEOUT_MS = 30_000; // hard ceiling, independent of configuration
const DEGRADED_LATENCY_MS = 1500; // above this a successful check is Degraded
const DEFAULT_EXPECTED_STATUS = 200;

// Minimum age of a completed check before a fresh one runs. The page polls every
// ~20s, so this collapses near-simultaneous requests into a single check run
// without ever producing a duplicate while one is in flight.
const FRESH_MS = 10_000;

export type ApiState = "healthy" | "degraded" | "down";

/** A configured endpoint, as the monitor sees it. */
export type ApiTarget = {
  id: string;
  name: string;
  url: string;
  method: string;
  /** HTTP status that counts as Healthy. Omitted => 200. */
  expectedStatus?: number;
  /** Per-request timeout in ms. Omitted => the monitor default. */
  timeoutMs?: number;
};

export type ApiCheckResult = {
  api: ApiTarget;
  host: string | null; // hostname of the target, for display
  checkedAt: number; // epoch ms
  state: ApiState;
  httpStatus: number | null;
  latencyMs: number | null; // null when the request never completed
  errorType: string | null; // timeout | network | unexpected_status | bad_config
  error: string | null;
};

type ErrorKind = { type: string; message: string };

/** Reject unsupported protocols / unparsable URLs before any network I/O. */
export function apiConfigError(url: string, method: string): ErrorKind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { type: "bad_config", message: `invalid url: ${url}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { type: "bad_config", message: `unsupported protocol: ${u.protocol}` };
  }
  if (!["GET", "HEAD", "POST"].includes(method)) {
    return { type: "bad_config", message: `unsupported method: ${method}` };
  }
  return null;
}

/** The configured timeout, always inside the hard ceiling. */
export function resolveTimeoutMs(configured?: number | null): number {
  if (configured == null || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.round(configured), MAX_TIMEOUT_MS);
}

/**
 * Deterministic classification from observed facts — no heuristics, no AI.
 *
 *   expected status                -> healthy (or degraded when slow)
 *   unexpected status              -> down
 *   timeout / network / DNS error  -> down
 */
export function classifyApiCheck(input: {
  httpStatus: number | null;
  latencyMs: number | null;
  expectedStatus: number;
  /** Set by the error path; describes why no status was observed. */
  failure?: ErrorKind | null;
}): { state: ApiState; errorType: string | null; error: string | null } {
  if (input.httpStatus === null) {
    // Unreachable: the failure that caused it is already classified.
    const f = input.failure ?? null;
    return { state: "down", errorType: f?.type ?? null, error: f?.message ?? null };
  }
  if (input.httpStatus !== input.expectedStatus) {
    return {
      state: "down",
      errorType: "unexpected_status",
      error: `expected ${input.expectedStatus}, got ${input.httpStatus}`,
    };
  }
  if (input.latencyMs !== null && input.latencyMs > DEGRADED_LATENCY_MS) {
    return { state: "degraded", errorType: null, error: null };
  }
  return { state: "healthy", errorType: null, error: null };
}

/**
 * Turn a thrown fetch error into a short, sanitized kind + message. Message
 * text can echo upstream content, so it is passed through the project's
 * credential sanitizer before it is ever stored or served.
 */
export function classifyFetchError(e: unknown): ErrorKind {
  const err = e as Error & { name?: string };
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
  if (timedOut) return { type: "timeout", message: "request timed out" };
  return {
    type: "network",
    message: sanitizeErrorMessage(err?.message || "network error"),
  };
}

/** The persisted shape of one check. Contains no response body, ever. */
export function toApiCheckRow(r: ApiCheckResult): ApiCheckRow {
  return {
    ts: r.checkedAt,
    targetId: r.api.id,
    state: r.state,
    httpStatus: r.httpStatus,
    latencyMs: r.latencyMs,
    errorType: r.errorType,
    error: r.error,
  };
}

/**
 * Check a single endpoint. Never throws — every failure becomes a Down result.
 * `fetchImpl` is injectable so tests can drive every outcome without a network.
 */
export async function checkApi(
  api: ApiTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiCheckResult> {
  const checkedAt = Date.now();
  const method = (api.method || "GET").toUpperCase();
  const cfgErr = apiConfigError(api.url, method);
  let host: string | null = null;
  try {
    host = cfgErr ? null : new URL(api.url).hostname;
  } catch {
    host = null;
  }
  const expected = api.expectedStatus ?? DEFAULT_EXPECTED_STATUS;
  if (cfgErr) {
    return {
      api,
      host,
      checkedAt,
      state: "down",
      httpStatus: null,
      latencyMs: null,
      errorType: cfgErr.type,
      error: cfgErr.message,
    };
  }

  const start = Date.now();
  try {
    // No body, no headers, no credentials: the request surface is the method,
    // the URL and a bounded timeout. The response body is never read.
    const res = await fetchImpl(api.url, {
      method,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(resolveTimeoutMs(api.timeoutMs)),
    });
    const latencyMs = Date.now() - start;
    const c = classifyApiCheck({ httpStatus: res.status, latencyMs, expectedStatus: expected });
    return {
      api,
      host,
      checkedAt,
      state: c.state,
      httpStatus: res.status,
      latencyMs,
      errorType: c.errorType,
      error: c.error,
    };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const failure = classifyFetchError(e);
    const c = classifyApiCheck({
      httpStatus: null,
      latencyMs,
      expectedStatus: expected,
      failure,
    });
    return {
      api,
      host,
      checkedAt,
      state: c.state,
      httpStatus: null,
      latencyMs,
      errorType: c.errorType,
      error: c.error,
    };
  }
}

/**
 * Check every enabled endpoint concurrently. Each is isolated: one failure
 * (fetch or persistence) never stops the others from being checked.
 * `fetchImpl` is injectable for tests only.
 */
export async function checkAllApis(
  fetchImpl: typeof fetch = fetch,
): Promise<ApiCheckResult[]> {
  const checkedAt = Date.now();
  // Only currently-enabled targets are checked. Disabling or removing a monitor
  // stops future checks without touching stored api_checks rows.
  const targets = getEnabledApis();
  const results = await Promise.all(
    targets.map(async (api) => {
      try {
        return await checkApi(api, fetchImpl);
      } catch {
        return {
          api,
          host: null,
          checkedAt,
          state: "down" as ApiState,
          httpStatus: null,
          latencyMs: null,
          errorType: "network",
          error: "check failed",
        };
      }
    }),
  );
  // Persist independently so a storage failure on one target is isolated.
  for (const r of results) {
    try {
      persistApiCheck(toApiCheckRow(r));
    } catch {
      // Persistence must never break live checks.
    }
  }
  return results;
}

// Single-flight + freshness guard so concurrent/near-simultaneous requests share
// one in-flight check instead of each triggering a duplicate run.
let cache: { at: number; promise: Promise<ApiCheckResult[]> } | null = null;

export function getApiResults(): Promise<ApiCheckResult[]> {
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.promise;
  cache = { at: now, promise: checkAllApis() };
  return cache.promise;
}
