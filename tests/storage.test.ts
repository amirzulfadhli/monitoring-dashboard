/**
 * Local disk / storage monitoring (Task 24).
 *
 * These tests pin the behavior a regression would actually hurt: that byte
 * arithmetic and utilization percentages are exact, that the 80% and 90%
 * boundaries land on the documented side, that a volume with no usable capacity
 * is dropped rather than recorded as "100% full", that duplicates collapse
 * deterministically, that the warning and critical bands can never both be open
 * for one volume, that a nearly-full disk never reads as a broken collector,
 * that an unsupported platform degrades cleanly, and that no file name, path or
 * directory content can reach storage.
 *
 * There are NO real host queries here: every collection is driven through an
 * injected command runner, and persistence works in a fresh OS temp directory —
 * the real `.devpulse/telemetry.db` and the real machine's disks are never
 * touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate } from "../src/lib/db/schema";
import { closeDb } from "../src/lib/db/index";
import {
  DISK_THRESHOLDS,
  diskState,
  normalizeVolumes,
  normalizeVolumeId,
  normalizeFilesystem,
  noVolumesAvailable,
  toBytes,
  usagePct,
  type DiskVolume,
  type StorageSnapshot,
} from "../src/lib/disks/model";
import { parseVolumes, type CommandRunner } from "../src/lib/disks/windows";
import { collectStorage } from "../src/lib/disks";
import {
  persistStorageSnapshot,
  readLatestStorageSnapshot,
  readStorageChecks,
} from "../src/lib/disks/storage";
import { evaluateStorage } from "../src/lib/alerts/rules";
import { RULES } from "../src/lib/alerts/model";
import { applyVerdict, readAlerts } from "../src/lib/alerts/storage";
import { deriveCollectorState } from "../src/lib/scheduler/health";
import {
  JOB_CADENCE_MS,
  JOB_NAMES,
  JOB_STALE_AFTER_MS,
  STALE_CADENCE_MULTIPLE,
} from "../src/lib/scheduler/model";
import { getStore } from "../src/lib/scheduler/store";
import { buildTimeline } from "../src/lib/history";

const NOW = 1_700_000_000_000;
const GB = 1_000_000_000;

/* ------------------------------ fixtures ------------------------------ */

/** A fake PowerShell that answers by script content. Nothing is executed. */
function fakeRunner(out: { volumes?: string | null }): CommandRunner {
  return async (script) => {
    if (script.includes("Win32_LogicalDisk")) return out.volumes ?? null;
    return null;
  };
}

const rawVolume = (
  id: string,
  total: number | null,
  free: number | null,
  filesystem: string | null = "NTFS",
) => ({ id, filesystem, totalBytes: total, freeBytes: free });

const volumesJson = (vols: unknown[]) => JSON.stringify(vols);

function snap(over: Partial<StorageSnapshot> = {}): StorageSnapshot {
  return {
    collectedAt: NOW,
    platform: "win32",
    available: true,
    reason: null,
    volumes: normalizeVolumes([rawVolume("C:", 100 * GB, 50 * GB)]),
    ...over,
  };
}

/** Run `fn` against a fresh temp database. No real DB is touched. */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => Promise<void> | void,
): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-storage-"));
  const file = path.join(dir, DB_FILE_NAME);
  const saved = process.env.DEVPULSE_DB_PATH;
  process.env.DEVPULSE_DB_PATH = file;
  const db = new DatabaseSync(file);
  migrate(db);
  const cleanup = () => {
    db.close();
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  };
  t.after(cleanup);
  return fn(db);
}

const vol = (id: string, pct: number): DiskVolume => ({
  id,
  filesystem: "NTFS",
  totalBytes: 100 * GB,
  usedBytes: (pct / 100) * 100 * GB,
  freeBytes: ((100 - pct) / 100) * 100 * GB,
  usagePct: pct,
  state: diskState(pct),
});

/* --------------------------- byte arithmetic --------------------------- */

