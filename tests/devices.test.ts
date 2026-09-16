/**
 * Device reachability monitoring (Task 23).
 *
 * These tests pin the behavior a regression would actually hurt: that a
 * configured host can never become shell syntax (the argument list is built
 * from a fixed literal plus one validated operand, with no shell involved),
 * that a hostname or IP is normalized consistently and everything else is
 * refused, that reachable / unreachable / timeout each persist the right thing,
 * that a disabled device is never checked, that reachability *transitions* (and
 * only transitions) reach the unified History, that a single dropped ping never
 * opens an alert while a real outage does, that a recovered device resolves its
 * own alert, that collector health stays independent of device health, and that
 * no ping output or unsanitized error can reach the database.
 *
 * There are NO real network calls here: every check is driven through an
 * injected reachability runner, and persistence works in a fresh OS temp
 * directory — the real `.devpulse/telemetry.db` and the real network are never
 * touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate, SCHEMA_VERSION } from "../src/lib/db/schema";
import { closeDb } from "../src/lib/db/index";
import {
  DEVICE_TYPES,
  deviceTypeOf,
  isUnreachableAtThreshold,
  sanitizeReason,
} from "../src/lib/devices/model";
import { hostError, normalizeHost, MAX_HOST_LENGTH } from "../src/lib/devices/host";
import {
  checkAllDevices,
  checkDevice,
  mapWithConcurrency,
  parseLatency,
  pingArgs,
  type ReachabilityRunner,
} from "../src/lib/devices/reachability";
import {
  persistDeviceCheck,
  readDeviceChecks,
  readDeviceSummaries,
  readLatestDeviceChecks,
} from "../src/lib/devices/storage";
import { collectDevices } from "../src/lib/devices";
import { validateDeviceFields } from "../src/lib/settings/validate";
import {
  createDevice,
  getEnabledDevices,
  removeDevice,
  updateDeviceFields,
} from "../src/lib/settings/service";
import { listDevices } from "../src/lib/settings/storage";
import { evaluateDevices } from "../src/lib/alerts/rules";
import { RULES } from "../src/lib/alerts/model";
import { applyVerdict, readAlerts } from "../src/lib/alerts/storage";
import { alertConfig } from "../src/lib/alerts/config";
import { deriveCollectorState } from "../src/lib/scheduler/health";
import {
  JOB_CADENCE_MS,
  JOB_NAMES,
  JOB_STALE_AFTER_MS,
  STALE_CADENCE_MULTIPLE,
} from "../src/lib/scheduler/model";
import { buildTimeline } from "../src/lib/history";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/* ------------------------------ fixtures ------------------------------ */

const device = (over: Partial<{ id: string; name: string; host: string; type: string }> = {}) => ({
  id: over.id ?? "dev-1",
  name: over.name ?? "Build server",
  host: over.host ?? "build-01.local",
  type: deviceTypeOf(over.type ?? "server"),
});

/** A runner that answers with a fixed outcome; nothing is executed. */
const answer =
  (o: { reachable?: boolean; latencyMs?: number | null; errorType?: string | null; error?: string | null }): ReachabilityRunner =>
  async () => ({
    reachable: o.reachable ?? true,
    // An unreachable host reports no latency unless a test says otherwise.
    latencyMs: o.latencyMs !== undefined ? o.latencyMs : o.reachable === false ? null : 5,
    errorType: (o.errorType ?? null) as never,
    error: o.error ?? null,
  });

/** Run `fn` against a fresh temp database. No real DB is touched. */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => Promise<void> | void,
): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-devices-"));
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

/* --------------------------- host normalization --------------------------- */

test("host: hostnames and IP literals normalize to one canonical form", () => {
  assert.equal(normalizeHost("Build-01.Local"), "build-01.local");
  assert.equal(normalizeHost("  build-01.local  "), "build-01.local");
  // A single root dot is the same name.
  assert.equal(normalizeHost("build-01.local."), "build-01.local");
  assert.equal(normalizeHost("10.0.0.12"), "10.0.0.12");
  assert.equal(normalizeHost("192.168.1.1"), "192.168.1.1");
  assert.equal(normalizeHost("::1"), "::1");
  assert.equal(normalizeHost("fe80::1"), "fe80::1");
  assert.equal(normalizeHost("single"), "single");
  assert.equal(normalizeHost("a-b.c-d.example.com"), "a-b.c-d.example.com");
});

