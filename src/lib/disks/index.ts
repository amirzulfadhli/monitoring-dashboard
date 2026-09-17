/**
 * Local disk/storage collector.
 *
 * One collection = read the local fixed volumes (a single read-only query),
 * normalize them and persist the observation. Nothing here scans a volume,
 * enumerates a directory, measures a folder, reads a file name or writes to a
 * disk.
 *
 * The scheduler owns the cadence; `getStorageResults()` adds a single-flight +
 * freshness guard so a concurrent API request can never start a duplicate run.
 *
 * A nearly-full volume is a *finding about the disk*, never a collector failure:
 * the run succeeded at observing it, and the volume's own state (normal /
 * warning / critical) is what reports the condition. The collector is failing
 * only when the run itself throws — which keeps collector health and disk
 * condition independent.
 */

import { noVolumesAvailable } from "./model";
import { persistStorageSnapshot } from "./storage";
import {
  collectWindowsStorage,
  defaultRunner,
  type CommandRunner,
} from "./windows";
import type { StorageSnapshot } from "./model";

/** Minimum age of a completed collection before another one runs. */
const FRESH_MS = 30_000;

/**
 * Read every locally attached fixed volume once and persist the observation.
 * `run` is injectable for tests; production passes the platform runner.
 *
 * Throws only when *no* volume could be read at all — a machine whose storage is
 * entirely unobservable has no snapshot worth storing and should surface as a
 * failing collector rather than as a silently empty page. On an unsupported
 * platform that is exactly what happens, and the scheduler reports the job
 * inactive instead of running it.
 */
export async function collectStorage(
  run: CommandRunner = defaultRunner,
): Promise<StorageSnapshot> {
  const snapshot = await collectWindowsStorage(run);
  if (noVolumesAvailable(snapshot)) {
    throw new Error("no local storage volume could be read");
  }
  persistStorageSnapshot(snapshot);
  return snapshot;
}

let cache: { at: number; promise: Promise<StorageSnapshot> } | null = null;

/**
 * Single-flight collection with a short freshness window. A custom runner
 * (tests) always collects directly and never touches the cache.
 */
export function getStorageResults(
  run: CommandRunner = defaultRunner,
): Promise<StorageSnapshot> {
  if (run !== defaultRunner) return collectStorage(run);

  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.promise;
  const promise = collectStorage(run);
  cache = { at: now, promise };
  // A failed collection must not be replayed from the cache.
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}

export { DISK_THRESHOLDS, diskState, normalizeVolumes } from "./model";
export type { DiskState, DiskVolume, StorageSnapshot, RawVolume } from "./model";
export { parseVolumes } from "./windows";
