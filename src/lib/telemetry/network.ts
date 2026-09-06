import { spawn } from "node:child_process";

export type InterfaceSample = { name: string; rx: number; tx: number };

// Node's os.networkInterfaces() exposes addresses but no byte counters. On
// Windows, cumulative bytes per adapter come from the NetAdapterStatistics
// cmdlet. Command and args are fully hard-coded — no shell interpolation.
const PW = "powershell.exe";
const PW_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

// Filter out known virtual / software adapters so "machine" totals reflect
// real physical links (Wi-Fi / Ethernet), not WSL, VM or tunnel counters.
const VIRTUAL = new RegExp(
  "Loopback|isatap|vEthernet|Virtual|VMware|Hyper-V|Teredo|Bluetooth|docker|Tailscale|Wireless LAN|Local Area",
  "i",
);

// Reads cumulative received/sent bytes for every adapter. Resolves null when
// the OS command fails (unsupported platform, missing cmdlet, etc.).
export async function sampleInterfaces(): Promise<InterfaceSample[] | null> {
  if (process.platform !== "win32") return null;

  // Powershell coerces null counters to 0 and skips adapters that error,
  // then emits one compact JSON array per adapter on stdout.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$o=@(Get-NetAdapterStatistics)",
    "$rows=@()",
    "foreach($a in $o){ try {",
    "  $rx=[long]$a.ReceivedBytes; $tx=[long]$a.SentBytes",
    "  $rows += [pscustomobject]@{ name=[string]$a.Name; rx=$rx; tx=$tx }",
    "} catch {} }",
    "$rows | ConvertTo-Json -Compress -Depth 2",
  ].join("\n");

  const out = await runPw(PW_ARGS.concat([script]));
  if (out == null) return null;

  try {
    const parsed = JSON.parse(out);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((r) => r && typeof r.name === "string")
      .map((r) => ({ name: r.name, rx: Number(r.rx) || 0, tx: Number(r.tx) || 0 }));
  } catch {
    return null;
  }
}

/** Cumulative rx/tx summed across physical (non-virtual) adapters. */
export function physicalTotals(samples: InterfaceSample[] | null) {
  const list = samples ?? [];
  let rx = 0;
  let tx = 0;
  for (const s of list) {
    if (VIRTUAL.test(s.name)) continue;
    rx += s.rx;
    tx += s.tx;
  }
  return { rx, tx };
}

function runPw(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(PW, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 6000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // Only trust stdout when the process exited normally.
      resolve(child.exitCode === 0 && out ? out : null);
    });
    void err;
  });
}