test("host: anything that could become shell syntax or a range is refused", () => {
  const refused = [
    "",
    "   ",
    // Shell metacharacters and separators of every kind.
    "host;rm -rf /",
    "host && whoami",
    "host|cat /etc/passwd",
    "host`id`",
    "host$(id)",
    "host name",
    "host\nnext",
    "host>file",
    "host'quote",
    'host"quote',
    "%PATH%",
    "host&background",
    // A leading dash must never be readable as a ping flag.
    "-n",
    "-c 100",
    "--help",
    // No scheme, port, path, credential or query.
    "http://example.com",
    "example.com:8080",
    "example.com/path",
    "user@example.com",
    // No address ranges, CIDR blocks or wildcards: device monitoring is never
    // a subnet scan.
    "10.0.0.0/24",
    "192.168.0.0-192.168.0.255",
    "192.168.*.*",
    "*",
    // Malformed literals are typos, not hostnames.
    "999.1.1.1",
    "010.0.0.1",
  ];
  for (const h of refused) {
    assert.equal(normalizeHost(h), null, `expected ${JSON.stringify(h)} to be refused`);
  }
  assert.equal(normalizeHost(undefined), null);
  assert.equal(normalizeHost(42), null);
  assert.equal(normalizeHost("x".repeat(MAX_HOST_LENGTH + 1)), null);
});

test("host: refusals explain themselves", () => {
  assert.match(hostError("") ?? "", /required/i);
  assert.match(hostError("http://example.com") ?? "", /hostname or IP/i);
  assert.equal(hostError("build-01.local"), null);
});

test("host: an unknown device type degrades to 'other', never a bad value", () => {
  assert.equal(deviceTypeOf("server"), "server");
  assert.equal(deviceTypeOf("iot"), "iot");
  for (const bad of ["mainframe", "", null, 7, {}]) {
    assert.equal(deviceTypeOf(bad), "other");
  }
  assert.deepEqual([...DEVICE_TYPES], ["computer", "server", "iot", "other"]);
});

/* ---------------------------- argument safety ---------------------------- */

test("args: the host is one operand and options are fixed literals", () => {
  const win = pingArgs("build-01.local", 3000, "win32");
  assert.deepEqual(win, ["-n", "1", "-w", "3000", "build-01.local"]);
  // Exactly one echo request — never a count that could be scaled into a sweep.
  assert.equal(win[1], "1");
  assert.equal(win[win.length - 1], "build-01.local");

  const posix = pingArgs("10.0.0.12", 3000, "linux");
  assert.deepEqual(posix, ["-c", "1", "-W", "3", "10.0.0.12"]);
  assert.equal(posix[posix.length - 1], "10.0.0.12");
});

test("args: no argument is ever built from a shell string", () => {
  // Even a value that would be dangerous on a command line arrives as a single
  // argv element; nothing here concatenates, quotes or interpolates.
  const hostile = "host; rm -rf / && echo pwned";
  const args = pingArgs(hostile, 3000, "win32");
  assert.equal(args.length, 5);
  assert.equal(args[4], hostile);
  // The dangerous value never becomes part of an option.
  assert.ok(!args.slice(0, 4).some((a) => a.includes("rm -rf")));
});

/* ------------------------------- latency -------------------------------- */

test("latency: only a number is ever extracted from ping output", () => {
  assert.equal(parseLatency("Reply from 10.0.0.12: bytes=32 time=3ms TTL=128"), 3);
  assert.equal(parseLatency("64 bytes from 10.0.0.12: icmp_seq=1 ttl=64 time=0.045 ms"), 0.045);
  // A "less than" form reports its bound.
  assert.equal(parseLatency("Reply from 10.0.0.12: bytes=32 time<1ms TTL=128"), 1);
  assert.equal(parseLatency("Destination host unreachable."), null);
  assert.equal(parseLatency(""), null);
  // Nothing non-numeric can survive the capture group.
  assert.equal(parseLatency("time=3ms; rm -rf /"), 3);
});

