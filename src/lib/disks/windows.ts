/**
 * Windows local storage collection.
 *
 * All platform-specific work lives here so the rest of DevPulse only ever sees a
 * normalized StorageSnapshot. The probe is a **read-only** PowerShell query with
 * a fully hard-coded script — no shell interpolation, no user input, no
 * elevation request, no remote host and no modification of any disk.
 *
 * What it does *not* do: it never enumerates files or folders, never opens a file
 * name, never measures a directory, and never runs a SMART read or self-test.
 * `Win32_LogicalDisk` reports the capacity and free space a volume already
 * publishes; that is the entire observation.
 *
 * Command execution is injectable so tests can drive every outcome without
 * touching the host.
 */

import {
  runPowerShell,
  type CommandRunner,
} from "@/lib/security/windows";

import {
  normalizeVolumes,
  type DiskVolume,
  type StorageSnapshot,
} from "./model";

export type { CommandRunner };

const TIMEOUT_MS = 8000;

/** Read-only preamble, same shape as the other local probes. */
const PREAMBLE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
];

/**
 * Fixed local volumes only (`DriveType=3`), which excludes removable media, CD
 * drives, RAM disks and network shares — none of which are this machine's
 * storage. `Win32_LogicalDisk` is a read-only CIM query available to a standard
 * user, so no elevation is required or requested. `Size`/`FreeSpace` are emitted
 * as null when the platform did not report them, never coerced to 0.
 */
const VOLUMES_SCRIPT = [
  ...PREAMBLE,
  "$rows=@()",
  "foreach($v in @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DriveType=3\")){",
  "  $rows += [pscustomobject]@{",
  "    id=[string]$v.DeviceID",
  "    filesystem=$(if($v.FileSystem){[string]$v.FileSystem}else{$null})",
  "    totalBytes=$(if($null -eq $v.Size){$null}else{[long]$v.Size})",
  "    freeBytes=$(if($null -eq $v.FreeSpace){$null}else{[long]$v.FreeSpace})",
  "  }",
  "}",
  "if($rows.Count -eq 0){ '[]' } else { $rows | ConvertTo-Json -Compress -Depth 3 }",
].join("\n");

/**
 * The production runner. Delegates to the shared PowerShell runner (the same
 * hard-coded-script, no-elevation execution path the local security probes use)
 * and refuses to spawn anything on a non-Windows platform, so the collector
 * degrades to "unavailable" instead of running a foreign command line.
 */
export const defaultRunner: CommandRunner = (script) =>
  process.platform === "win32" ? runPowerShell(script, TIMEOUT_MS) : Promise.resolve(null);

/* ------------------------------------------------------------------ *
 * Parsing (pure, exported for tests)
 * ------------------------------------------------------------------ */

const VOLUMES_UNREADABLE = "Local storage volumes could not be read";

/** Parse one normalized volume list from raw command output. */
export function parseVolumes(out: string | null): {
  available: boolean;
  reason: string | null;
  volumes: DiskVolume[];
} {
  if (out == null) {
    return { available: false, reason: VOLUMES_UNREADABLE, volumes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { available: false, reason: VOLUMES_UNREADABLE, volumes: [] };
  }
  // A single volume is serialized as an object rather than a one-element array.
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return { available: true, reason: null, volumes: normalizeVolumes(arr) };
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

/**
 * Collect one local storage snapshot. Never throws: an unreadable probe is
 * reported as `available: false` rather than as an empty machine.
 */
export async function collectWindowsStorage(
  run: CommandRunner = defaultRunner,
  collectedAt: number = Date.now(),
): Promise<StorageSnapshot> {
  const out = await safeRun(run, VOLUMES_SCRIPT);
  const parsed = parseVolumes(out);
  return {
    collectedAt,
    platform: process.platform,
    available: parsed.available,
    reason: parsed.reason,
    volumes: parsed.volumes,
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