test("bytes: only real, non-negative integers are accepted", () => {
  assert.equal(toBytes(500), 500);
  assert.equal(toBytes("500"), 500);
  assert.equal(toBytes(0), 0);
  assert.equal(toBytes("  1024 "), 1024);
  // Not reported, implausible or unsafe: never coerced to a number.
  for (const bad of [null, undefined, "", "abc", "-1", -1, 1.5, "1e9", NaN, Infinity, {}, []]) {
    assert.equal(toBytes(bad), null, `expected null for ${String(bad)}`);
  }
  // A capacity beyond exact integer arithmetic is rejected rather than rounded.
  assert.equal(toBytes(Number.MAX_SAFE_INTEGER + 2), null);
});

test("bytes: utilisation is exact and clamped into 0–100", () => {
  assert.equal(usagePct(100 * GB, 50 * GB), 50);
  assert.equal(usagePct(100 * GB, 0), 100);
  assert.equal(usagePct(100 * GB, 100 * GB), 0);
  // A platform reporting more free than total must not yield a negative usage.
  assert.equal(usagePct(100 * GB, 120 * GB), 0);
  // Zero or invalid capacity has no percentage at all.
  assert.equal(usagePct(0, 0), null);
  assert.equal(usagePct(-5, 1), null);
});

test("bytes: large values keep their arithmetic exact", () => {
  const total = 4 * 1_000_000_000_000; // 4 TB
  assert.equal(usagePct(total, total / 4), 75);
  const v = normalizeVolumes([rawVolume("D:", total, total / 2)])[0];
  assert.equal(v.totalBytes, total);
  assert.equal(v.usedBytes, total / 2);
  assert.equal(v.freeBytes, total / 2);
  assert.equal(v.usagePct, 50);
});

/* -------------------------- threshold boundaries -------------------------- */

test("state: the 80% and 90% boundaries land on the documented side", () => {
  assert.equal(DISK_THRESHOLDS.warningPct, 80);
  assert.equal(DISK_THRESHOLDS.criticalPct, 90);

  assert.equal(diskState(0), "normal");
  assert.equal(diskState(79.9), "normal");
  assert.equal(diskState(80), "warning");
  assert.equal(diskState(89.9), "warning");
  assert.equal(diskState(90), "critical");
  assert.equal(diskState(100), "critical");
});

test("state: a volume's state follows its utilisation percentage", () => {
  const [v] = normalizeVolumes([rawVolume("C:", 100 * GB, 20 * GB)]);
  assert.equal(v.usagePct, 80);
  assert.equal(v.state, "warning");
  const [c] = normalizeVolumes([rawVolume("C:", 100 * GB, 10 * GB)]);
  assert.equal(c.usagePct, 90);
  assert.equal(c.state, "critical");
});

/* ---------------------------- normalization ---------------------------- */

test("volumes: unavailable capacity is dropped, never recorded as zero", () => {
  const volumes = normalizeVolumes([
    rawVolume("C:", null, 10 * GB), // total not reported
    rawVolume("D:", 100 * GB, null), // free not reported
    rawVolume("E:", 0, 0), // unmounted / empty reader
    rawVolume("F:", 100 * GB, 90 * GB), // usable
  ]);
  assert.deepEqual(volumes.map((v) => v.id), ["F:"]);
  assert.equal(volumes[0].usagePct, 10);
});

test("volumes: an unreadable filesystem label is reported as absent", () => {
  const [v] = normalizeVolumes([rawVolume("C:", 100 * GB, 50 * GB, null)]);
  assert.equal(v.filesystem, null);
  assert.deepEqual(normalizeVolumes(null), []);
  assert.deepEqual(normalizeVolumes("not-an-array"), []);
  assert.deepEqual(normalizeVolumes({ id: "C:" }), []);
});

