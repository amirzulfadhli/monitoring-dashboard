/**
 * Windows production runtime guarantees (Task 32).
 *
 * The runtime is deliberately implemented as two PowerShell scripts, so the
 * checks here are of two kinds:
 *
 *   1. Source invariants - read the scripts and assert the properties that make
 *      them safe (deterministic working directory, production server only, no
 *      secret anywhere near a command line, explicit install only).
 *   2. Dry-run construction - ask the auto-start script what it *would*
 *      register. Nothing is registered, no process is started, and no task is
 *      touched: `-DryRun` returns before any Task Scheduler call.
 *
 * The scripts only exist on Windows; every test skips elsewhere. Nothing here
 * reads a real credential, contacts the network, or starts a server.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const LAUNCHER = path.join(ROOT, "scripts", "devpulse-runtime.ps1");
const AUTOSTART = path.join(ROOT, "scripts", "devpulse-autostart.ps1");
const isWindows = process.platform === "win32";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * Runs the auto-start script in dry-run mode; never registers anything.
 * `expectedExit` is omitted for `Status`, which reports "not installed" as a
 * non-zero exit so scripts can branch on it - only 0 and 1 are legitimate.
 */
function dryRun(action: "Install" | "Status" | "Remove", expectedExit?: 0 | 1): string {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      AUTOSTART,
      "-Action",
      action,
      "-DryRun",
    ],
    { encoding: "utf8", timeout: 60_000, cwd: ROOT },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const status = result.status;
  if (expectedExit === undefined) {
    assert.ok(status === 0 || status === 1, `dry run exited ${status}:\n${output}`);
  } else {
    assert.equal(status, expectedExit, `dry run exited ${status}:\n${output}`);
  }
  return output;
}

/* ------------------------------ launcher ------------------------------ */

test("launcher resolves the project root from its own location", () => {
  const src = read(LAUNCHER);

  // The caller's working directory is irrelevant: the root comes from where the
  // script lives, so an auto-start task starting in system32 still finds it.
  assert.match(src, /Split-Path -Parent \$PSScriptRoot/);
  assert.doesNotMatch(src, /[A-Za-z]:\\Users\\/i);
});

test("launcher establishes the working directory before resolving the database", () => {
  const src = read(LAUNCHER);
  const run = src.slice(src.indexOf("function Invoke-Run"));

  // A relative DEVPULSE_DB_PATH/DEVPULSE_DB_DIR (and the default) resolve
  // against the process working directory, so this ordering is what stops an
  // auto-start task from creating a second database location.
  assert.ok(
    run.indexOf("Set-Location $ProjectRoot") < run.indexOf("Invoke-Preflight"),
    "Invoke-Run must set the working directory before resolving runtime paths",
  );
  assert.match(src, /function Resolve-DbPath/);
  assert.match(src, /DEVPULSE_DB_PATH/);
  assert.match(src, /DEVPULSE_DB_DIR/);
});

test("launcher runs the production server, never the development one", () => {
  const src = read(LAUNCHER);

  assert.match(src, /@\('run', 'start', '--', '-H', \$BindAddress, '-p', "\$Port"\)/);
  // No development-mode argument exists anywhere in the launcher.
  assert.doesNotMatch(src, /'dev'/);
  assert.doesNotMatch(src, /ArgumentList[^\n]*dev/i);
});

test("launcher starts no scheduler of its own", () => {
  // Monitoring keeps starting inside the Next.js process
  // (src/instrumentation.ts). The launcher only *reads* the existing status
  // endpoint, so it must never grow a second collection path.
  const src = read(LAUNCHER);
  assert.match(src, /\/api\/system\/status/);
  assert.doesNotMatch(src, /instrumentation/);
  assert.doesNotMatch(src, /node_modules[^\n]*scheduler/);
});

test("launcher refuses duplicate instances and recovers from a stale lock", () => {
  const src = read(LAUNCHER);

  assert.match(src, /runtime\.lock/);
  assert.match(src, /function Test-LockStale/);
  // Liveness is decided by the recorded pid, not by the port being occupied.
  assert.match(src, /Get-Process -Id \$lockPid -ErrorAction SilentlyContinue/);
  // A dead pid, an unparsable pid, or a recycled pid owned by another program
  // all count as stale, and Run clears the stale lock instead of refusing.
  assert.match(src, /clearing stale lock from pid/);
  // Stopping is scoped to the recorded pid and its children only.
  assert.match(src, /taskkill\.exe \/PID \$lockPid \/T \/F/);
  assert.doesNotMatch(src, /taskkill[^\n]*\/IM/i);
});

