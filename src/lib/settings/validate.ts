/**
 * Server-side validation for configuration mutations.
 *
 * Websites are now stored in Settings rather than hard-coded, so the trust
 * boundary changes: what used to be hand-written source now arrives over the
 * local API. These helpers keep that surface narrow — no arbitrary fetch
 * endpoint is created, and configured URLs are still only ever read back by the
 * monitor from persisted rows. Reasonable SSRF protection rejects obvious
 * loopback / link-local / private (RFC1918) destinations at configuration time.
 *
 * Every function returns an error string, or null when the input is valid. No
 * secrets are ever involved.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { API_METHODS } from "./types";

/* ------------------------------------------------------------------ *
 * IP classification (no dependency; only obvious private/loopback ranges)
 * ------------------------------------------------------------------ */

/** True when a literal IP is loopback, link-local, or RFC1918 private. */
function isBlockedIp(ip: string): boolean {
  const v4 = ip.includes(".") ? ip : null;
  if (v4) {
    const parts = v4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return false; // malformed literal -> let URL/DNS handling decide
    }
    const [a, b] = parts;
    // 127.0.0.0/8 loopback, 10/8, 172.16/12, 192.168/16, 169.254/16 link-local,
    // 0.0.0.0 (unspecified).
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6: IPv4-mapped ("::ffff:a.b.c.d"), loopback, unspecified, link-local,
  // and the IPv4-mapped private/loopback forms.
  const lower = ip.toLowerCase();
  if (lower.includes("::ffff:")) {
    const tail = lower.slice(lower.lastIndexOf(":") + 1);
    const mapped = isIP(tail) === 4 ? tail : "";
    if (mapped) return isBlockedIp(mapped);
    return false;
  }
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  return false;
}

/** Reject hostname forms that are obviously internal. */
function blockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return false;
}

/** Check one resolved address against the blocked set; also parses literals. */
function blockedAddress(host: string): boolean {
  const kind = isIP(host);
  if (kind === 0) return blockedHostname(host);
  return isBlockedIp(host);
}

/**
 * Validate a monitored-website URL: must parse, be http/https, and not point at
 * a loopback / link-local / private (RFC1918) destination. Resolves DNS so a
 * public hostname resolving to an internal address is also rejected. Returns an
 * error message, or null when safe to store.
 */
export async function validateWebsiteUrl(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return "Not a valid URL.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Only http:// and https:// URLs are allowed.";
  }
  if (!u.hostname) return "URL must include a host.";

  // Cheap literal / name guard first — no DNS needed for obvious cases.
  if (blockedAddress(u.hostname)) {
    return "Internal / local destinations are not allowed.";
  }
  if (u.username || u.password) {
    return "URL must not embed credentials.";
  }

  // Resolve the host and confirm none of its addresses is internal. On failure
  // to resolve we reject — a non-resolving target is not a usable monitor.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(u.hostname, { all: true });
  } catch {
    return "Host could not be resolved.";
  }
  if (addresses.some(({ address }) => blockedAddress(address))) {
    return "Internal / local destinations are not allowed.";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Field validators
 * ------------------------------------------------------------------ */

export function validateWebsiteName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Display name is required.";
  if (n.length > 120) return "Display name is too long.";
  return null;
}

export function validateExpectedStatus(v: number | null | undefined): string | null {
  if (v == null) return null; // null means "use the default"
  if (!Number.isInteger(v) || v < 100 || v > 599) {
    return "Expected status must be an integer between 100 and 599.";
  }
  return null;
}

export function validateWebsiteFields(input: {
  name: string;
  url: string;
  expectedStatus?: number | null;
}): Promise<string | null> {
  const byName = validateWebsiteName(input.name);
  if (byName) return Promise.resolve(byName);
  const byStatus = validateExpectedStatus(input.expectedStatus);
  if (byStatus) return Promise.resolve(byStatus);
  return validateWebsiteUrl(input.url);
}