/* --------------------------- check outcomes ---------------------------- */

test("check: a reachable device records latency and no error", async () => {
  const r = await checkDevice(device(), answer({ reachable: true, latencyMs: 4 }));
  assert.equal(r.reachable, true);
  assert.equal(r.latencyMs, 4);
  assert.equal(r.errorType, null);
  assert.equal(r.error, null);
});

test("check: an unreachable device records a fixed reason, never ping output", async () => {
  const r = await checkDevice(
    device(),
    answer({ reachable: false, errorType: "unreachable", error: "No response from host" }),
  );
  assert.equal(r.reachable, false);
  assert.equal(r.latencyMs, null);
  assert.equal(r.errorType, "unreachable");
  assert.equal(r.error, "No response from host");
});

test("check: a timeout is reported as a timeout", async () => {
  const r = await checkDevice(
    device(),
    answer({ reachable: false, errorType: "timeout", error: "Reachability check timed out" }),
  );
  assert.equal(r.reachable, false);
  assert.equal(r.errorType, "timeout");
  assert.match(r.error ?? "", /timed out/i);
});

test("check: a throwing runner is an unreachable result, not a crash", async () => {
  const r = await checkDevice(device(), async () => {
    throw new Error("spawn ENOENT");
  });
  assert.equal(r.reachable, false);
  assert.equal(r.errorType, "spawn_failed");
  assert.match(r.error ?? "", /ENOENT/);
});

test("check: an invalid stored host is never handed to the runner", async () => {
  let called = false;
  const r = await checkDevice(device({ host: "host; rm -rf /" }), async () => {
    called = true;
    return { reachable: true, latencyMs: 1, errorType: null, error: null };
  });
  assert.equal(called, false, "the runner must not run for an invalid host");
  assert.equal(r.reachable, false);
});

test("errors: a runner cannot smuggle unsanitized text into a result", async () => {
  const r = await checkDevice(
    device(),
    answer({ reachable: false, errorType: "spawn_failed", error: "auth token=abcdef1234567890 failed" }),
  );
  assert.equal(r.error?.includes("abcdef1234567890"), false);
  assert.match(r.error ?? "", /redacted/);
});

test("errors: sanitization collapses whitespace and caps length", () => {
  const s = sanitizeReason(new Error("line one\nline two\r\n   line three"));
  assert.equal(s.includes("\n"), false);
  assert.match(s, /line one line two line three/);
  assert.ok(sanitizeReason(new Error("x".repeat(500))).length <= 120);
});

/* ----------------------------- concurrency ------------------------------ */

test("concurrency: never more than the limit is in flight, order is preserved", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return n * 2;
  });
  assert.equal(peak <= 3, true, `peak concurrency was ${peak}`);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
});

/* ------------------------------ persistence ------------------------------ */

test("persistence: a check round-trips through the database", async (t) => {
  await withTempDb(t, () => {
    // Summary windows are measured back from "now", so these rows are recent.
    const t0 = Date.now() - 60_000;
    const d = device({ id: "dev-1" });
    persistDeviceCheck({
      device: d,
      checkedAt: t0,
      reachable: true,
      latencyMs: 7,
      errorType: null,
      error: null,
    });
    persistDeviceCheck({
      device: d,
      checkedAt: t0 + 30_000,
      reachable: false,
      latencyMs: null,
      errorType: "unreachable",
      error: "No response from host",
    });

    const rows = readDeviceChecks(0);
    assert.equal(rows.length, 2);
    // Oldest first.
    assert.deepEqual(rows[0], {
      ts: t0,
      deviceId: "dev-1",
      reachable: true,
      latencyMs: 7,
    });
    assert.equal(rows[1].reachable, false);

    const latest = readLatestDeviceChecks(0);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].ts, t0 + 30_000);
    assert.equal(latest[0].reachable, false);
    assert.equal(latest[0].consecutiveUnreachable, 1);

    const summary = readDeviceSummaries(DAY);
    assert.equal(summary["dev-1"].samples, 2);
    assert.equal(summary["dev-1"].uptimePct, 50);
    assert.equal(summary["dev-1"].avgLatencyMs, 7);
    assert.equal(summary["dev-1"].latestFailureAt, t0 + 30_000);
  });
});

