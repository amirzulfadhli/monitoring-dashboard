/**
 * Windows local security collection.
 *
 * All platform-specific work lives here so the rest of DevPulse only ever sees
 * a normalized SecuritySnapshot. Every probe is a **read-only** PowerShell
 * query with a fully hard-coded script — no shell interpolation, no user input,
 * no elevation request, no remote host, no port probe, no packet capture and no
 * configuration change. Nothing is written, killed or reconfigured.
 *
 * Each capability is collected independently: a machine without the Defender
 * module (a third-party antivirus) or without the NetTCPIP cmdlets reports that
 * capability as `available: false` with a short reason instead of failing the
 * whole run or fabricating a state. Command execution is injectable so tests can
 * drive every outcome without touching the host.
 */

import { spawn } from "node:child_process";

import { withoutCredentials } from "@/lib/secrets";
import {
  normalizePorts,
  type DefenderStatus,
  type FirewallStatus,
  type PortsStatus,
  type SecuritySnapshot,
} from "./model";

/** Runs one hard-coded script and returns its stdout, or null on any failure. */
export type CommandRunner = (script: string) => Promise<string | null>;

const PW = "powershell.exe";
const PW_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];
const TIMEOUT_MS = 8000;

const PREAMBLE = [
  "$ErrorActionPreference='SilentlyContinue'",
  // Adapter/process names are UTF-8 in practice; force the console encoding so
  // a non-ASCII local name cannot corrupt the JSON payload.
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
];

/**
 * Windows Firewall state per profile. `Get-NetFirewallProfile` is a read-only
 * query and reports Domain/Private/Public profiles with their enabled flag.
 */
const FIREWALL_SCRIPT = [
  ...PREAMBLE,
  "$rows=@()",
  "foreach($p in @(Get-NetFirewallProfile)){",
  "  $rows += [pscustomobject]@{ name=[string]$p.Name; enabled=[bool]$p.Enabled }",
  "}",
  "if($rows.Count -eq 0){ '[]' } else { $rows | ConvertTo-Json -Compress -Depth 3 }",
].join("\n");

/**
 * Microsoft Defender status. Reported as unavailable when the cmdlet or the
 * service is absent, and each boolean is emitted as null rather than a
 * coerced false when the platform did not report it.
 */
const DEFENDER_SCRIPT = [
  ...PREAMBLE,
  "$s=$null",
  "try { $s = Get-MpComputerStatus } catch { $s = $null }",
  "if($null -eq $s){ '{\"available\":false}' } else {",
  "  $sig=$null",
  "  if($null -ne $s.AntivirusSignatureAge){ $sig=[int]$s.AntivirusSignatureAge }",
  "  [pscustomobject]@{",
  "    available=$true",
  "    amServiceEnabled=$(if($null -eq $s.AMServiceEnabled){$null}else{[bool]$s.AMServiceEnabled})",
  "    antivirusEnabled=$(if($null -eq $s.AntivirusEnabled){$null}else{[bool]$s.AntivirusEnabled})",
  "    realtimeEnabled=$(if($null -eq $s.RealTimeProtectionEnabled){$null}else{[bool]$s.RealTimeProtectionEnabled})",
  "    signatureAgeDays=$sig",
  "    runningMode=$(if($null -eq $s.AMRunningMode){$null}else{[string]$s.AMRunningMode})",
  "  } | ConvertTo-Json -Compress",
  "}",
].join("\n");

/**
 * TCP sockets in the LISTEN state plus the *name* of the owning process. Only
 * the owning pid is used to resolve a name; no command line, path or module
 * list is read.
 */
const PORTS_SCRIPT = [
  ...PREAMBLE,
  "$conns=@(Get-NetTCPConnection -State Listen)",
  "if($conns.Count -eq 0){ '[]' } else {",
  "  $ids=@($conns | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)",
  "  $names=@{}",
  "  foreach($procId in $ids){",
  "    $p = Get-Process -Id $procId",
  "    if($null -ne $p){ $names[$procId]=[string]$p.ProcessName }",
  "  }",
  "  $rows=@()",
  "  foreach($c in $conns){",
  "    $procId=[int]$c.OwningProcess",
  "    $rows += [pscustomobject]@{ address=[string]$c.LocalAddress; port=[int]$c.LocalPort; pid=$procId; process=[string]$names[$procId] }",
  "  }",
  "  $rows | ConvertTo-Json -Compress -Depth 3",
  "}",
].join("\n");