test("volumes: identifiers are canonicalized and unsafe ones rejected", () => {
  assert.equal(normalizeVolumeId("c:"), "C:");
  assert.equal(normalizeVolumeId("C:\\"), "C:");
  assert.equal(normalizeVolumeId(" D: "), "D:");
  // A volume identity is a single token: nothing path-shaped or file-shaped is
  // accepted, which is what keeps a leaked path out of storage.
  assert.equal(normalizeVolumeId("/mnt/data"), null);
  assert.equal(normalizeVolumeId("C:\\Users\\amirk\\secret.txt"), null);
  assert.equal(normalizeVolumeId("\\\\server\\share"), null);
  assert.equal(normalizeVolumeId(""), null);
  assert.equal(normalizeVolumeId("x".repeat(64)), null);
  assert.equal(normalizeFilesystem("NTFS"), "NTFS");
  assert.equal(normalizeFilesystem("exFAT "), "exFAT");
  assert.equal(normalizeFilesystem("C:\\Windows"), null);
  assert.equal(normalizeFilesystem(7), null);
});

test("volumes: duplicates collapse deterministically", () => {
  const volumes = normalizeVolumes([
    rawVolume("C:", 100 * GB, 50 * GB, null),
    // Same volume, reported again with a label and a larger capacity.
    rawVolume("c:", 200 * GB, 100 * GB, "NTFS"),
    rawVolume("D:", 100 * GB, 50 * GB),
    rawVolume("d:", 100 * GB, 50 * GB),
  ]);
  assert.deepEqual(volumes.map((v) => v.id), ["C:", "D:"]);
  assert.equal(volumes.length, 2);
  const c = volumes[0];
  assert.equal(c.filesystem, "NTFS");
  assert.equal(c.totalBytes, 200 * GB);
});

test("volumes: output is ordered by identifier", () => {
  const volumes = normalizeVolumes([
    rawVolume("E:", 100 * GB, 50 * GB),
    rawVolume("C:", 100 * GB, 50 * GB),
    rawVolume("D:", 100 * GB, 50 * GB),
  ]);
  assert.deepEqual(volumes.map((v) => v.id), ["C:", "D:", "E:"]);
});

test("volumes: a single reported volume parses out of an object payload", () => {
  const parsed = parseVolumes(volumesJson([rawVolume("C:", 100 * GB, 40 * GB)]));
  assert.equal(parsed.available, true);
  assert.equal(parsed.volumes.length, 1);
  // PowerShell serializes a one-element array as a bare object.
  const single = parseVolumes(JSON.stringify(rawVolume("C:", 100 * GB, 40 * GB)));
  assert.equal(single.volumes.length, 1);
  assert.equal(single.volumes[0].usagePct, 60);
});

test("volumes: an unreadable probe is unavailable, not zero capacity", () => {
  for (const out of [null, "", "not json", "\n"]) {
    const s = parseVolumes(out);
    assert.equal(s.available, false);
    assert.ok(s.reason);
    assert.deepEqual(s.volumes, []);
  }
  // An empty volume list is a readable-but-empty observation.
  const empty = parseVolumes("[]");
  assert.equal(empty.available, true);
  assert.equal(noVolumesAvailable({ available: true, volumes: [] }), true);
});

/* ------------------------------ alert rules ------------------------------ */

const storageCfg = { warningPct: 80, criticalPct: 90 };
const obs = (v: DiskVolume) => ({
  volumeId: v.id,
  usagePct: v.usagePct,
  totalBytes: v.totalBytes,
  freeBytes: v.freeBytes,
});

const verdict = (pct: number, ruleId: string) =>
  evaluateStorage([obs(vol("C:", pct))], storageCfg).find((v) => v.ruleId === ruleId)!;

test("alert: below the warning threshold nothing is active", () => {
  const vs = evaluateStorage([obs(vol("C:", 50))], storageCfg);
  assert.equal(vs.length, 2, "one warning band and one critical band per volume");
  assert.ok(vs.every((v) => !v.active));
  assert.ok(vs.every((v) => v.source === "storage"));
});

test("alert: exactly 80% opens the warning band only", () => {
  const warning = verdict(80, RULES.DISK_USAGE_WARNING);
  assert.equal(warning.active, true);
  assert.equal(warning.severity, "warning");
  assert.equal(warning.fingerprint, "storage:disk_usage_warning:C:");
  assert.match(warning.message, /80%/);

  const critical = verdict(80, RULES.DISK_USAGE_CRITICAL);
  assert.equal(critical.active, false, "one volume never holds both bands at once");
});