test("persistence: the unreachable streak counts only the newest run", async (t) => {
  await withTempDb(t, () => {
    const d = device();
    const at = (i: number, reachable: boolean) =>
      persistDeviceCheck({
        device: d,
        checkedAt: NOW + i * 1000,
        reachable,
        latencyMs: reachable ? 3 : null,
        errorType: reachable ? null : "unreachable",
        error: reachable ? null : "No response from host",
      });
    // old fail, fail, recover, fail, fail, fail (newest)
    [false, false, true, false, false, false].forEach((r, i) => at(i, r));

    const latest = readLatestDeviceChecks(0);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].consecutiveUnreachable, 3);
  });
});

/* --------------------------- config + disabled --------------------------- */

test("config: a device is stored only after its host normalizes", async (t) => {
  await withTempDb(t, () => {
    const bad = createDevice({ name: "Bad", host: "http://example.com" });
    assert.equal(bad.ok, false);
    assert.equal(listDevices()?.length, 0);

    const good = createDevice({ name: "Build server", host: "Build-01.Local", type: "server" });
    assert.equal(good.ok, true);
    const [stored] = listDevices() ?? [];
    assert.equal(stored.host, "build-01.local");
    assert.equal(stored.type, "server");
    assert.equal(stored.enabled, true);

    // The same host twice would double every check.
    const dup = createDevice({ name: "Duplicate", host: "build-01.local" });
    assert.equal(dup.ok, false);

    // Neither a shell-shaped nor a ranged host can ever be stored.
    assert.equal(createDevice({ name: "Scan", host: "10.0.0.0/24" }).ok, false);
    assert.equal(createDevice({ name: "Scan", host: "host && whoami" }).ok, false);
    assert.equal(listDevices()?.length, 1);
  });
});

test("config: validation rejects an unknown type and an empty name", () => {
  assert.match(validateDeviceFields({ name: "", host: "a.local" }) ?? "", /name is required/i);
  assert.match(
    validateDeviceFields({ name: "X", host: "a.local", type: "mainframe" }) ?? "",
    /type must be one of/i,
  );
  assert.equal(validateDeviceFields({ name: "X", host: "a.local", type: "iot" }), null);
  assert.equal(validateDeviceFields({ name: "X", host: "10.0.0.1" }), null);
});

