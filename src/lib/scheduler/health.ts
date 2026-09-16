/**
 * Collector health: the single verdict shown for each background collector,
 * plus the error sanitizer that keeps secrets out of that verdict.
 *
 * Deliberately dependency-free and side-effect-free (no scheduler state, no
 * env reads, no imports) so the rules can be exercised directly by tests and
 * imported from both server and client code.
 *
 * Scope note: this describes the *collector*, not what it monitors. A website
 * that is down is collected successfully — the websites job stays healthy. A
 * collector is failing only when its own run threw.
 */

/**
 * healthy  — last run succeeded within the freshness window
 * stale    — no successful run within the window (and not failing/inactive)
 * failing  — the most recent run threw
 * inactive — deliberately not collecting (e.g. a missing token)
 */
export type CollectorState = "healthy" | "stale" | "failing" | "inactive";

export const COLLECTOR_STATE_LABELS: Record<CollectorState, string> = {
  healthy: "Healthy",
  stale: "Stale",
  failing: "Failing",
  inactive: "Inactive",
};

export type CollectorHealthInput = {
  now: number;
  /**
   * When the scheduler started in this process. Used as the freshness
   * reference for a collector that has not completed a run yet, so a job still
   * inside its first cadence window is not reported as stale during boot.
   * `null` means the scheduler never started.
   */
  startedAt: number | null;
  staleAfterMs: number;
  /** Non-null when the collector is deliberately not collecting. */
  inactiveReason: string | null;
  /** Failures since the last success; > 0 means the latest run threw. */
  consecutiveFailures: number;
  lastSuccessAt: number | null;
};

/**
 * The health rules, in precedence order:
 *
 * 1. inactive — an explicit "not collecting" reason always wins, so an
 *    unconfigured integration is never misreported as failing or stale.
 * 2. failing  — the latest run threw. Beats stale: the collector is not merely
 *    behind, it is actively broken, and "failing" is the more useful signal.
 * 3. stale    — the last success (or, before any success, the scheduler start)
 *    is older than the freshness window. Exactly at the boundary is still
 *    fresh; staleness begins strictly after it.
 * 4. healthy  — otherwise.
 */
export function deriveCollectorState(input: CollectorHealthInput): CollectorState {
  if (input.inactiveReason) return "inactive";
  if (input.consecutiveFailures > 0) return "failing";

  const referenceAt = input.lastSuccessAt ?? input.startedAt;
  // Never started at all: nothing is known to be fresh, so report stale.
  if (referenceAt == null) return "stale";
  if (input.now - referenceAt > input.staleAfterMs) return "stale";

  return "healthy";
}

/** Longest sanitized error kept in status; longer messages are truncated. */
export const MAX_ERROR_LENGTH = 200;

/**
 * Credential-shaped substrings, redacted regardless of configuration. These
 * are the token formats the collectors can plausibly receive back from an
 * upstream API error message (GitHub, DeepSeek).
 */
const SECRET_PATTERNS: RegExp[] = [
  // Authorization headers echoed into an error body.
  /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Credentials in a URL query string or body.
  /\b(access_token|refresh_token|api[_-]?key|apikey|token|secret|password|passwd|pwd)=[^&\s"']+/gi,
  // Vendor token shapes.
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
];

/**
 * Reduce an arbitrary thrown value to a short, safe, single-line summary.
 *
 * Two layers of defense: any *configured* secret value is redacted verbatim
 * (so an exact token is gone even if it matches no known pattern), then
 * credential-shaped substrings are redacted generically. Whitespace is
 * collapsed so a multi-line upstream body cannot bloat the status payload.
 */
export function sanitizeErrorMessage(raw: unknown, secrets: readonly string[] = []): string {
  let text = raw instanceof Error ? raw.message : String(raw);

  // Exact configured values first — longest first, so a token that contains a
  // shorter configured value is not left partially redacted.
  const configured = [...secrets]
    .filter((s) => typeof s === "string" && s.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of configured) {
    text = text.split(secret).join("[redacted]");
  }

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, group1?: string) => {
      // Keep the key name for context: "token=abc" -> "token=[redacted]".
      const sep = match.indexOf("=");
      if (sep > 0 && !/^bearer|^basic|^token\s/i.test(match)) {
        return `${match.slice(0, sep + 1)}[redacted]`;
      }
      return typeof group1 === "string" ? `${group1} [redacted]` : "[redacted]";
    });
  }

  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_ERROR_LENGTH) {
    text = `${text.slice(0, MAX_ERROR_LENGTH - 1).trimEnd()}…`;
  }
  return text;
}
