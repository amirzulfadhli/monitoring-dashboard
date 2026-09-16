/**
 * Safe server-side fetch for monitored targets (websites and API endpoints).
 *
 * A monitored URL is validated when it is configured (no loopback / link-local /
 * RFC1918 / ULA destination, literal or via DNS — see lib/settings/validate).
 * `redirect: "follow"` defeated that: an approved public URL could answer 302
 * with a Location pointing at 127.0.0.1 or a private address, and the runtime
 * would follow it *after* validation had already passed.
 *
 * Redirects are therefore resolved here instead: every hop is resolved against
 * the current URL and re-validated with the exact same rules, and only a small
 * bounded number of hops is followed. The whole chain shares one deadline, so
 * following a redirect cannot multiply the caller's timeout budget, and response
 * bodies are never read.
 */

import { validateWebsiteUrl } from "@/lib/settings/validate";

/** Redirect statuses this helper follows itself. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hops allowed beyond the initial request. Three is the common client default. */
export const MAX_REDIRECTS = 3;

export type RedirectErrorType = "redirect_blocked" | "redirect_limit" | "bad_redirect";

/**
 * Thrown when a redirect must not be followed. Carries a stable `type` so
 * callers can classify the failure without parsing the message. Messages are
 * built from our own text plus the validator's verdict — never from upstream
 * response content.
 */
export class SafeFetchError extends Error {
  readonly type: RedirectErrorType;

  constructor(type: RedirectErrorType, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.type = type;
  }
}

export type SafeFetchOptions = {
  /**
   * Request method. Preserved across hops, except where fetch's own redirect
   * handling would rewrite it: 303 always, and 301/302 for POST, become GET.
   */
  method?: string;
  /** Deadline for the entire chain (all hops), in ms. */
  timeoutMs: number;
  /** Injection point for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Fetch a monitored URL, following at most MAX_REDIRECTS validated hops.
 *
 * Returns the final response — including a 3xx that carries no usable Location,
 * which is the final answer rather than something to chase. Throws what fetch
 * throws (network/timeout), plus SafeFetchError for a disallowed redirect.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions,
): Promise<Response> {
  const fetcher = opts.fetchImpl ?? fetch;
  let method = (opts.method ?? "GET").toUpperCase();
  let current = url;
  // One signal for the whole chain: the caller's timeout bounds total time, not
  // per-hop time, so a redirect loop cannot extend it.
  const signal = AbortSignal.timeout(opts.timeoutMs);

  for (let hop = 0; ; hop++) {
    const res = await fetcher(current, {
      method,
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get("location");
    // No usable Location header: nothing to follow, and the 3xx is returned as
    // the final response (it will classify as an unexpected status).
    if (!location) return res;

    if (hop >= MAX_REDIRECTS) {
      throw new SafeFetchError(
        "redirect_limit",
        `exceeded ${MAX_REDIRECTS} redirects`,
      );
    }

    // Resolved against the current URL, so a relative Location ("/health") is
    // handled like an absolute one. A Location that cannot be parsed at all is
    // refused rather than guessed at.
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new SafeFetchError("bad_redirect", "redirect location is not a valid URL");
    }

    // Identical rules to configuration time: protocol, embedded credentials,
    // literal internal addresses, and DNS resolution to an internal address.
    const blocked = await validateWebsiteUrl(next);
    if (blocked) {
      throw new SafeFetchError("redirect_blocked", `redirect blocked: ${blocked}`);
    }

    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method === "POST")
    ) {
      method = "GET";
    }
    current = next;
  }
}
