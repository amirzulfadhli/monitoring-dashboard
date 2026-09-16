/**
 * Local security monitoring (Task 22).
 *
 * These tests pin the behavior a regression would actually hurt: that the
 * firewall/Defender parsers never turn an absent report into a disabled one,
 * that listening sockets normalize and deduplicate deterministically, that a
 * first observation is a baseline rather than a flood of "new port" findings,
 * that an unchanged observation records no duplicate transition, that only the
 * four protection rules can alert (never a port), that an unavailable Windows
 * capability is reported instead of fabricated, and that no command output,
 * path or credential can reach the database.
 *
 * There are NO real host queries here: every collection is driven through an
 * injected command runner, and persistence works in a fresh OS temp directory —
 * the real `.devpulse/telemetry.db` and the real machine are never touched.
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
  derivePosture,
  allCapabilitiesUnavailable,
  normalizePorts,
  normalizeAddress,
  exposureOf,
  sanitizeProcessName,
  MAX_PROCESS_NAME_LENGTH,
  type ListeningPort,
  type SecuritySnapshot,
} from "../src/lib/security/model";
import {
  parseFirewall,
  parseDefender,
  parsePorts,
  type CommandRunner,
} from "../src/lib/security/windows";
import { diffPorts, deriveSecurityFindings } from "../src/lib/security/findings";
import { collectSecurity } from "../src/lib/security";
import {
  defenderAvailableBefore,
  persistSecuritySnapshot,
  readLatestSecuritySnapshot,
  readSecurityFindings,
} from "../src/lib/security/storage";
import { evaluateSecurity } from "../src/lib/alerts/rules";
import { RULES } from "../src/lib/alerts/model";
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

/* ------------------------------ fixtures ------------------------------ */

/** A fake PowerShell that answers by script content. Nothing is executed. */
function fakeRunner(out: {
  firewall?: string | null;
  defender?: string | null;
  ports?: string | null;
}): CommandRunner {
  return async (script) => {
    if (script.includes("Get-NetFirewallProfile")) return out.firewall ?? null;
    if (script.includes("Get-MpComputerStatus")) return out.defender ?? null;
    if (script.includes("Get-NetTCPConnection")) return out.ports ?? null;
    return null;
  };
}

const fw = (profiles: { name: string; enabled: boolean }[]) =>
  JSON.stringify(profiles);

const def = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    available: true,
    amServiceEnabled: true,
    antivirusEnabled: true,
    realtimeEnabled: true,
    signatureAgeDays: 2,
    runningMode: "Normal",
    ...over,
  });

const port = (
  address: string,
  p: number | string,
  extra: Record<string, unknown> = {},
) => ({ address, port: p, pid: null, process: null, ...extra });

function snap(over: Partial<SecuritySnapshot> = {}): SecuritySnapshot {
  return {
    collectedAt: NOW,
    platform: "win32",
    firewall: {
      available: true,
      reason: null,
      profiles: [
        { name: "Domain", enabled: true },
        { name: "Private", enabled: true },
        { name: "Public", enabled: true },
      ],
    },
    defender: {
      available: true,
      reason: null,
      amServiceEnabled: true,
      antivirusEnabled: true,
      realtimeEnabled: true,
      signatureAgeDays: 1,
      runningMode: "Normal",
    },
    ports: { available: true, reason: null, entries: [] },
    ...over,
  };
}

/** Run `fn` against a fresh temp database. No real DB is touched. */
function withTempDb(
  t: { after: (fn: () => void) => void },
  fn: (db: DatabaseSync) => Promise<void> | void,
): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-security-"));
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

/* --------------------------- firewall parsing --------------------------- */

test("firewall: enabled/disabled is read per profile", () => {
  const s = parseFirewall(fw([
    { name: "Domain", enabled: true },
    { name: "Private", enabled: false },
    { name: "Public", enabled: true },
  ]));
  assert.equal(s.available, true);
  assert.equal(s.reason, null);
  assert.deepEqual(s.profiles, [
    { name: "Domain", enabled: true },
    { name: "Private", enabled: false },
    { name: "Public", enabled: true },
  ]);
});

test("firewall: profiles are ordered deterministically", () => {
  const s = parseFirewall(fw([
    { name: "Public", enabled: true },
    { name: "Domain", enabled: true },
    { name: "Private", enabled: true },
  ]));
  assert.deepEqual(s.profiles.map((p) => p.name), ["Domain", "Private", "Public"]);
});