test("alert: exactly 90% opens the critical band and closes the warning band", () => {
  const critical = verdict(90, RULES.DISK_USAGE_CRITICAL);
  assert.equal(critical.active, true);
  assert.equal(critical.severity, "critical");
  assert.equal(critical.fingerprint, "storage:disk_usage_critical:C:");
  assert.equal(verdict(90, RULES.DISK_USAGE_WARNING).active, false);
});

test("alert: the two bands are never active for the same volume at the same time", () => {
  for (const pct of [0, 50, 79.9, 80, 85, 89.9, 90, 100]) {
    const vs = evaluateStorage([obs(vol("C:", pct))], storageCfg);
    const active = vs.filter((v) => v.active);
    assert.ok(active.length <= 1, `both bands active at ${pct}%`);
  }
});

test("alert: a recovery is expressed as an inactive verdict", () => {
  const back = evaluateStorage([obs(vol("C:", 40))], storageCfg);
  const w = back.find((v) => v.ruleId === RULES.DISK_USAGE_WARNING)!;
  assert.equal(w.active, false);
  assert.match(w.message, /back under/);
});

test("alert: metadata carries the volume, usage and free space only", () => {
  const w = verdict(85, RULES.DISK_USAGE_WARNING);
  assert.deepEqual(Object.keys(w.metadata ?? {}).sort(), [
    "freeBytes",
    "usagePct",
    "volume",
  ]);
  assert.equal(w.metadata?.volume, "C:");
  assert.equal(w.metadata?.usagePct, 85);
});

test("alert: no verdict is produced for a volume that was never observed", () => {
  assert.deepEqual(evaluateStorage([], storageCfg), []);
});

/* ------------------------ alert lifecycle (persisted) ------------------------ */

