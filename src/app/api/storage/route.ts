import { ensureSchedulerStarted } from "@/lib/scheduler";
import { getLatestStorage } from "@/lib/scheduler/store";
import { getStorageResults } from "@/lib/disks";
import { DISK_THRESHOLDS, type DiskState, type DiskVolume } from "@/lib/disks/model";
import { readLatestStorageSnapshot } from "@/lib/disks/storage";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One volume as served to the Storage page: the observation plus its band. */
export type StorageVolumeView = DiskVolume & { state: DiskState };

/** The read-only shape served by GET /api/storage. */
export type StorageView = {
  generatedAt: number;
  /** False on a non-Windows host: reported instead of collecting nothing. */
  supported: boolean;
  platform: string;
  lastCheckedAt: number | null;
  /** The bands the state is derived from, so the UI never hard-codes them. */
  thresholds: { warningPct: number; criticalPct: number };
  volumes: StorageVolumeView[];
  /** Totals across the observed volumes; null when nothing was observed. */
  totals: {
    volumes: number;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    /** Highest-utilization volume, or null when nothing was observed. */
    highest: { volumeId: string; usagePct: number } | null;
  } | null;
  /** Short explanation when no volume could be observed. */
  reason: string | null;
};

/** The honest "nothing was observed" view, used for both failure modes. */
function unobserved(
  reason: string,
  base: Pick<StorageView, "generatedAt" | "supported" | "platform">,
): StorageView {
  return {
    ...base,
    lastCheckedAt: null,
    thresholds: { ...DISK_THRESHOLDS },
    volumes: [],
    totals: null,
    reason,
  };
}

/**
 * GET /api/storage — the latest local disk observation.
 *
 * Nothing here reads a file, walks a directory or writes to a disk: the response
 * is built from the stored observation, with the same cold-start fallback the
 * other monitors use for the window before the first scheduled collection. On a
 * non-Windows host the route reports `supported: false` rather than pretending
 * to have measured a machine it cannot read.
 */
export async function GET() {
  try {
    ensureSchedulerStarted();
    const generatedAt = Date.now();
    const supported = process.platform === "win32";
    const base = { generatedAt, supported, platform: process.platform };

    if (!supported) {
      return Response.json(
        unobserved(
          `local storage monitoring is Windows-only (platform: ${process.platform})`,
          base,
        ) satisfies StorageView,
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Scheduler-collected snapshot first; the collector is a cold-start
    // fallback, and the stored row is the last resort if that run fails.
    let snapshot = getLatestStorage()?.value ?? null;
    if (!snapshot) {
      try {
        snapshot = await getStorageResults();
      } catch {
        snapshot = readLatestStorageSnapshot();
      }
    }
    if (!snapshot || snapshot.volumes.length === 0) {
      return Response.json(
        unobserved(
          snapshot?.reason ?? "no local storage observation is available yet",
          base,
        ) satisfies StorageView,
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const volumes: StorageVolumeView[] = snapshot.volumes;
    const totals = volumes.reduce(
      (acc, v) => ({
        volumes: acc.volumes + 1,
        totalBytes: acc.totalBytes + v.totalBytes,
        usedBytes: acc.usedBytes + v.usedBytes,
        freeBytes: acc.freeBytes + v.freeBytes,
      }),
      { volumes: 0, totalBytes: 0, usedBytes: 0, freeBytes: 0 },
    );
    const highest = volumes.reduce<{ volumeId: string; usagePct: number } | null>(
      (best, v) => (best == null || v.usagePct > best.usagePct ? { volumeId: v.id, usagePct: v.usagePct } : best),
      null,
    );

    return Response.json(
      {
        ...base,
        lastCheckedAt: snapshot.collectedAt,
        thresholds: { ...DISK_THRESHOLDS },
        volumes,
        totals: { ...totals, highest },
        reason: null,
      } satisfies StorageView,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "storage_unavailable" }, { status: 503 });
  }
}