test("firewall: a missing or unreadable report is unavailable, never disabled", () => {
  for (const out of [null, "", "not json", "\n"]) {
    const s = parseFirewall(out);
    assert.equal(s.available, false);
    assert.ok(s.reason);
    assert.deepEqual(s.profiles, []);
  }
});

test("firewall: no reported profiles is unavailable rather than 'all off'", () => {
  const s = parseFirewall("[]");
  assert.equal(s.available, false);
  assert.match(s.reason!, /no firewall profiles/);
});

/* --------------------------- Defender parsing --------------------------- */

test("defender: an available report keeps its explicit booleans", () => {
  const s = parseDefender(def({ realtimeEnabled: false }));
  assert.equal(s.available, true);
  assert.equal(s.amServiceEnabled, true);
  assert.equal(s.antivirusEnabled, true);
  assert.equal(s.realtimeEnabled, false);
  assert.equal(s.signatureAgeDays, 2);
});

test("defender: unavailable is reported, not treated as disabled", () => {
  const s = parseDefender('{"available":false}');
  assert.equal(s.available, false);
  assert.match(s.reason!, /not available/);
  assert.equal(s.amServiceEnabled, null);
  assert.equal(s.realtimeEnabled, null);
});

test("defender: an unreadable probe is unavailable", () => {
  for (const out of [null, "", "{}", "Get-MpComputerStatus : not recognized"]) {
    const s = parseDefender(out);
    assert.equal(s.available, false);
    assert.equal(s.amServiceEnabled, null);
    assert.equal(s.signatureAgeDays, null);
  }
});

test("defender: a field the platform did not report stays null, not false", () => {
  const s = parseDefender(def({ amServiceEnabled: null, signatureAgeDays: null }));
  assert.equal(s.available, true);
  assert.equal(s.amServiceEnabled, null);
  assert.equal(s.signatureAgeDays, null);
});

test("defender: an implausible signature age is dropped", () => {
  assert.equal(parseDefender(def({ signatureAgeDays: -3 })).signatureAgeDays, null);
  assert.equal(parseDefender(def({ signatureAgeDays: "x" })).signatureAgeDays, null);
  assert.equal(parseDefender(def({ signatureAgeDays: 0 })).signatureAgeDays, 0);
});

test("defender: the platform's running mode is kept verbatim, junk is dropped", () => {
  assert.equal(parseDefender(def({ runningMode: "Passive Mode" })).runningMode, "Passive Mode");
  assert.equal(parseDefender(def({ runningMode: "Not running" })).runningMode, "Not running");
  assert.equal(parseDefender(def({ runningMode: null })).runningMode, null);
  assert.equal(parseDefender(def({ runningMode: 7 })).runningMode, null);
  assert.equal(
    parseDefender(def({ runningMode: "x".repeat(200) })).runningMode,
    null,
    "an implausibly long mode string is not stored",
  );
});

/* ------------------------- port normalization ------------------------- */

test("ports: address normalization strips case and IPv6 zone index", () => {
  assert.equal(normalizeAddress("  0.0.0.0 "), "0.0.0.0");
  assert.equal(normalizeAddress("FE80::1%12"), "fe80::1");
  assert.equal(normalizeAddress(42), "unknown");
});

test("ports: exposure classifies the binding, not the port number", () => {
  assert.equal(exposureOf("0.0.0.0"), "any");
  assert.equal(exposureOf("::"), "any");
  assert.equal(exposureOf("127.0.0.1"), "loopback");
  assert.equal(exposureOf("::1"), "loopback");
  assert.equal(exposureOf("192.168.1.10"), "specific");
});

test("ports: duplicates collapse, preferring the entry with process metadata", () => {
  const entries = normalizePorts([
    port("0.0.0.0", 8080),
    port("0.0.0.0", 8080, { pid: 4242, process: "node" }),
    port("::", 8080),
    port("127.0.0.1", 3000, { pid: 12, process: "svc" }),
  ]);
  assert.equal(entries.length, 3);
  const any = entries.find((e) => e.address === "0.0.0.0" && e.port === 8080)!;
  assert.equal(any.pid, 4242);
  assert.equal(any.process, "node");
});

