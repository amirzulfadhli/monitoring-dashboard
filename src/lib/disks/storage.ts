/**
 * Persistence for local disk/storage observations.
 *
 * Same design as the other monitoring storage modules: the shared connection
 * opens lazily, every call is wrapped so a failure degrades to a no-op, and the
 * rows live in their own `storage_volume_checks` table in the one DevPulse
 * database.
 *
 * One row per observed volume per collection — capacity figures only. No file,
 * folder, file name or directory size is stored, and raw command output never
 * reaches this module: it receives normalized volumes.
 */

import { getDb } from "@/lib/db";
import { maybePruneExpired } from "@/lib/maintenance";

import type { DiskState, DiskVolume, StorageSnapshot } from "./model";

/** Persist one observation, one row per volume. Never throws. */
export function persistStorageSnapshot(s: StorageSnapshot): boolean {
  const d = getDb();
  if (!d) return false;
  // Opportunistic retention (guarded to ~once/day) rides the write path.
  maybePruneExpired();
  try {
    const insert = d.prepare(
      `INSERT OR IGNORE INTO storage_volume_checks
         (ts, volumeId, platform, filesystem, totalBytes, usedBytes, freeBytes, usagePct, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const v of s.volumes) {
      insert.run(
        s.collectedAt,
        v.id,
        s.platform,
        v.filesystem,
        v.totalBytes,
        v.usedBytes,
        v.freeBytes,
        v.usagePct,
        v.state,
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** A stored volume row, used to derive utilization transitions. */
export type StoredVolumeCheck = DiskVolume & {
  ts: number;
  platform: string;
};

type VolumeRow = {
  ts: number;
  volumeId: string;
  platform: string;
  filesystem: string | null;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePct: number;
  state: string;
};

const COLUMNS = `ts, volumeId, platform, filesystem, totalBytes, usedBytes, freeBytes, usagePct, state`;

function toCheck(r: VolumeRow): StoredVolumeCheck {
  return {
    ts: r.ts,
    platform: r.platform,
    id: r.volumeId,
    filesystem: r.filesystem,
    totalBytes: r.totalBytes,
    usedBytes: r.usedBytes,
    freeBytes: r.freeBytes,
    usagePct: r.usagePct,
    state: (r.state === "critical" || r.state === "warning" ? r.state : "normal") as DiskState,
  };
}

/**
 * Raw persisted volume rows within the trailing window (ts >= since), oldest
 * first. Backs the History timeline's per-volume threshold transition
 * derivation. Returns [] on no data or DB failure — never throws.
 */
export function readStorageChecks(since: number): StoredVolumeCheck[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = d
      .prepare(
        `SELECT ${COLUMNS}
           FROM storage_volume_checks
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(since) as VolumeRow[];
    return rows.map(toCheck);
  } catch {
    return [];
  }
}

/**
 * The most recent complete observation: every volume row written at the newest
 * stored timestamp. A partially written later collection cannot exist (one
 * statement per row inside a single call), but reading per-timestamp rather than
 * per-volume keeps the returned set a real observation of one moment.
 *
 * Returns null on no data or DB failure.
 */
export function readLatestStorageSnapshot(): StorageSnapshot | null {
  const d = getDb();
  if (!d) return null;
  try {
    const newest = d
      .prepare(`SELECT MAX(ts) AS ts FROM storage_volume_checks`)
      .get() as { ts: number | null } | undefined;
    const ts = newest?.ts ?? null;
    if (ts == null) return null;

    const rows = d
      .prepare(`SELECT ${COLUMNS} FROM storage_volume_checks WHERE ts = ? ORDER BY volumeId ASC`)
      .all(ts) as VolumeRow[];
    if (rows.length === 0) return null;

    const checks = rows.map(toCheck);
    return {
      collectedAt: ts,
      platform: checks[0].platform,
      available: true,
      reason: null,
      // Rebuilt field by field rather than spread-with-omit: only the volume
      // facts are served, never the row's bookkeeping columns.
      volumes: checks.map((c) => ({
        id: c.id,
        filesystem: c.filesystem,
        totalBytes: c.totalBytes,
        usedBytes: c.usedBytes,
        freeBytes: c.freeBytes,
        usagePct: c.usagePct,
        state: c.state,
      })),
    };
  } catch {
    return null;
  }
}
