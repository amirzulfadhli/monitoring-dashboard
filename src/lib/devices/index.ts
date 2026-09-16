/**
 * Device reachability collector.
 *
 * One collection = check every enabled device once and persist each result.
 * Nothing here authenticates to a device, runs anything on it, scans an address
 * range or probes a port: the entire interaction is one ICMP echo request to
 * each configured host (see reachability.ts).
 *
 * The scheduler owns the cadence; `getDeviceResults()` adds a single-flight +
 * freshness guard so a concurrent API request can never start a duplicate run.
 *
 * A device being unreachable is a *finding about the device*, never a collector
 * failure: the run succeeded at observing it. The collector is failing only
 * when the run itself throws, which is what keeps collector health and device
 * health independent.
 */

import { hostname as osHostname } from "node:os";

import { getEnabledDevices } from "@/lib/settings/service";

import { checkAllDevices, defaultRunner, type ReachabilityRunner } from "./reachability";
import type { DeviceCheckResult } from "./model";

/** Minimum age of a completed collection before another one runs. */
const FRESH_MS = 15_000;

/**
 * Check every enabled device and persist the results. `run` is injectable for
 * tests; production passes the platform ping runner.
 */
export async function collectDevices(
  run: ReachabilityRunner = defaultRunner,
): Promise<DeviceCheckResult[]> {
  // Only currently-enabled devices are checked. Disabling or removing one stops
  // future checks without touching stored device_checks rows.
  const devices = getEnabledDevices();
  return checkAllDevices(devices, run);
}

let cache: { at: number; promise: Promise<DeviceCheckResult[]> } | null = null;

/**
 * Single-flight collection with a short freshness window. A custom runner
 * (tests) always collects directly and never touches the cache.
 */
export function getDeviceResults(
  run: ReachabilityRunner = defaultRunner,
): Promise<DeviceCheckResult[]> {
  if (run !== defaultRunner) return collectDevices(run);

  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.promise;
  const promise = collectDevices(run);
  cache = { at: now, promise };
  // A failed collection must not be replayed from the cache.
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}

/**
 * The machine DevPulse is running on.
 *
 * Reported so the Devices page can name the local host explicitly. Only the
 * hostname and platform are exposed — this is not a second source of system
 * data: CPU, memory and network for this machine continue to come from the
 * existing telemetry system, and nothing is copied into device tables.
 */
export function getLocalMachine(): { hostname: string; platform: string } {
  let hostname = "localhost";
  try {
    hostname = osHostname() || "localhost";
  } catch {
    // A machine that will not report its name must not break the page.
  }
  return { hostname, platform: process.platform };
}

export { DEFAULT_TIMEOUT_MS, MAX_CONCURRENT, MAX_DEVICES_PER_RUN } from "./reachability";
export type { ReachabilityRunner, PingOutcome } from "./reachability";
export type { DeviceCheckResult, DeviceType, MonitorableDevice } from "./model";