test("ports: entries are ordered by port then address", () => {
  const entries = normalizePorts([
    port("::", 9000),
    port("0.0.0.0", 3000),
    port("127.0.0.1", 3000),
  ]);
  assert.deepEqual(entries.map((e) => e.port), [3000, 3000, 9000]);
  assert.deepEqual(entries.map((e) => e.address), ["0.0.0.0", "127.0.0.1", "::"]);
});

test("ports: implausible entries are dropped and non-arrays yield none", () => {
  const entries = normalizePorts([
    port("0.0.0.0", 0),
    port("0.0.0.0", 70000),
    port("0.0.0.0", "abc"),
    null,
    port("0.0.0.0", 445),
  ]);
  assert.deepEqual(entries.map((e) => e.port), [445]);
  assert.deepEqual(normalizePorts("nope"), []);
  assert.deepEqual(normalizePorts({ port: 80 }), []);
});

test("ports: a process path or command line is reduced to a bare name", () => {
  // Only the last path segment, and only up to the first whitespace.
  assert.equal(sanitizeProcessName("C:\\Program Files\\nodejs\\node.exe"), "node.exe");
  assert.equal(
    sanitizeProcessName("node.exe --inspect --token sk-abcdef1234567890"),
    "node.exe",
  );
  assert.equal(sanitizeProcessName("node"), "node");
  assert.equal(sanitizeProcessName("a".repeat(200))!.length, MAX_PROCESS_NAME_LENGTH);
  assert.equal(sanitizeProcessName("   "), null);
});

test("ports: an unreadable probe is unavailable, not zero ports", () => {
  const s = parsePorts(null);
  assert.equal(s.available, false);
  assert.ok(s.reason);
  const ok = parsePorts("[]");
  assert.equal(ok.available, true);
  assert.deepEqual(ok.entries, []);
});

/* ---------------------- new / removed port detection ---------------------- */

const p = (address: string, port_: number): ListeningPort => ({
  address,
  port: port_,
  exposure: exposureOf(address),
  pid: null,
  process: null,
});

test("diffPorts detects opened and closed sockets", () => {
  const prev = [p("0.0.0.0", 3000), p("127.0.0.1", 5432)];
  const cur = [p("0.0.0.0", 3000), p("0.0.0.0", 8080)];
  const { opened, closed } = diffPorts(prev, cur);
  assert.deepEqual(opened.map((e) => e.port), [8080]);
  assert.deepEqual(closed.map((e) => e.port), [5432]);
});

test("findings: the first observation is a baseline for ports", () => {
  const changes = deriveSecurityFindings({
    previous: null,
    current: snap({
      ports: {
        available: true,
        reason: null,
        entries: [p("0.0.0.0", 3000), p("0.0.0.0", 8080)],
      },
    }),
  });
  assert.deepEqual(changes.filter((c) => c.kind === "port_open"), []);
  // Current protection state, however, is reported from the first observation.
  assert.ok(changes.some((c) => c.kind === "firewall_disabled" && !c.active));
});

test("findings: a new port activates and a vanished port resolves", () => {
  const previous = snap({
    ports: { available: true, reason: null, entries: [p("0.0.0.0", 3000)] },
  });
  const current = snap({
    collectedAt: NOW + 300_000,
    ports: { available: true, reason: null, entries: [p("0.0.0.0", 8080)] },
  });
  const changes = deriveSecurityFindings({ previous, current });
  const opened = changes.find((c) => c.fingerprint.endsWith("0.0.0.0|8080"))!;
  const closed = changes.find((c) => c.fingerprint.endsWith("0.0.0.0|3000"))!;
  assert.equal(opened.active, true);
  assert.equal(opened.kind, "port_open");
  assert.equal(opened.severity, "info");
  assert.match(opened.detail, /is now listening/);
  assert.equal(closed.active, false);
  assert.match(closed.detail, /no longer listening/);
});

test("findings: an unchanged observation changes nothing", () => {
  const previous = snap({ ports: { available: true, reason: null, entries: [p("0.0.0.0", 3000)] } });
  const current = snap({
    collectedAt: NOW + 300_000,
    ports: { available: true, reason: null, entries: [p("0.0.0.0", 3000)] },
  });
  const changes = deriveSecurityFindings({ previous, current });
  assert.deepEqual(changes.filter((c) => c.kind === "port_open"), []);
  // Every verdict restates a currently-true condition; nothing flips state.
  const firewall = changes.filter((c) => c.kind === "firewall_disabled");
  assert.equal(firewall.length, 3);
  assert.ok(firewall.every((c) => !c.active));
  assert.ok(changes.filter((c) => c.kind.startsWith("defender")).every((c) => !c.active));
});

