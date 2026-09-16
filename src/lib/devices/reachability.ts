/**
 * Bounded, non-invasive reachability checks.
 *
 * One check is exactly one ICMP echo request to exactly one configured host,
 * using the platform's own `ping`. There is no subnet sweep, no port probe, no
 * address-range iteration, no service banner read, no remote command and no
 * target modification — the only thing DevPulse does to a device is ask the
 * network whether it answers.
 *
 * Command safety is structural rather than a filtering step:
 *   - the binary is a fixed literal, never derived from configuration;
 *   - the arguments are a fixed literal array plus the host;
 *   - the host is passed as its own argv element to `spawn` with
 *     `shell: false`, so there is no shell to interpret it;
 *   - it is always an operand, never an option: the host charset (see
 *     model.normalizeHost) cannot begin with `-`, so it cannot be read as a
 *     flag.
 * No command string is ever built, concatenated or interpolated.
 *
 * Child output is used for one thing only: extracting a latency *number* with a
 * strictly numeric capture group. Ping's own text is never parsed for meaning,
 * never stored and never served — every persisted reason is one of our own
 * fixed labels or a sanitized local spawn error.
 */

import { spawn } from "node:child_process";

import {
  MAX_REASON_LENGTH,
  REASON_TIMEOUT,
  REASON_UNREACHABLE,
  sanitizeReason,
  type DeviceCheckResult,
  type DeviceErrorType,
  type MonitorableDevice,
} from "./model";
import { normalizeHost } from "./host";
import { persistDeviceCheck } from "./storage";

/** Per-check deadline. A device that is down must not stall the whole run. */
export const DEFAULT_TIMEOUT_MS = 3_000;

/** Hard ceiling, independent of anything configured. */
export const MAX_TIMEOUT_MS = 10_000;

/** Extra time on top of ping's own timeout before the child is killed. */
const TIMEOUT_GRACE_MS = 1_500;

/** Devices checked concurrently. Deliberately small: this is ICMP, not a scan. */
export const MAX_CONCURRENT = 4;

/** Devices checked in one run. Bounds a single collection. */
export const MAX_DEVICES_PER_RUN = 50;

/** Cap on buffered stdout; ping output is small and only a number is wanted. */
const MAX_OUTPUT_BYTES = 4_096;

export type PingOutcome = {
  reachable: boolean;
  latencyMs: number | null;
  errorType: DeviceErrorType | null;
  error: string | null;
};

/** Runs one bounded check against one host. Injectable so tests never ping. */
export type ReachabilityRunner = (
  host: string,
  timeoutMs: number,
) => Promise<PingOutcome>;

/* ------------------------------------------------------------------ *
 * Argument construction (pure, exported for tests)
 * ------------------------------------------------------------------ */

/**
 * The argv passed to the platform ping. Options are literal constants; the host
 * is the final, separate operand. `-n 1` / `-c 1` sends exactly one echo
 * request — never a count, interval or range that could be scaled into a sweep.
 */
export function pingArgs(host: string, timeoutMs: number, platform: string): string[] {
  if (platform === "win32") {
    return ["-n", "1", "-w", String(timeoutMs), host];
  }
  // POSIX ping takes a whole-second timeout; at least one second.
  return ["-c", "1", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
}

/**
 * Extract a latency in ms from ping output.
 *
 * The capture group is strictly numeric, so nothing else from the output can
 * survive this function. A "less than" form (`time<1ms`) reports its bound,
 * which is the most the reply actually states.
 */
export function parseLatency(stdout: string): number | null {
  const m = /time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i.exec(stdout);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

const unreachable = (errorType: DeviceErrorType, error: string): PingOutcome => ({
  reachable: false,
  latencyMs: null,
  errorType,
  error,
});

function spawnFailure(e: unknown): PingOutcome {
  return unreachable("spawn_failed", sanitizeReason(e));
}

/**
 * Run one check. Never throws and never rejects: every failure is an
 * unreachable outcome.
 */
export function runPing(
  host: string,
  timeoutMs: number,
  platform: string = process.platform,
): Promise<PingOutcome> {
  return new Promise((resolve) => {
    const binary = platform === "win32" ? "ping.exe" : "ping";
    let child;
    try {
      child = spawn(binary, pingArgs(host, timeoutMs, platform), {
        windowsHide: true,
        // Explicit: the host is argv data. There is no shell in this call.
        shell: false,
      });
    } catch (e) {
      resolve(spawnFailure(e));
      return;
    }

    let stdout = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (o: PingOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone; the timeout verdict below is what matters.
      }
      finish(unreachable("timeout", REASON_TIMEOUT));
    }, Math.min(timeoutMs, MAX_TIMEOUT_MS) + TIMEOUT_GRACE_MS);

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString("utf8");
    });
    // Drained, never read: ping's diagnostics are not a stored fact.
    child.stderr?.on("data", () => {});

    child.on("error", (e) => finish(spawnFailure(e)));
    child.on("close", (code) => {
      // Classification is by exit status alone. Exit 0 means the host answered.
      if (code === 0) {
        finish({
          reachable: true,
          latencyMs: parseLatency(stdout),
          errorType: null,
          error: null,
        });
      } else {
        finish(unreachable("unreachable", REASON_UNREACHABLE));
      }
    });
  });
}

/** The production runner: the platform ping, one echo request per device. */
export const defaultRunner: ReachabilityRunner = (host, timeoutMs) =>
  runPing(host, timeoutMs);

/* ------------------------------------------------------------------ *
 * One device / all devices
 * ------------------------------------------------------------------ */

/**
 * Check one device. Never throws. A device whose stored host is not a valid
 * target is reported unreachable without spawning anything at all — config
 * validation makes that unreachable in practice, and this branch guarantees it.
 */
export async function checkDevice(
  device: MonitorableDevice,
  run: ReachabilityRunner = defaultRunner,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DeviceCheckResult> {
  const checkedAt = Date.now();
  const host = normalizeHost(device.host);
  if (host === null) {
    return {
      device,
      checkedAt,
      reachable: false,
      latencyMs: null,
      errorType: "unreachable",
      error: "Configured host is not a valid hostname or IP address.",
    };
  }

  const bounded = Math.min(Math.max(1, Math.round(timeoutMs)), MAX_TIMEOUT_MS);
  try {
    const outcome = await run(host, bounded);
    return {
      device,
      checkedAt,
      reachable: outcome.reachable,
      latencyMs: outcome.latencyMs,
      errorType: outcome.errorType,
      // Re-sanitized here so a custom runner cannot smuggle raw text through.
      error:
        outcome.error == null
          ? null
          : sanitizeReason(outcome.error).slice(0, MAX_REASON_LENGTH),
    };
  } catch (e) {
    return {
      device,
      checkedAt,
      reachable: false,
      latencyMs: null,
      errorType: "spawn_failed",
      error: sanitizeReason(e),
    };
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 * Used so a large device list cannot put an unbounded number of pings on the
 * network at once.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Check every device concurrently (bounded) and persist each result
 * independently. One device failing — at the network or at storage — never
 * stops the others from being checked.
 */
export async function checkAllDevices(
  devices: MonitorableDevice[],
  run: ReachabilityRunner = defaultRunner,
): Promise<DeviceCheckResult[]> {
  const targets = devices.slice(0, MAX_DEVICES_PER_RUN);
  const results = await mapWithConcurrency(targets, MAX_CONCURRENT, (device) =>
    checkDevice(device, run),
  );
  for (const r of results) {
    try {
      persistDeviceCheck(r);
    } catch {
      // Persistence must never break live checks.
    }
  }
  return results;
}