/* ------------------------------------------------------------------ *
 * API endpoint monitors
 *
 * The same trust boundary as websites applies: a URL typed into Settings is
 * later fetched server-side, so it goes through the identical SSRF check. The
 * request surface stays deliberately narrow — a method from a fixed allow-list,
 * no body, no headers, no credentials.
 * ------------------------------------------------------------------ */

/** Per-request timeout bounds for API checks. */
export const MIN_API_TIMEOUT_MS = 1_000;
export const MAX_API_TIMEOUT_MS = 30_000;

export function validateApiMethod(method: unknown): string | null {
  if (typeof method !== "string") return "Method is required.";
  if (!(API_METHODS as readonly string[]).includes(method.toUpperCase())) {
    return `Method must be one of ${API_METHODS.join(", ")}.`;
  }
  return null;
}

export function validateApiTimeout(v: number | null | undefined): string | null {
  if (v == null) return null; // null means "use the monitor default"
  if (!Number.isInteger(v) || v < MIN_API_TIMEOUT_MS || v > MAX_API_TIMEOUT_MS) {
    return `Timeout must be an integer between ${MIN_API_TIMEOUT_MS} and ${MAX_API_TIMEOUT_MS} ms.`;
  }
  return null;
}

export function validateApiFields(input: {
  name: string;
  url: string;
  method: string;
  expectedStatus?: number | null;
  timeoutMs?: number | null;
}): Promise<string | null> {
  const byName = validateWebsiteName(input.name);
  if (byName) return Promise.resolve(byName);
  const byMethod = validateApiMethod(input.method);
  if (byMethod) return Promise.resolve(byMethod);
  const byStatus = validateExpectedStatus(input.expectedStatus);
  if (byStatus) return Promise.resolve(byStatus);
  const byTimeout = validateApiTimeout(input.timeoutMs);
  if (byTimeout) return Promise.resolve(byTimeout);
  // Same SSRF rules as a monitored website: no loopback / link-local / private
  // destination, literal or via DNS.
  return validateWebsiteUrl(input.url);
}

/** Minimal GitHub owner / repository syntax (no arbitrary URLs, ever). */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

export function validateOwnerRepo(input: {
  owner: string;
  repo: string;
  displayName?: string;
}): string | null {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  if (!owner) return "Owner is required.";
  if (owner.length > 39) return "Owner is too long.";
  if (!OWNER_RE.test(owner)) {
    return "Owner may only contain letters, numbers, and hyphens (not at the ends).";
  }
  if (!repo) return "Repository is required.";
  if (repo.length > 100) return "Repository name is too long.";
  if (!REPO_RE.test(repo)) {
    return "Repository name may only contain letters, numbers, dots, dashes, and underscores.";
  }
  if (input.displayName != null && input.displayName.trim().length > 120) {
    return "Display name is too long.";
  }
  return null;
}

/** 0 < warning < critical <= 100 for a CPU/memory pair. */
function validatePair(warn: number, crit: number): string | null {
  if (!Number.isFinite(warn) || !Number.isFinite(crit)) return "Values must be numbers.";
  if (!(warn > 0) || !(crit > 0)) return "Thresholds must be greater than 0.";
  if (warn >= crit) return "Warning must be below critical.";
  if (crit > 100) return "Critical must be 100 or less.";
  return null;
}

export function validateAlertInput(input: {
  system: { cpuWarnPct: number; cpuCritPct: number; memWarnPct: number; memCritPct: number };
  ai?: { tokenBudget24h: number | null; costBudget24hUsd: number | null };
}): string | null {
  for (const p of [
    validatePair(input.system.cpuWarnPct, input.system.cpuCritPct),
    validatePair(input.system.memWarnPct, input.system.memCritPct),
  ]) {
    if (p) return p;
  }
  if (input.ai) {
    const t = input.ai.tokenBudget24h;
    const c = input.ai.costBudget24hUsd;
    if (t != null && (!Number.isFinite(t) || t <= 0)) {
      return "Token budget must be a positive number.";
    }
    if (c != null && (!Number.isFinite(c) || c <= 0)) {
      return "Cost budget must be a positive number.";
    }
  }
  return null;
}
