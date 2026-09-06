import { getEnabledSites } from "@/lib/settings/service";
import { type MonitoredSite } from "@/data/monitored-sites";
import {
  persistWebsiteCheck,
  type WebsiteCheckRow,
} from "./storage";

// Explicit thresholds live here, in one place.
const HTTP_TIMEOUT_MS = 8000; // a broken service must never stall the check indefinitely
const DEGRADED_LATENCY_MS = 1500; // above this a successful check counts as Degraded
const DEFAULT_EXPECTED_STATUS = 200;

// Minimum age of a completed check before we run a fresh one. The page polls
// every ~20s, so this is enough to collapse near-simultaneous requests into a
// single check without ever producing a duplicate while one is in flight.
const FRESH_MS = 10_000;

export type WebsiteState = "healthy" | "degraded" | "down";

export type CheckResult = {
  site: MonitoredSite;
  host: string | null; // domain of the target, for display
  checkedAt: number; // epoch ms
  state: WebsiteState;
  httpStatus: number | null;
  latencyMs: number | null; // null when the request never completed
  errorType: string | null; // timeout | network | unexpected_status | bad_config
  error: string | null;
};

type ErrorKind = { type: string; message: string };

/** Reject unsupported protocols / unparsable URLs before any network I/O. */
function configError(url: string): ErrorKind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { type: "bad_config", message: `invalid url: ${url}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      type: "bad_config",
      message: `unsupported protocol: ${u.protocol}`,
    };
  }
  return null;
}

/** Deterministic classification from observed facts — no heuristics/AI. */
function classify(
  httpStatus: number | null,
  latencyMs: number | null,
  expected: number,
): { state: WebsiteState; errorType: string | null; error: string | null } {
  if (httpStatus === null) {
    // Unreachable; errorType/error filled by the fetch error handler.
    return { state: "down", errorType: null, error: null };
  }
  if (httpStatus !== expected) {
    return {
      state: "down",
      errorType: "unexpected_status",
      error: `expected ${expected}, got ${httpStatus}`,
    };
  }
  if (latencyMs !== null && latencyMs > DEGRADED_LATENCY_MS) {
    return { state: "degraded", errorType: null, error: null };
  }
  return { state: "healthy", errorType: null, error: null };
}

/** Check a single site. Never throws — every failure becomes a Down result. */
async function checkSite(site: MonitoredSite): Promise<CheckResult> {
  const checkedAt = Date.now();
  const cfgErr = configError(site.url);
  let host: string | null = null;
  try {
    host = cfgErr ? null : new URL(site.url).hostname;
  } catch {
    host = null;
  }
  if (cfgErr) {
    return {
      site,
      host,
      checkedAt,
      state: "down",
      httpStatus: null,
      latencyMs: null,
      errorType: cfgErr.type,
      error: cfgErr.message,
    };
  }

  const expected = site.expectedStatus ?? DEFAULT_EXPECTED_STATUS;
  const start = Date.now();
  try {
    const res = await fetch(site.url, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    const c = classify(res.status, latencyMs, expected);
    return {
      site,
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
    const err = e as Error & { name?: string };
    const timedOut =
      err?.name === "TimeoutError" || err?.name === "AbortError";
    const kind = timedOut
      ? { type: "timeout", message: "request timed out" }
      : { type: "network", message: err?.message || "network error" };
    const c = classify(null, latencyMs, expected);
    return {
      site,
      host,
      checkedAt,
      state: c.state,
      httpStatus: null,
      latencyMs,
      errorType: kind.type,
      error: kind.message,
    };
  }
}

/**
 * Check every configured target concurrently. Each is isolated: one failure
 * (fetch or persistence) never stops the others from being checked.
 */
async function checkAllSites(): Promise<CheckResult[]> {
  const checkedAt = Date.now();
  // Only currently-enabled persisted targets are ever checked. Removal from
  // Settings stops future checks without touching stored website_checks.
  const targets = getEnabledSites();
  const results = await Promise.all(
    targets.map(async (site) => {
      try {
        return await checkSite(site);
      } catch {
        return {
          site,
          host: null,
          checkedAt,
          state: "down" as WebsiteState,
          httpStatus: null,
          latencyMs: null,
          errorType: "network",
          error: "check failed",
        };
      }
    }),
  );
  // Persist each independently so a storage failure on one target is isolated.
  for (const r of results) {
    const row: WebsiteCheckRow = {
      ts: r.checkedAt,
      targetId: r.site.id,
      state: r.state,
      httpStatus: r.httpStatus,
      latencyMs: r.latencyMs,
      errorType: r.errorType,
      error: r.error,
    };
    try {
      persistWebsiteCheck(row);
    } catch {
      // Persistence must never break live checks.
    }
  }
  return results;
}

// Single-flight + freshness guard so concurrent/near-simultaneous requests
// share one in-flight check instead of each triggering a duplicate.
let cache: { at: number; promise: Promise<CheckResult[]> } | null = null;

export function getWebsiteResults(): Promise<CheckResult[]> {
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.promise;
  cache = { at: now, promise: checkAllSites() };
  return cache.promise;
}