test("findings: a disabled firewall profile is a critical finding", () => {
  const changes = deriveSecurityFindings({
    previous: null,
    current: snap({
      firewall: {
        available: true,
        reason: null,
        profiles: [{ name: "Private", enabled: false }],
      },
    }),
  });
  const f = changes.find((c) => c.kind === "firewall_disabled")!;
  assert.equal(f.active, true);
  assert.equal(f.severity, "critical");
  assert.equal(f.fingerprint, "security:firewall_disabled:Private");
  assert.match(f.detail, /Private firewall profile is disabled/);
});

test("findings: an unavailable capability produces no finding at all", () => {
  const changes = deriveSecurityFindings({
    previous: null,
    current: snap({
      firewall: { available: false, reason: "unreadable", profiles: [] },
      defender: {
        available: false,
        reason: "not available",
        amServiceEnabled: null,
        antivirusEnabled: null,
        realtimeEnabled: null,
        signatureAgeDays: null,
        runningMode: null,
      },
    }),
  });
  assert.deepEqual(changes, []);
});

/* ------------------------------- posture ------------------------------- */

test("posture is derived from observed facts only", () => {
  assert.equal(derivePosture(snap()), "protected");
  assert.equal(
    derivePosture(
      snap({
        firewall: {
          available: true,
          reason: null,
          profiles: [{ name: "Public", enabled: false }],
        },
      }),
    ),
    "attention",
  );
  assert.equal(
    derivePosture(snap({ defender: { ...snap().defender, realtimeEnabled: false } })),
    "attention",
  );
  assert.equal(
    derivePosture(
      snap({
        firewall: { available: false, reason: "x", profiles: [] },
        defender: {
          available: false,
          reason: "x",
          amServiceEnabled: null,
          antivirusEnabled: null,
          realtimeEnabled: null,
          signatureAgeDays: null,
          runningMode: null,
        },
      }),
    ),
    "unknown",
  );
  // One unreadable capability is not "unknown": the other was observed.
  assert.equal(
    derivePosture(snap({ defender: { ...snap().defender, available: false, reason: "x" } })),
    "protected",
  );
});

/* ------------------------------ alert rules ------------------------------ */

const secObs = (over: Partial<Parameters<typeof evaluateSecurity>[0]> = {}) => ({
  firewall: {
    available: true,
    profiles: [
      { name: "Domain", enabled: true },
      { name: "Private", enabled: true },
      { name: "Public", enabled: true },
    ],
  },
  defender: {
    available: true,
    amServiceEnabled: true,
    antivirusEnabled: true,
    realtimeEnabled: true,
  },
  defenderPreviouslyAvailable: false,
  ...over,
});

test("alert: a disabled firewall profile is critical and resolves when re-enabled", () => {
  const off = evaluateSecurity(
    secObs({
      firewall: {
        available: true,
        profiles: [
          { name: "Domain", enabled: true },
          { name: "Public", enabled: false },
        ],
      },
    }),
  );
  const pub = off.find((v) => v.fingerprint === "security:firewall_disabled:Public")!;
  assert.equal(pub.active, true);
  assert.equal(pub.severity, "critical");
  assert.equal(pub.ruleId, RULES.FIREWALL_DISABLED);
  assert.equal(
    off.find((v) => v.fingerprint === "security:firewall_disabled:Domain")!.active,
    false,
  );

  const on = evaluateSecurity(secObs());
  assert.ok(
    on.filter((v) => v.ruleId === RULES.FIREWALL_DISABLED).every((v) => !v.active),
  );
});

test("alert: an unreadable firewall yields no firewall verdict", () => {
  const vs = evaluateSecurity(
    secObs({ firewall: { available: false, profiles: [] } }),
  );
  assert.deepEqual(vs.filter((v) => v.ruleId === RULES.FIREWALL_DISABLED), []);
});

