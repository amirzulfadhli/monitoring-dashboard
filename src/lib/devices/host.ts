/**
 * Host normalization — the security boundary for device monitoring.
 *
 * Kept in its own module, separate from `model.ts`, because it is the only part
 * of the device model that needs a runtime (`node:net`) import: `model.ts` is
 * imported by client components for its types and its device-type constants, so
 * anything Node-only must not live there. This file is server-only.
 *
 * This is the single place a host enters DevPulse, so it is deliberately strict.
 * A configured host is *data*, never a command: whatever passes here is later
 * handed to `ping` as one separate argv element with `shell: false` (see
 * reachability.ts), and nothing here produces a command line.
 */

import { isIP } from "node:net";

/** Longest host accepted: the DNS name limit. */
export const MAX_HOST_LENGTH = 253;

/** One DNS label: alphanumeric ends, hyphens inside, at most 63 chars. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);

/**
 * Normalize a user-supplied device host to a canonical hostname or IP literal,
 * or return null when it is not an acceptable target.
 *
 * The accepted alphabet is `[a-z0-9.-]` for hostnames plus the literals `isIP`
 * recognizes, which means none of the following can ever be stored:
 *
 *   - shell metacharacters, whitespace, quotes or backticks
 *   - a leading `-` (so a host can never be read as a `ping` flag)
 *   - a URL scheme, path, credential or query (`/`, `:`, `@` are not in the set)
 *   - a CIDR block, range or wildcard (`/`, `*` are not in the set), so device
 *     monitoring can never become address-range scanning; a dash form
 *     (`192.168.0.0-192.168.0.255`) is refused too, as address-shaped input
 *
 * A single trailing root dot is dropped (`host.` and `host` are the same name),
 * and the result is lowercased so two spellings of one host collapse to one.
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > MAX_HOST_LENGTH) return null;

  const kind = isIP(h);
  if (kind === 4 || kind === 6) return h;

  // Anything built only from digits, dots and hyphens is address-shaped, not a
  // name: a malformed literal ("999.1.1.1", "010.0.0.1") or a range expression
  // ("192.168.0.0-192.168.0.255"). A real hostname always has a letter, so this
  // keeps address-shaped input — including range notation — out of configuration
  // entirely rather than storing a target that can never answer.
  if (/^[0-9.-]+$/.test(h)) return null;

  return HOSTNAME_RE.test(h) ? h : null;
}

/** Human-readable reason a host was refused, or null when it is acceptable. */
export function hostError(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "Host is required.";
  if (normalizeHost(raw) === null) {
    return "Host must be a hostname or IP address (no scheme, port, path or ranges).";
  }
  return null;
}
