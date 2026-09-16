/**
 * Monitored device model.
 *
 * A device is a machine DevPulse knows how to *reach*: a name, a host and a
 * type. Monitoring is reachability only — DevPulse never authenticates to a
 * device, never runs anything on it, never reads its files or processes and
 * never probes more than the one address the user configured.
 *
 * Everything in this file is pure and dependency-free (no OS access, no DB, no
 * scheduler, no `node:` imports) so it can be imported by client components for
 * its types and its device-type constants. Host normalization — the security
 * boundary that keeps a configured host from ever becoming shell syntax — lives
 * in `host.ts` instead, because it needs `node:net` and is server-only.
 *
 * A configured host is *data*, never a command. The only thing that can ever be
 * done with it is be passed as a single, separate argv element to `ping` (see
 * reachability.ts); nothing here produces a command line.
 */

import { sanitizeErrorMessage } from "@/lib/scheduler/health";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export const DEVICE_TYPES = ["computer", "server", "iot", "other"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** The device as the collector and alert engine see it. */
export type MonitorableDevice = {
  id: string;
  name: string;
  host: string;
  type: DeviceType;
};

/**
 * Why a check found the device unreachable. Deliberately a small closed set of
 * our own labels — never a fragment of ping output.
 *
 *   timeout       — the bounded check did not finish in time
 *   unreachable   — the check completed and reported no answer
 *   spawn_failed  — the platform's ping could not be started at all
 */
export type DeviceErrorType = "timeout" | "unreachable" | "spawn_failed";

/** One reachability observation of one device. */
export type DeviceCheckResult = {
  device: MonitorableDevice;
  checkedAt: number; // epoch ms
  reachable: boolean;
  latencyMs: number | null; // null when unreachable or not reported
  errorType: DeviceErrorType | null;
  error: string | null; // short, sanitized, always our own text
};

/** Coerce an arbitrary stored/requested value to a known device type. */
export function deviceTypeOf(raw: unknown): DeviceType {
  return typeof raw === "string" && (DEVICE_TYPES as readonly string[]).includes(raw)
    ? (raw as DeviceType)
    : "other";
}

/* ------------------------------------------------------------------ *
 * Error text
 * ------------------------------------------------------------------ */

/** Longest sanitized reason kept for a check; longer text is truncated. */
export const MAX_REASON_LENGTH = 120;

/**
 * Reduce a thrown value to a short, safe, single-line reason.
 *
 * Only ever applied to local spawn errors (ENOENT and friends) — never to ping
 * output, which is not read for classification at all. The project's credential
 * sanitizer runs first so a machine-specific path or token-shaped string in an
 * exception message cannot reach the database or the page.
 */
export function sanitizeReason(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const cleaned = sanitizeErrorMessage(text || "reachability check failed");
  return cleaned.length > MAX_REASON_LENGTH
    ? `${cleaned.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`
    : cleaned;
}

/* ------------------------------------------------------------------ *
 * Reachability verdicts
 * ------------------------------------------------------------------ */

/**
 * Fixed reasons. Every persisted error is one of these or a sanitized spawn
 * error — ping output is never stored, so a device can never echo machine
 * detail, a path or a command line back into DevPulse.
 */
export const REASON_UNREACHABLE = "No response from host";
export const REASON_TIMEOUT = "Reachability check timed out";

/**
 * True when a device is unreachable *enough* to alert on.
 *
 * This is the anti-spam guard: a single dropped echo request — or one check
 * landing while a machine reboots — must not open an alert. `consecutive`
 * counts the leading run of unreachable checks at the newest end (see
 * storage.readLatestDeviceChecks), so a device that has recovered from a real
 * outage stops satisfying this the moment a check answers again, which is what
 * resolves the alert.
 *
 * A threshold below 1 would alert on any observation, so it is clamped: the
 * engine can never be configured into firing on a single failure.
 */
export function isUnreachableAtThreshold(consecutive: number, threshold: number): boolean {
  const need = Number.isFinite(threshold) ? Math.max(1, Math.round(threshold)) : 1;
  return Number.isFinite(consecutive) && consecutive >= need;
}

/** The state label used by History and the devices table. */
export function reachabilityState(reachable: boolean): "reachable" | "unreachable" {
  return reachable ? "reachable" : "unreachable";
}
