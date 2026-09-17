/**
 * Local disk / storage monitoring model.
 *
 * DevPulse observes the capacity of the local machine's fixed volumes and
 * nothing else: a volume identifier, the filesystem when the platform reports
 * one, and the total / used / free byte counts. It deliberately does not look
 * inside a volume — no file names, no folder enumeration, no directory sizes, no
 * file contents and no disk modification of any kind.
 *
 * Everything in this file is pure and dependency-free (no OS access, no DB, no
 * scheduler) so normalization, byte arithmetic and the threshold rules can be
 * exercised directly by tests and reused by the API/UI layer.
 *
 * Honesty rules:
 * - A value the machine did not report is never fabricated. A volume whose
 *   capacity or free space is unreadable is dropped rather than recorded as 0,
 *   because a 0-byte volume would read as "100% full".
 * - Only volumes that are actually reported as locally attached are collected;
 *   removable media with no mounted capacity is not a storage fact.
 */

/** Observable utilization state of one volume. */
export type DiskState = "normal" | "warning" | "critical";

/**
 * Utilization thresholds, centralized here so the state, the alerts and the
 * tests all read the same numbers.
 *
 * Boundaries are inclusive at the lower edge: exactly 80% is a warning and
 * exactly 90% is critical. A nearly-full disk is a monitored condition — it is
 * never a collector failure.
 */
export const DISK_THRESHOLDS = {
  warningPct: 80,
  criticalPct: 90,
} as const;

/** Classify a utilization percentage. Pure, deterministic, no rounding. */
export function diskState(usagePct: number): DiskState {
  if (usagePct >= DISK_THRESHOLDS.criticalPct) return "critical";
  if (usagePct >= DISK_THRESHOLDS.warningPct) return "warning";
  return "normal";
}

/** One normalized volume observation. Every field is a real reported fact. */
export type DiskVolume = {
  /** Stable local identity: a drive letter ("C:") or mount path. */
  id: string;
  /** Reported filesystem, or null when the platform did not report one. */
  filesystem: string | null;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** used / total as a percentage, one decimal place. */
  usagePct: number;
  /** Derived from usagePct and DISK_THRESHOLDS. */
  state: DiskState;
};

/** One complete observation of local storage. */
export type StorageSnapshot = {
  collectedAt: number; // epoch ms
  platform: string;
  /** False when the platform probe could not be read at all. */
  available: boolean;
  /** Short, safe explanation when `available` is false. */
  reason: string | null;
  volumes: DiskVolume[];
};

/* ------------------------------------------------------------------ *
 * Byte handling
 * ------------------------------------------------------------------ */

/**
 * Coerce a reported byte count to a safe non-negative integer.
 *
 * Disk capacities exceed 2^53 only in theory; rejecting unsafe values keeps the
 * arithmetic exact rather than silently losing precision on a number that would
 * be meaningless anyway. Anything non-numeric, negative or fractional NaN-ish
 * yields null, which is how "not reported" stays distinguishable from "zero".
 */
export function toBytes(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d{1,15}$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * Utilization percentage for a volume, or null when it cannot be computed.
 *
 * `free` is clamped into [0, total] first: a platform that reports free space
 * slightly beyond capacity (a known rounding quirk of some filesystem drivers)
 * must not produce a negative usage figure.
 */
export function usagePct(totalBytes: number, freeBytes: number): number | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isFinite(freeBytes)) return null;
  const free = Math.min(Math.max(freeBytes, 0), totalBytes);
  const used = totalBytes - free;
  return Math.round((used / totalBytes) * 1000) / 10;
}

/* ------------------------------------------------------------------ *
 * Volume normalization
 * ------------------------------------------------------------------ */

/** Longest volume identifier kept; anything longer is not a local volume. */
export const MAX_VOLUME_ID_LENGTH = 32;
/** Longest filesystem label kept (e.g. "NTFS", "exFAT"). */
export const MAX_FILESYSTEM_LENGTH = 24;

/**
 * Reduce a reported volume identifier to a short, safe local label.
 *
 * A drive letter or mount path is a single token with no separators beyond the
 * trailing one, so anything else — a UNC path, a device path, a file name, a
 * user directory — is rejected rather than stored. This is what keeps a leaked
 * path from ever reaching the database or the UI.
 */
export function normalizeVolumeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/[\\/]+$/, "");
  if (!trimmed || trimmed.length > MAX_VOLUME_ID_LENGTH) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(trimmed)) return null;
  // A bare drive letter is canonicalized so "c:" and "C:" are one volume.
  return /^[A-Za-z]:$/.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/** Keep a short, plain filesystem label; anything unexpected becomes null. */
export function normalizeFilesystem(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_FILESYSTEM_LENGTH) return null;
  return /^[A-Za-z0-9._ -]+$/.test(trimmed) ? trimmed : null;
}

/** Raw shape as reported by the platform; every field is untrusted. */
export type RawVolume = {
  id?: unknown;
  filesystem?: unknown;
  totalBytes?: unknown;
  freeBytes?: unknown;
};

/**
 * Normalize one reported volume, or null when it is not a usable observation.
 *
 * A volume is only reported when its capacity *and* its free space were both
 * read: without them a utilization figure would be invented, and a volume
 * reported with zero capacity (an empty card reader, an unmounted volume) says
 * nothing about storage.
 */
export function toVolume(raw: RawVolume): DiskVolume | null {
  const id = normalizeVolumeId(raw?.id);
  if (!id) return null;

  const totalBytes = toBytes(raw?.totalBytes);
  if (totalBytes == null || totalBytes <= 0) return null;
  const freeRaw = toBytes(raw?.freeBytes);
  if (freeRaw == null) return null;

  const freeBytes = Math.min(freeRaw, totalBytes);
  const pct = usagePct(totalBytes, freeBytes);
  if (pct == null) return null;

  return {
    id,
    filesystem: normalizeFilesystem(raw?.filesystem),
    totalBytes,
    usedBytes: totalBytes - freeBytes,
    freeBytes,
    usagePct: pct,
    state: diskState(pct),
  };
}

/**
 * Normalize and deduplicate reported volumes.
 *
 * One volume is identified by its normalized id. When the platform reports the
 * same volume twice (a drive letter surfaced by two providers) the entry
 * carrying a filesystem label wins, then the one with the larger capacity —
 * deterministically, so two observations of the same machine compare equal.
 * Output is ordered by id so the API and UI are stable between polls.
 */
export function normalizeVolumes(raw: unknown): DiskVolume[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, DiskVolume>();
  for (const item of raw as RawVolume[]) {
    const v = toVolume(item ?? {});
    if (!v) continue;
    const existing = byId.get(v.id);
    if (!existing) {
      byId.set(v.id, v);
      continue;
    }
    if (!existing.filesystem && v.filesystem) {
      byId.set(v.id, v);
    } else if (!!existing.filesystem === !!v.filesystem && v.totalBytes > existing.totalBytes) {
      byId.set(v.id, v);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** True when the volume list carries no usable observation at all. */
export function noVolumesAvailable(s: Pick<StorageSnapshot, "available" | "volumes">): boolean {
  return !s.available || s.volumes.length === 0;
}