test("alert: Defender protection reported off alerts; null does not", () => {
  const disabled = evaluateSecurity(
    secObs({ defender: { ...secObs().defender, amServiceEnabled: false } }),
  ).find((v) => v.ruleId === RULES.DEFENDER_DISABLED)!;
  assert.equal(disabled.active, true);
  assert.equal(disabled.severity, "critical");

  const realtime = evaluateSecurity(
    secObs({ defender: { ...secObs().defender, realtimeEnabled: false } }),
  ).find((v) => v.ruleId === RULES.DEFENDER_REALTIME_DISABLED)!;
  assert.equal(realtime.active, true);
  assert.equal(realtime.severity, "warning");

  // Not reported is not disabled.
  const unknown = evaluateSecurity(
    secObs({
      defender: {
        available: true,
        amServiceEnabled: null,
        antivirusEnabled: null,
        realtimeEnabled: null,
      },
    }),
  );
  assert.ok(unknown.every((v) => !v.active));
});

test("alert: Defender becoming unavailable only counts after it was available", () => {
  const defender = {
    available: false,
    amServiceEnabled: null,
    antivirusEnabled: null,
    realtimeEnabled: null,
  };
  const transition = evaluateSecurity(
    secObs({ defender, defenderPreviouslyAvailable: true }),
  ).find((v) => v.ruleId === RULES.DEFENDER_UNAVAILABLE)!;
  assert.equal(transition.active, true);

  const never = evaluateSecurity(
    secObs({ defender, defenderPreviouslyAvailable: false }),
  ).find((v) => v.ruleId === RULES.DEFENDER_UNAVAILABLE)!;
  assert.equal(never.active, false);
});

test("alert: no rule ever mentions a listening port", () => {
  const vs = evaluateSecurity(
    secObs({
      defender: { ...secObs().defender, realtimeEnabled: false },
      firewall: { available: true, profiles: [{ name: "Public", enabled: false }] },
    }),
  );
  const allowed = new Set<string>([
    RULES.FIREWALL_DISABLED,
    RULES.DEFENDER_DISABLED,
    RULES.DEFENDER_REALTIME_DISABLED,
    RULES.DEFENDER_UNAVAILABLE,
  ]);
  assert.ok(vs.length > 0);
  for (const v of vs) {
    assert.ok(allowed.has(v.ruleId), `unexpected rule ${v.ruleId}`);
    assert.equal(v.source, "security");
    assert.ok(!/port|listening/i.test(v.fingerprint), v.fingerprint);
  }
});

/* --------------------------- collector health --------------------------- */

test("the security collector participates in scheduler health", () => {
  assert.ok((JOB_NAMES as readonly string[]).includes("security"));
  assert.equal(JOB_STALE_AFTER_MS.security, JOB_CADENCE_MS.security * STALE_CADENCE_MULTIPLE);
  // Local security state is sampled far less often than the other collectors.
  assert.ok(JOB_CADENCE_MS.security >= 60_000);

  const store = getStore();
  assert.ok(store.jobs.security, "the store has a slot for the security job");
  assert.equal(store.jobs.security.runs, 0);
  assert.equal(store.security, null);
});

test("collector health maps the security job's states", () => {
  const base = {
    now: NOW,
    startedAt: NOW - 60_000,
    staleAfterMs: JOB_STALE_AFTER_MS.security,
    inactiveReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: NOW - 10_000,
  };
  assert.equal(deriveCollectorState(base), "healthy");
  assert.equal(
    deriveCollectorState({ ...base, inactiveReason: "Windows-only" }),
    "inactive",
  );
  assert.equal(
    deriveCollectorState({ ...base, lastSuccessAt: NOW - JOB_STALE_AFTER_MS.security - 1 }),
    "stale",
  );
  assert.equal(deriveCollectorState({ ...base, consecutiveFailures: 1 }), "failing");
});

/* ------------------------- collection + persistence ------------------------- */

test("collection persists a snapshot and derives findings from it", async (t) => {
  await withTempDb(t, async () => {
    const run = fakeRunner({
      firewall: fw([{ name: "Public", enabled: false }]),
      defender: def({ realtimeEnabled: false }),
      ports: JSON.stringify([port("0.0.0.0", 3000, { pid: 9, process: "node" })]),
    });

    const first = await collectSecurity(run);
    assert.equal(first.platform, process.platform);
    assert.equal(first.ports.entries.length, 1);

    const stored = readLatestSecuritySnapshot()!;
    assert.equal(stored.collectedAt, first.collectedAt);
    assert.deepEqual(stored.ports.entries, first.ports.entries);
    assert.deepEqual(stored.firewall.profiles, [{ name: "Public", enabled: false }]);

    const findings = readSecurityFindings();
    assert.ok(findings.some((f) => f.fingerprint === "security:firewall_disabled:Public" && f.status === "active"));
    assert.ok(findings.some((f) => f.fingerprint === "security:defender_realtime_disabled" && f.status === "active"));
    assert.ok(!findings.some((f) => f.kind === "port_open"), "first run is a baseline");
  });
});