test("alert: warning → critical → warning → recovery follows the shared lifecycle", async (t) => {
  await withTempDb(t, (db) => {
    const apply = (v: DiskVolume, at: number) => {
      for (const verdict of evaluateStorage([obs(v)], storageCfg)) applyVerdict(verdict, at);
    };
    const statusOf = (fingerprint: string) =>
      readAlerts("all").find((a) => a.fingerprint === fingerprint);

    apply(vol("C:", 50), NOW);
    assert.deepEqual(readAlerts("active"), []);

    apply(vol("C:", 85), NOW + 1000); // warning
    assert.equal(statusOf("storage:disk_usage_warning:C:")?.status, "active");
    assert.equal(statusOf("storage:disk_usage_critical:C:"), undefined);

    apply(vol("C:", 95), NOW + 2000); // escalates
    assert.equal(statusOf("storage:disk_usage_warning:C:")?.status, "resolved");
    assert.equal(statusOf("storage:disk_usage_critical:C:")?.status, "active");
    assert.equal(
      readAlerts("active").filter((a) => a.ruleId.startsWith("disk_usage")).length,
      1,
      "a volume never has a warning and a critical alert open at once",
    );

    apply(vol("C:", 85), NOW + 3000); // back to warning
    assert.equal(statusOf("storage:disk_usage_critical:C:")?.status, "resolved");
    assert.equal(statusOf("storage:disk_usage_warning:C:")?.status, "active");

    apply(vol("C:", 40), NOW + 4000); // recovered
    assert.deepEqual(readAlerts("active"), []);
    assert.equal(statusOf("storage:disk_usage_warning:C:")?.status, "resolved");

    // One row per condition, not one per evaluation.
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE ruleId LIKE 'disk_usage%'`)
      .get() as { n: number };
    assert.equal(rows.n, 2);
  });
});

/* --------------------------- collector health --------------------------- */

test("the storage collector participates in scheduler health", () => {
  assert.ok((JOB_NAMES as readonly string[]).includes("storage"));
  assert.equal(JOB_STALE_AFTER_MS.storage, JOB_CADENCE_MS.storage * STALE_CADENCE_MULTIPLE);
  // Disk capacity changes slowly, so storage is not polled aggressively.
  assert.ok(JOB_CADENCE_MS.storage >= 300_000);

  const store = getStore();
  assert.ok(store.jobs.storage, "the store has a slot for the storage job");
  assert.equal(store.jobs.storage.runs, 0);
  assert.equal(store.storage, null);
});

test("collector health maps the storage job's states", () => {
  const base = {
    now: NOW,
    startedAt: NOW - 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.storage,
    inactiveReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: NOW - 10_000,
  };
  assert.equal(deriveCollectorState(base), "healthy");
  // An unsupported platform is inactive, not failing — and not stale either.
  assert.equal(
    deriveCollectorState({ ...base, inactiveReason: "Windows-only" }),
    "inactive",
  );
  assert.equal(
    deriveCollectorState({
      ...base,
      inactiveReason: "Windows-only",
      consecutiveFailures: 3,
      lastSuccessAt: null,
    }),
    "inactive",
  );
  assert.equal(
    deriveCollectorState({ ...base, lastSuccessAt: NOW - JOB_STALE_AFTER_MS.storage - 1 }),
    "stale",
  );
  assert.equal(deriveCollectorState({ ...base, consecutiveFailures: 1 }), "failing");
});

test("a nearly-full volume is a disk condition, not a collector failure", () => {
  // The run succeeded at observing the disk, so health is healthy regardless of
  // what the reading says: the volume's own state carries the condition.
  const healthy = deriveCollectorState({
    now: NOW,
    startedAt: NOW - 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.storage,
    inactiveReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: NOW - 5_000,
  });
  const [critical] = normalizeVolumes([rawVolume("C:", 100 * GB, 1 * GB)]);
  assert.equal(critical.state, "critical");
  assert.equal(healthy, "healthy");
});

/* ------------------------- collection + persistence ------------------------- */

test("collection persists one row per volume and derives states", async (t) => {
  await withTempDb(t, async () => {
    const run = fakeRunner({
      volumes: volumesJson([
        rawVolume("C:", 100 * GB, 15 * GB), // 85% -> warning
        rawVolume("D:", 200 * GB, 20 * GB), // 90% -> critical
      ]),
    });
    const snapshot = await collectStorage(run);
    assert.equal(snapshot.volumes.length, 2);
    assert.deepEqual(snapshot.volumes.map((v) => v.state), ["warning", "critical"]);

    const stored = readLatestStorageSnapshot()!;
    assert.equal(stored.collectedAt, snapshot.collectedAt);
    assert.deepEqual(stored.volumes, snapshot.volumes);

    const checks = readStorageChecks(0);
    assert.equal(checks.length, 2);
    assert.ok(checks.every((c) => c.platform === process.platform));
  });
});

test("storage: only the newest observation is served as current", async (t) => {
  await withTempDb(t, () => {
    persistStorageSnapshot(
      snap({ collectedAt: NOW, volumes: normalizeVolumes([rawVolume("C:", 100 * GB, 80 * GB)]) }),
    );
    persistStorageSnapshot(
      snap({
        collectedAt: NOW + 300_000,
        volumes: normalizeVolumes([
          rawVolume("C:", 100 * GB, 10 * GB),
          rawVolume("D:", 100 * GB, 40 * GB),
        ]),
      }),
    );

    const latest = readLatestStorageSnapshot()!;
    assert.equal(latest.collectedAt, NOW + 300_000);
    assert.deepEqual(latest.volumes.map((v) => v.id), ["C:", "D:"]);
    // The window read still sees every observation, oldest first.
    assert.equal(readStorageChecks(0).length, 3);
    assert.deepEqual(
      readStorageChecks(NOW + 1).map((c) => c.id),
      ["C:", "D:"],
    );
  });
});

test("storage: an unreadable machine stores nothing and fails the collector", async (t) => {
  await withTempDb(t, async (db) => {
    await assert.rejects(() => collectStorage(fakeRunner({ volumes: null })), /no local storage volume/);
    await assert.rejects(() => collectStorage(fakeRunner({ volumes: "[]" })), /no local storage volume/);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM storage_volume_checks`).get() as { n: number };
    assert.equal(rows.n, 0);
    assert.equal(readLatestStorageSnapshot(), null);
  });
});