test("launcher keeps its log bounded", () => {
  const src = read(LAUNCHER);
  assert.match(src, /\$MaxLogBytes = 5MB/);
  assert.match(src, /function Invoke-LogRotation/);
});

/* ------------------------------ secrets ------------------------------- */

test("no runtime script references a credential", () => {
  for (const file of [LAUNCHER, AUTOSTART]) {
    const src = read(file);
    assert.doesNotMatch(src, /GITHUB_TOKEN/);
    assert.doesNotMatch(src, /DEEPSEEK_API_KEY/i);
    assert.doesNotMatch(src, /ghp_|github_pat_/);
  }
});

test("no script relays the whole environment to a child or a log", () => {
  for (const file of [LAUNCHER, AUTOSTART]) {
    const src = read(file);
    // The launcher reads exactly the two DEVPULSE_* variables it resolves, by
    // name, and never prints an environment value.
    assert.doesNotMatch(src, /Get-ChildItem env:|Get-ChildItem Env:/);
    assert.doesNotMatch(src, /Write-(Host|Output|RuntimeLog)[^\n]*\$env:/i);
    assert.doesNotMatch(src, /RedirectStandard\w+[^\n]*env/i);
  }
});

test(".env.example is the only documented template and holds no values", () => {
  const template = path.join(ROOT, ".env.example");
  assert.ok(existsSync(template), ".env.example should be committed");

  const src = read(template);
  for (const name of [
    "GITHUB_TOKEN",
    "DEEPSEEK_API_KEY",
    "DEVPULSE_PORT",
    "DEVPULSE_HOST",
    "DEVPULSE_DB_PATH",
    "DEVPULSE_DB_DIR",
  ]) {
    assert.match(src, new RegExp(`^#? ?${name}=`, "m"), `${name} should be documented`);
  }
  // Every assignment is empty or a harmless default; no real credential shape.
  assert.doesNotMatch(src, /=\s*\S*ghp_/);
  assert.doesNotMatch(src, /=\s*\S{20,}/);
});

/* ------------------------------ autostart ----------------------------- */

test("auto-start is never installed implicitly", () => {
  const pkg = JSON.parse(read(path.join(ROOT, "package.json"))) as {
    scripts: Record<string, string>;
  };
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prestart"]) {
    assert.equal(pkg.scripts[hook], undefined, `${hook} must not exist`);
  }
  // The task is registered only by an explicit `npm run autostart:install`.
  assert.match(pkg.scripts["autostart:install"], /devpulse-autostart\.ps1 -Action Install/);

  // And nothing in the application reaches for the auto-start script.
  const instrumentation = read(path.join(ROOT, "src", "instrumentation.ts"));
  assert.doesNotMatch(instrumentation, /autostart|devpulse-runtime/i);
});

test(
  "the registration is built from paths and switches, with no secret and no prefix",
  { skip: !isWindows },
  () => {
    const output = dryRun("Install", 0);

    assert.match(output, /dry run - nothing is registered/);
    assert.match(output, /execute\s+: powershell\.exe/);
    assert.match(output, /-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden/);
    assert.match(output, /-File ".*devpulse-runtime\.ps1" -Detached/);
    assert.match(output, /trigger\s+: AtLogOn/);
    assert.match(output, /run level\s+: Limited/);
    assert.match(output, /logon type\s+: Interactive/);
    assert.match(output, /working dir\s+: .*devpulse/);
    assert.doesNotMatch(output, /SYSTEM|S-1-5-18/);
    assert.doesNotMatch(output, /GITHUB|DEEPSEEK|token|api[_ -]?key/i);
  },
);

test(
  "install and remove dry runs change nothing",
  { skip: !isWindows },
  () => {
    assert.match(dryRun("Install", 0), /nothing is registered/);
    assert.match(dryRun("Remove", 0), /dry run - would remove the scheduled task/);
    // Status is read-only in every mode; a machine without the task reports so
    // rather than failing.
    const status = dryRun("Status");
    assert.match(status, /DevPulse auto-start is (installed|NOT installed)/);
  },
);
