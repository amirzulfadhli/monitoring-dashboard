/**
 * Local security collector.
 *
 * One collection = read the local Windows security facts (read-only queries),
 * normalize them, persist the observation, then derive and apply the findings
 * that changed since the previous observation. Nothing here scans a remote host,
 * probes a port, inspects traffic, escalates privileges or changes any system
 * setting.
 *
 * The scheduler owns the cadence; `getSecurityResults()` adds a single-flight +
 * freshness guard so a concurrent request can never start a duplicate run (two
 * overlapping runs would both diff against the same previous snapshot).
 */

import { deriveSecurityFindings } from "./findings";
import { allCapabilitiesUnavailable, type SecuritySnapshot } from "./model";
import {
  applySecurityFindings,
  persistSecuritySnapshot,
  readLatestSecuritySnapshot,
} from "./storage";
import { collectWindowsSecurity, defaultRunner, type CommandRunner } from "./windows";

/** Minimum age of a completed collection before another one runs. */
const FRESH_MS = 30_000;

/**
 * Collect once, persist, and apply the resulting findings. `run` is injectable
 * for tests; production passes the platform runner.
 *
 * Throws only when *no* capability could be read at all — a machine where
 * nothing is observable has no snapshot worth storing and should surface as a
 * failing collector rather than as an empty, silently "protected" page. A single
 * unavailable capability (no Defender module, no NetTCPIP cmdlets) is reported
 * inside the snapshot instead and does not fail the run.
 */
export async function collectSecurity(
  run: CommandRunner = defaultRunner,
): Promise<SecuritySnapshot> {
  // Read the previous observation before persisting this one: the port diff is
  // derived from exactly these two snapshots.
  const previous = readLatestSecuritySnapshot();
  const snapshot = await collectWindowsSecurity(run);
  if (allCapabilitiesUnavailable(snapshot)) {
    throw new Error("no local security capability could be read");
  }

  persistSecuritySnapshot(snapshot);
  applySecurityFindings(
    deriveSecurityFindings({ previous, current: snapshot }),
    snapshot.collectedAt,
  );
  return snapshot;
}

let cache: { at: number; promise: Promise<SecuritySnapshot> } | null = null;

/**
 * Single-flight collection with a short freshness window. A custom runner
 * (tests) always collects directly and never touches the cache.
 */
export function getSecurityResults(
  run: CommandRunner = defaultRunner,
): Promise<SecuritySnapshot> {
  if (run !== defaultRunner) return collectSecurity(run);

  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.promise;
  const promise = collectSecurity(run);
  cache = { at: now, promise };
  // A failed collection must not be replayed from the cache.
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}