/** Spawn a PowerShell probe. Resolves null on timeout, error or empty output. */
export function runPowerShell(script: string, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      // The probe script is a constant; credentials are not inherited into it.
      child = spawn(PW, PW_ARGS.concat([script]), {
        windowsHide: true,
        env: withoutCredentials(),
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // Only stdout of a normally-exited process is trusted; stderr is never
      // surfaced (it can echo machine-specific detail we do not need).
      void err;
      resolve(child.exitCode === 0 && out.trim() ? out : null);
    });
  });
}

/**
 * The production runner. Refuses to spawn anything on a non-Windows platform,
 * so the collector degrades to "unavailable" instead of running a foreign
 * command line.
 */
export const defaultRunner: CommandRunner = (script) =>
  process.platform === "win32" ? runPowerShell(script) : Promise.resolve(null);

/* ------------------------------------------------------------------ *
 * Parsing (pure, exported for tests)
 * ------------------------------------------------------------------ */

const FW_UNAVAILABLE = "Windows Firewall state could not be read";
const DEFENDER_UNREADABLE = "Microsoft Defender state could not be read";
const DEFENDER_ABSENT = "Microsoft Defender is not available on this machine";
const PORTS_UNAVAILABLE = "Listening TCP ports could not be read";

function parseJson(out: string | null): unknown {
  if (out == null) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/** Parse the firewall probe. An empty profile list counts as unreadable. */
export function parseFirewall(out: string | null): FirewallStatus {
  const parsed = parseJson(out);
  if (parsed === undefined) {
    return { available: false, reason: FW_UNAVAILABLE, profiles: [] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const profiles = arr
    .filter(
      (p): p is { name: string; enabled: unknown } =>
        !!p && typeof (p as { name?: unknown }).name === "string",
    )
    .map((p) => ({ name: p.name, enabled: p.enabled === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (profiles.length === 0) {
    return { available: false, reason: "no firewall profiles reported", profiles: [] };
  }
  return { available: true, reason: null, profiles };
}

/**
 * Parse the Defender probe. `available: false` from the script (or an
 * unreadable payload) means the capability is absent — never that protection is
 * disabled. Null fields stay null so a missing report cannot be read as "off".
 */
export function parseDefender(out: string | null): DefenderStatus {
  const parsed = parseJson(out) as Record<string, unknown> | undefined;
  const absent: DefenderStatus = {
    available: false,
    reason: out == null ? DEFENDER_UNREADABLE : DEFENDER_ABSENT,
    amServiceEnabled: null,
    antivirusEnabled: null,
    realtimeEnabled: null,
    signatureAgeDays: null,
    runningMode: null,
  };
  if (!parsed || typeof parsed !== "object" || parsed.available !== true) return absent;

  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  // Typed explicitly: `Number(null)` is 0, which would turn an unreported age
  // into a very recent one.
  const rawAge: unknown = parsed.signatureAgeDays;
  const age = typeof rawAge === "number" ? rawAge : Number.NaN;
  return {
    available: true,
    reason: null,
    amServiceEnabled: bool(parsed.amServiceEnabled),
    antivirusEnabled: bool(parsed.antivirusEnabled),
    realtimeEnabled: bool(parsed.realtimeEnabled),
    signatureAgeDays: Number.isInteger(age) && age >= 0 ? age : null,
    // A short display string only; anything unexpected is dropped rather than
    // stored verbatim.
    runningMode:
      typeof parsed.runningMode === "string" &&
      /^[A-Za-z0-9 ._-]{1,40}$/.test(parsed.runningMode.trim())
        ? parsed.runningMode.trim()
        : null,
  };
}

/** Parse the listening-port probe into normalized, deduplicated entries. */
export function parsePorts(out: string | null): PortsStatus {
  const parsed = parseJson(out);
  if (parsed === undefined) {
    return { available: false, reason: PORTS_UNAVAILABLE, entries: [] };
  }
  return { available: true, reason: null, entries: normalizePorts(parsed) };
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

/**
 * Collect one local security snapshot. Never throws: every probe failure is
 * represented as an unavailable capability. The three probes run concurrently
 * and are isolated from each other.
 */
export async function collectWindowsSecurity(
  run: CommandRunner = defaultRunner,
  collectedAt: number = Date.now(),
): Promise<SecuritySnapshot> {
  const [fwOut, defOut, portOut] = await Promise.all([
    safeRun(run, FIREWALL_SCRIPT),
    safeRun(run, DEFENDER_SCRIPT),
    safeRun(run, PORTS_SCRIPT),
  ]);
  return {
    collectedAt,
    platform: process.platform,
    firewall: parseFirewall(fwOut),
    defender: parseDefender(defOut),
    ports: parsePorts(portOut),
  };
}

/** A runner that throws is a failed probe, not a failed collection. */
async function safeRun(run: CommandRunner, script: string): Promise<string | null> {
  try {
    return await run(script);
  } catch {
    return null;
  }
}