test("a runner that throws is a failed probe, not a failed collection", async (t) => {
  await withTempDb(t, async () => {
    const run: CommandRunner = async () => {
      throw new Error("spawn failed");
    };
    await assert.rejects(() => collectStorage(run), /no local storage volume/);
  });
});

/* ------------------------------ history ------------------------------ */

test("only threshold transitions reach the unified timeline", async (t) => {
  await withTempDb(t, () => {
    // Observations must fall inside the trailing 24H window the timeline reads.
    const base = Date.now();
    // Capacity is 100GB, so a free space of (100 - pct) GB is exactly pct% used.
    const at = (secondsAgo: number, pct: number) =>
      persistStorageSnapshot(
        snap({
          collectedAt: base - secondsAgo * 1000,
          volumes: normalizeVolumes([rawVolume("C:", 100 * GB, (100 - pct) * GB)]),
        }),
      );

    at(60, 50); // baseline: normal
    at(50, 60); // unchanged band — no event
    at(40, 82); // normal → warning
    at(30, 84); // unchanged band — no event
    at(20, 93); // warning → critical
    at(10, 85); // critical → warning
    at(1, 40); // warning → normal

    const events = buildTimeline("24H").filter((e) => e.source === "storage");
    assert.deepEqual(
      events.map((e) => e.metadata?.from).reverse(),
      ["normal", "warning", "critical", "warning"],
    );
    assert.deepEqual(
      events.map((e) => e.metadata?.state).reverse(),
      ["warning", "critical", "warning", "normal"],
    );
    assert.ok(events.every((e) => e.type === "storage_state"));
    assert.equal(
      events.find((e) => e.metadata?.state === "warning")?.title,
      "C: → warning",
    );
    assert.equal(events.find((e) => e.metadata?.state === "critical")?.severity, "critical");
    assert.equal(events.find((e) => e.metadata?.state === "warning")?.severity, "warning");
    // A volume that never changed band contributes nothing at all.
    assert.ok(events.every((e) => e.metadata?.volumeId === "C:"));
  });
});

/* --------------------------- leakage guards --------------------------- */

test("no file name, path or command output reaches storage or the timeline", async (t) => {
  await withTempDb(t, async (db) => {
    await collectStorage(
      fakeRunner({
        volumes: volumesJson([
          // A payload that leaks a file name, a user path and a token in every
          // field a sloppy parser might have kept.
          { id: "C:", filesystem: "C:\\Users\\amirk\\secret.txt", totalBytes: 100 * GB, freeBytes: 50 * GB },
          { id: "C:\\Users\\amirk\\secret.txt", filesystem: "NTFS", totalBytes: 100 * GB, freeBytes: 50 * GB },
          { id: "\\\\server\\share", filesystem: "ghp_AAAABBBBCCCCDDDDEEEEFFFF", totalBytes: 1, freeBytes: 0 },
        ]),
      }),
    );

    const rows = db
      .prepare(`SELECT volumeId, filesystem, platform FROM storage_volume_checks`)
      .all() as { volumeId: string; filesystem: string | null; platform: string }[];
    assert.equal(rows.length, 1, "only the usable local volume is stored");
    const json = JSON.stringify(rows);
    assert.ok(!json.includes("secret"), "a file name leaked into storage");
    assert.ok(!json.includes("Users"), "a user path leaked into storage");
    assert.ok(!json.includes("ghp_"), "a credential leaked into storage");
    assert.ok(!json.includes("Win32_LogicalDisk"), "command text leaked into storage");
    assert.ok(!json.includes("server"), "a UNC path leaked into storage");

    const stored = readLatestStorageSnapshot()!;
    assert.deepEqual(Object.keys(stored.volumes[0]).sort(), [
      "filesystem",
      "freeBytes",
      "id",
      "state",
      "totalBytes",
      "usagePct",
      "usedBytes",
    ]);
    assert.deepEqual(Object.keys(stored).sort(), [
      "available",
      "collectedAt",
      "platform",
      "reason",
      "volumes",
    ]);
  });
});