test("an unchanged second collection records no duplicate transition", async (t) => {
  await withTempDb(t, async () => {
    const outputs = {
      firewall: fw([{ name: "Public", enabled: true }]),
      defender: def(),
      ports: JSON.stringify([port("0.0.0.0", 3000, { pid: 9, process: "node" })]),
    };
    await collectSecurity(fakeRunner(outputs));
    const afterFirst = readSecurityFindings();
    const firstSeen = new Map(afterFirst.map((f) => [f.fingerprint, f.firstSeenAt]));

    await collectSecurity(fakeRunner(outputs));
    const afterSecond = readSecurityFindings();

    assert.equal(afterSecond.length, afterFirst.length);
    for (const f of afterSecond) {
      assert.equal(f.firstSeenAt, firstSeen.get(f.fingerprint));
      assert.equal(f.status, "active");
    }
  });
});

test("a port that starts and then stops listening resolves its finding once", async (t) => {
  await withTempDb(t, async () => {
    const base = {
      firewall: fw([{ name: "Public", enabled: true }]),
      defender: def(),
    };
    const listening = (ports: number[]) =>
      fakeRunner({ ...base, ports: JSON.stringify(ports.map((n) => port("0.0.0.0", n))) });

    await collectSecurity(listening([3000])); // baseline
    await collectSecurity(listening([3000, 8080])); // 8080 appears
    await collectSecurity(listening([3000, 8080])); // unchanged
    await collectSecurity(listening([3000])); // 8080 goes away
    await collectSecurity(listening([3000])); // unchanged

    const findings = readSecurityFindings().filter((f) => f.kind === "port_open");
    assert.equal(findings.length, 1, "one condition, not one row per observation");
    assert.equal(findings[0].fingerprint, "security:port_open:0.0.0.0|8080");
    assert.equal(findings[0].status, "resolved");
    assert.match(findings[0].resolution!, /no longer listening/);
  });
});

test("storage: an availability history is queryable for the alert rule", async (t) => {
  await withTempDb(t, async () => {
    persistSecuritySnapshot(snap({ collectedAt: NOW - 1000 }));
    assert.equal(defenderAvailableBefore(NOW, NOW - 10_000), true);
    assert.equal(defenderAvailableBefore(NOW - 5000, NOW - 10_000), false);
    assert.equal(defenderAvailableBefore(NOW, NOW), false);

    persistSecuritySnapshot(
      snap({
        collectedAt: NOW + 1000,
        defender: { ...snap().defender, available: false, reason: "gone" },
      }),
    );
    const latest = readLatestSecuritySnapshot()!;
    assert.equal(latest.defender.available, false);
    assert.equal(latest.collectedAt, NOW + 1000);
  });
});

test("an unreadable snapshot row degrades to unavailable", async (t) => {
  await withTempDb(t, (db) => {
    db.prepare(
      `INSERT INTO security_snapshots (ts, platform, firewall, defender, ports, defenderAvailable, defenderRealtimeEnabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(NOW, "win32", "{not json", "null", "[]", 0, null);
    const s = readLatestSecuritySnapshot()!;
    assert.equal(s.firewall.available, false);
    assert.equal(s.defender.available, false);
    assert.deepEqual(s.firewall.profiles, []);
  });
});

/* ---------------------- unavailable capabilities ---------------------- */

test("a machine where nothing is readable fails as a collector, storing nothing", async (t) => {
  await withTempDb(t, async (db) => {
    await assert.rejects(
      () => collectSecurity(fakeRunner({})),
      /no local security capability/,
    );
    assert.equal(readLatestSecuritySnapshot(), null);
    assert.deepEqual(readSecurityFindings(), []);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM security_snapshots`).get() as { n: number };
    assert.equal(rows.n, 0);
  });
});