test("disabled: a disabled device is configured but never checked", async (t) => {
  await withTempDb(t, async () => {
    const a = createDevice({ name: "On", host: "on.local" });
    const b = createDevice({ name: "Off", host: "off.local" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    const off = (listDevices() ?? []).find((d) => d.host === "off.local");
    assert.ok(off);
    assert.equal(updateDeviceFields(off.id, { enabled: false }).ok, true);

    assert.deepEqual(
      getEnabledDevices().map((d) => d.host),
      ["on.local"],
    );

    const checked: string[] = [];
    await collectDevices(async (host) => {
      checked.push(host);
      return { reachable: true, latencyMs: 1, errorType: null, error: null };
    });
    assert.deepEqual(checked, ["on.local"], "a disabled device must never be checked");

    // Disabling does not delete configuration or history.
    assert.equal((listDevices() ?? []).length, 2);
  });
});

test("collection: every enabled device is checked and persisted independently", async (t) => {
  await withTempDb(t, async () => {
    createDevice({ name: "Up", host: "up.local" });
    createDevice({ name: "Down", host: "down.local" });

    const results = await collectDevices(async (host) =>
      host === "up.local"
        ? { reachable: true, latencyMs: 2, errorType: null, error: null }
        : { reachable: false, latencyMs: null, errorType: "unreachable", error: "No response from host" },
    );
    assert.equal(results.length, 2);
    assert.equal(results.filter((r) => r.reachable).length, 1);

    const rows = readDeviceChecks(0);
    assert.equal(rows.length, 2);
    // One failing device never stops the others being recorded.
    assert.equal(rows.filter((r) => r.reachable).length, 1);
  });
});

test("collection: checkAllDevices bounds one run", async (t) => {
  await withTempDb(t, async () => {
    const many = Array.from({ length: 80 }, (_, i) => device({ id: `d${i}`, host: `h${i}.local` }));
    const results = await checkAllDevices(many, answer({ reachable: true }));
    assert.equal(results.length, 50, "a single run is bounded");
    // Only the bounded slice was persisted.
    assert.equal(readDeviceChecks(0).length, 50);
  });
});

/* -------------------------------- history -------------------------------- */

test("history: only reachability transitions reach the timeline", async (t) => {
  await withTempDb(t, async () => {
    createDevice({ name: "Build server", host: "build-01.local" });
    const id = (listDevices() ?? [])[0].id;
    const d = device({ id, host: "build-01.local" });

    // reachable x3 (baseline, no events), then unreachable, then reachable.
    const script: [number, boolean][] = [
      [0, true],
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, true],
    ];
    for (const [i, reachable] of script) {
      persistDeviceCheck({
        device: d,
        checkedAt: Date.now() - (6 - i) * 60_000,
        reachable,
        latencyMs: reachable ? 4 : null,
        errorType: reachable ? null : "unreachable",
        error: reachable ? null : "No response from host",
      });
    }

    const events = buildTimeline("24H").filter((e) => e.source === "device");
    // Exactly the two transitions — never one event per successful poll.
    assert.equal(events.length, 2);
    // Newest first: recovery, then the outage.
    assert.equal(events[0].metadata?.state, "reachable");
    assert.equal(events[0].metadata?.from, "unreachable");
    assert.equal(events[1].metadata?.state, "unreachable");
    assert.equal(events[1].metadata?.from, "reachable");
    assert.equal(events[1].severity, "critical");
    assert.match(events[1].title, /Build server/);
    assert.equal(events[1].metadata?.deviceId, id);
  });
});

test("history: a device that never changed adds nothing", async (t) => {
  await withTempDb(t, async () => {
    const d = device();
    for (let i = 0; i < 5; i++) {
      persistDeviceCheck({
        device: d,
        checkedAt: Date.now() - (5 - i) * 60_000,
        reachable: true,
        latencyMs: 3,
        errorType: null,
        error: null,
      });
    }
    assert.equal(buildTimeline("24H").filter((e) => e.source === "device").length, 0);
  });
});

/* --------------------------------- alerts -------------------------------- */

test("alerts: the threshold decides, not a single failed check", () => {
  const cfg = { consecutiveFailures: 3 };
  const at = (consecutiveUnreachable: number) =>
    evaluateDevices(
      [
        {
          deviceId: "dev-1",
          name: "Build server",
          host: "build-01.local",
          consecutiveUnreachable,
          lastCheckedAt: NOW,
        },
      ],
      cfg,
    )[0];

  assert.equal(at(0).active, false);
  assert.equal(at(1).active, false, "one dropped ping must not alert");
  assert.equal(at(2).active, false, "two must not alert");
  assert.equal(at(3).active, true, "three consecutive failures alert");
  assert.equal(at(9).active, true);

  // A threshold below 1 is clamped, so the rule can never fire on one sample.
  assert.equal(isUnreachableAtThreshold(1, 0), true);
  assert.equal(isUnreachableAtThreshold(0, 0), false);
});

test("alerts: the verdict carries the right identity and no alert spam", () => {
  const v = evaluateDevices(
    [
      {
        deviceId: "dev-1",
        name: "Build server",
        host: "build-01.local",
        consecutiveUnreachable: 4,
        lastCheckedAt: NOW,
      },
    ],
    { consecutiveFailures: 3 },
  )[0];
  assert.equal(v.source, "devices");
  assert.equal(v.ruleId, RULES.DEVICE_UNREACHABLE);
  assert.equal(v.fingerprint, "devices:unreachable:dev-1");
  assert.equal(v.severity, "critical");
  assert.match(v.message, /Build server/);
  assert.match(v.message, /build-01\.local/);
});

test("alerts: one row per device — a sustained outage never duplicates", async (t) => {
  await withTempDb(t, () => {
    const apply = (consecutive: number, at: number) =>
      applyVerdict(
        evaluateDevices(
          [
            {
              deviceId: "dev-1",
              name: "Build server",
              host: "build-01.local",
              consecutiveUnreachable: consecutive,
              lastCheckedAt: at,
            },
          ],
          { consecutiveFailures: 3 },
        )[0],
        at,
      );

    apply(3, NOW);
    apply(4, NOW + 60_000);
    apply(5, NOW + 120_000);
    const active = readAlerts("active");
    assert.equal(active.length, 1);
    // Sustained condition: firstSeenAt is preserved, not reset each evaluation.
    assert.equal(active[0].firstSeenAt, NOW);
    assert.equal(active[0].lastSeenAt, NOW + 120_000);
  });
});

test("alerts: recovery resolves the alert; a later outage reopens the same row", async (t) => {
  await withTempDb(t, () => {
    const apply = (consecutive: number, at: number) =>
      applyVerdict(
        evaluateDevices(
          [
            {
              deviceId: "dev-1",
              name: "Build server",
              host: "build-01.local",
              consecutiveUnreachable: consecutive,
              lastCheckedAt: at,
            },
          ],
          { consecutiveFailures: 3 },
        )[0],
        at,
      );

    apply(3, NOW);
    assert.equal(readAlerts("active").length, 1);

    // The device answers again: the streak drops to 0 and the alert resolves.
    apply(0, NOW + 60_000);
    assert.equal(readAlerts("active").length, 0);
    const resolved = readAlerts("resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].resolvedAt, NOW + 60_000);
    // The stored alert still records the outage that actually happened.
    assert.match(resolved[0].message, /has not responded/i);

    // Recurrence reuses the one row rather than creating a second one.
    apply(3, NOW + 120_000);
    assert.equal(readAlerts("active").length, 1);
    assert.equal(readAlerts("all").length, 1);
  });
});

test("alerts: a recovered device that had a real outage does not re-alert below threshold", async (t) => {
  await withTempDb(t, () => {
    const d = device();
    // A real outage, then a recovery, then one single dropped check.
    [false, false, false, true, false].forEach((reachable, i) =>
      persistDeviceCheck({
        device: d,
        checkedAt: NOW + i * 1000,
        reachable,
        latencyMs: null,
        errorType: reachable ? null : "unreachable",
        error: reachable ? null : "No response from host",
      }),
    );
    const latest = readLatestDeviceChecks(0)[0];
    assert.equal(latest.consecutiveUnreachable, 1);
    assert.equal(
      isUnreachableAtThreshold(latest.consecutiveUnreachable, alertConfig.devices.consecutiveFailures),
      false,
    );
  });
});

/* -------------------- collector health vs device health ------------------- */

test("health: an unreachable device never makes the collector fail", () => {
  const now = NOW;
  // The devices job ran, succeeded, and simply observed an unreachable device.
  const healthy = deriveCollectorState({
    now,
    startedAt: now - 10 * 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.devices,
    inactiveReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: now - 5_000,
  });
  assert.equal(healthy, "healthy");

  // Only the collector's own run throwing makes it failing.
  const failing = deriveCollectorState({
    now,
    startedAt: now - 10 * 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.devices,
    inactiveReason: null,
    consecutiveFailures: 1,
    lastSuccessAt: now - 5_000,
  });
  assert.equal(failing, "failing");

  // No devices configured: inactive, not stale and not failing.
  const inactive = deriveCollectorState({
    now,
    startedAt: now - 10 * 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.devices,
    inactiveReason: "no devices are configured",
    consecutiveFailures: 0,
    lastSuccessAt: null,
  });
  assert.equal(inactive, "inactive");
});

test("health: the devices job is registered with a bounded cadence", () => {
  assert.ok((JOB_NAMES as readonly string[]).includes("devices"));
  assert.equal(JOB_CADENCE_MS.devices, 60_000);
  assert.equal(JOB_STALE_AFTER_MS.devices, JOB_CADENCE_MS.devices * STALE_CADENCE_MULTIPLE);
});

/* ------------------------------ migrations ------------------------------- */

test("schema: migration 4 adds device tables additively and idempotently", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-devices-mig-"));
  const file = path.join(dir, DB_FILE_NAME);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A version-3 database (the state before this milestone).
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = 3`);
  db.exec(`CREATE TABLE monitored_apis (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  db.exec(`CREATE TABLE api_checks (ts INTEGER, targetId TEXT, PRIMARY KEY (ts, targetId))`);
  db.exec(`INSERT INTO monitored_apis (id, name) VALUES ('api-1', 'kept')`);

  migrate(db);
  assert.equal(
    (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
  );

  // Existing rows survive and the new tables exist.
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM monitored_apis`).get() as { n: number }).n, 1);
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(tables.includes("monitored_devices"));
  assert.ok(tables.includes("device_checks"));

  // Re-running is a no-op.
  migrate(db);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM monitored_apis`).get() as { n: number }).n,
    1,
  );
  db.close();
});