test("one unavailable capability does not fail the whole collection", async (t) => {
  await withTempDb(t, async () => {
    const snapshot = await collectSecurity(
      fakeRunner({
        firewall: fw([{ name: "Public", enabled: true }]),
        // Defender and ports both unreadable, as on a machine with a
        // third-party antivirus and no NetTCPIP cmdlets.
        defender: null,
        ports: null,
      }),
    );
    assert.equal(snapshot.firewall.available, true);
    assert.equal(snapshot.defender.available, false);
    assert.ok(snapshot.defender.reason);
    assert.equal(snapshot.defender.realtimeEnabled, null);
    assert.equal(snapshot.ports.available, false);
    assert.deepEqual(snapshot.ports.entries, []);
    assert.equal(allCapabilitiesUnavailable(snapshot), false);

    const stored = readLatestSecuritySnapshot()!;
    assert.equal(stored.defender.available, false);
    // No Defender finding is invented from an absent report.
    assert.ok(!readSecurityFindings().some((f) => f.kind.startsWith("defender")));
  });
});

test("a runner that throws is a failed probe, not a failed collection", async (t) => {
  await withTempDb(t, async () => {
    const run: CommandRunner = async (script) => {
      if (script.includes("Get-MpComputerStatus")) throw new Error("spawn failed");
      if (script.includes("Get-NetFirewallProfile")) return fw([{ name: "Public", enabled: true }]);
      return "[]";
    };
    const snapshot = await collectSecurity(run);
    assert.equal(snapshot.defender.available, false);
    assert.equal(snapshot.firewall.available, true);
  });
});

/* --------------------------- leakage guards --------------------------- */

test("no command output, path or credential reaches storage", async (t) => {
  await withTempDb(t, async (db) => {
    const secret = "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII";
    await collectSecurity(
      fakeRunner({
        firewall: fw([{ name: "Public", enabled: true }]),
        defender: def(),
        ports: JSON.stringify([
          {
            address: "0.0.0.0",
            port: 3000,
            pid: 7,
            // A name field that leaked a path, a command line and a token.
            process: `C:\\Users\\amirk\\node.exe --token ${secret}`,
          },
        ]),
      }),
    );

    const row = db
      .prepare(`SELECT firewall, defender, ports FROM security_snapshots LIMIT 1`)
      .get() as { firewall: string; defender: string; ports: string };
    for (const column of [row.firewall, row.defender, row.ports]) {
      assert.ok(!column.includes(secret), "credential leaked into storage");
      assert.ok(!column.includes("C:\\Users"), "path leaked into storage");
      assert.ok(!column.includes("--token"), "command line leaked into storage");
      assert.ok(!column.includes("Get-NetTCPConnection"), "command output leaked");
    }

    // Only the documented fields are stored for a socket.
    const entries = JSON.parse(row.ports).entries as Record<string, unknown>[];
    assert.deepEqual(
      Object.keys(entries[0]).sort(),
      ["address", "exposure", "pid", "port", "process"],
    );
    const name = entries[0].process as string;
    assert.ok(name.length <= MAX_PROCESS_NAME_LENGTH);
    assert.match(name, /^[A-Za-z0-9._ -]+$/);
    assert.ok(!name.includes(secret));
    assert.ok(!name.includes("\\"));
  });
});

test("the API-facing snapshot carries no raw runner output", async (t) => {
  await withTempDb(t, async () => {
    const snapshot = await collectSecurity(
      fakeRunner({
        firewall: fw([{ name: "Public", enabled: true }]),
        defender: def(),
        ports: "[]",
      }),
    );
    const json = JSON.stringify(snapshot);
    assert.ok(!json.includes("Get-Net"), "command text leaked into the snapshot");
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "collectedAt",
      "defender",
      "firewall",
      "platform",
      "ports",
    ]);
  });
});

/* ------------------------------ history ------------------------------ */

test("security findings reach the unified timeline only on transition", async (t) => {
  await withTempDb(t, async () => {
    const run = fakeRunner({
      firewall: fw([{ name: "Public", enabled: false }]),
      defender: def(),
      ports: JSON.stringify([port("0.0.0.0", 3000)]),
    });
    await collectSecurity(run);
    await collectSecurity(run);

    const events = buildTimeline("24H").filter((e) => e.source === "security");
    const firewall = events.filter((e) => e.type === "security_finding_active" &&
      e.title.includes("Public"));
    assert.equal(firewall.length, 1, "an unchanged observation adds no event");
    assert.equal(firewall[0].severity, "critical");
    assert.match(firewall[0].title, /Windows Firewall · Public profile/);
    assert.deepEqual(firewall[0].metadata?.kind, "firewall_disabled");
    // No event is emitted for the enabled profiles, and ports never alert.
    assert.ok(!events.some((e) => /Listening port/.test(e.title)));
  });
});