test("schema: a device_checks row stores no telemetry and no ping output", async (t) => {
  await withTempDb(t, (db) => {
    persistDeviceCheck({
      device: device(),
      checkedAt: NOW,
      reachable: false,
      latencyMs: null,
      errorType: "unreachable",
      error: "No response from host",
    });
    const cols = (db.prepare(`PRAGMA table_info(device_checks)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    assert.deepEqual(cols.sort(), [
      "deviceId",
      "error",
      "errorType",
      "latencyMs",
      "reachable",
      "ts",
    ]);
    // CPU / memory / network never appear in a device table.
    for (const forbidden of ["cpuPct", "usedMem", "availMem", "rxRate", "txRate"]) {
      assert.equal(cols.includes(forbidden), false);
    }
  });
});

test("config: removing a device keeps its history but stops its alerts", async (t) => {
  await withTempDb(t, () => {
    createDevice({ name: "Build server", host: "build-01.local" });
    const id = (listDevices() ?? [])[0].id;
    persistDeviceCheck({
      device: device({ id }),
      checkedAt: NOW,
      reachable: false,
      latencyMs: null,
      errorType: "unreachable",
      error: "No response from host",
    });

    assert.equal(removeDevice(id).ok, true);
    assert.equal(getEnabledDevices().length, 0);
    // History is intentionally retained.
    assert.equal(readDeviceChecks(0).length, 1);
  });
});

test("config: an invalid host cannot be introduced by an update", async (t) => {
  await withTempDb(t, () => {
    createDevice({ name: "Build server", host: "build-01.local" });
    const id = (listDevices() ?? [])[0].id;

    assert.equal(updateDeviceFields(id, { host: "10.0.0.0/24" }).ok, false);
    assert.equal(updateDeviceFields(id, { host: "host; whoami" }).ok, false);
    assert.equal((listDevices() ?? [])[0].host, "build-01.local");

    // A valid renormalization is accepted.
    assert.equal(updateDeviceFields(id, { host: "Build-01.Local." }).ok, true);
    assert.equal((listDevices() ?? [])[0].host, "build-01.local");

    // The toggle path does not require re-validating untouched fields.
    assert.equal(updateDeviceFields(id, { enabled: false }).ok, true);
    assert.equal((listDevices() ?? [])[0].enabled, false);
  });
});

test("storage: an unavailable database degrades to no-ops, never a throw", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-devices-nodb-"));
  const saved = process.env.DEVPULSE_DB_PATH;
  // A regular file where the database directory would have to be: opening can
  // never succeed, so every storage call must take its degradation path.
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "");
  process.env.DEVPULSE_DB_PATH = path.join(blocker, DB_FILE_NAME);
  t.after(() => {
    closeDb();
    if (saved === undefined) delete process.env.DEVPULSE_DB_PATH;
    else process.env.DEVPULSE_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(
    persistDeviceCheck({
      device: device(),
      checkedAt: NOW,
      reachable: true,
      latencyMs: 1,
      errorType: null,
      error: null,
    }),
    false,
  );
  assert.deepEqual(readDeviceChecks(0), []);
  assert.deepEqual(readLatestDeviceChecks(0), []);
  assert.deepEqual(readDeviceSummaries(HOUR), {});
  assert.deepEqual(listDevices(), null);
  assert.deepEqual(getEnabledDevices(), []);
  // Config writes degrade the same way rather than throwing.
  assert.equal(createDevice({ name: "Build server", host: "build-01.local" }).ok, false);
});
