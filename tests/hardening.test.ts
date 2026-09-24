/**
 * V1 hardening regressions (Task 33).
 *
 * Three boundaries that were inspected and found wanting, and the behavior that
 * now pins each one shut:
 *
 *   1. Route parameters. Next.js already percent-decodes a dynamic segment; the
 *      handlers decoded it a second time. A segment containing a literal '%'
 *      threw URIError out of the handler and produced an unhandled 500 (and, on
 *      the read route, was misreported as a storage outage). A parameter is now
 *      used exactly as delivered, so a malformed or unknown id is an ordinary
 *      not-found rather than a crash.
 *   2. Child process environment. Node inherits the parent environment into
 *      every child by default, so the PowerShell helpers were handed the
 *      configured credentials even though their scripts are constants. They are
 *      now stripped at each spawn site.
 *   3. The production launcher's bind address. It is passed to `next start` as
 *      an argument, and Start-Process joins an argument array into a command
 *      line without quoting, so an unvalidated DEVPULSE_HOST could append flags
 *      of its own. The launcher now accepts only an IP literal or hostname, and
 *      says plainly when a non-loopback bind is selected.
 *
 * No real network calls and no real database: every route test runs against a
 * fresh OS temp database, and the launcher assertions read the script's source.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_NAME } from "../src/lib/db/path";
import { migrate } from "../src/lib/db/schema";
import { closeDb } from "../src/lib/db/index";
import { CREDENTIAL_ENV_VARS, withoutCredentials } from "../src/lib/secrets";
import { createProject } from "../src/lib/projects/service";
import { listProjectRows } from "../src/lib/projects/storage";

/* ------------------------------ helpers ------------------------------ */

const DB_ENV = ["DEVPULSE_DB_PATH", "DEVPULSE_DB_DIR"] as const;
const ROOT = process.cwd();
const LAUNCHER = path.join(ROOT, "scripts", "devpulse-runtime.ps1");

/** Point DevPulse at a fresh temp database for the duration of `fn`. */
function withTempDb(t: { after: (fn: () => void) => void }, fn: () => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "devpulse-hardening-"));
  const file = path.join(dir, DB_FILE_NAME);
  const saved = DB_ENV.map((k) => [k, process.env[k]] as const);

  const schema = new DatabaseSync(file);
  migrate(schema); // create the schema up front, as a real open would
  schema.close();

  for (const k of DB_ENV) delete process.env[k];
  process.env.DEVPULSE_DB_PATH = file;

  t.after(() => {
    closeDb();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  fn();
}

/** The params object Next.js hands a dynamic route handler. */
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const json = (body: unknown) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/* ------------------------- 1. route parameters ------------------------- */

test("a route parameter containing a literal percent is not decoded again", async (t) => {
  let id = "";
  withTempDb(t, () => {
    const created = createProject({ name: "Percent", description: null });
    assert.ok(created.ok);
    id = listProjectRows()?.[0]?.id ?? "";
    assert.ok(id);
  });

  const route = await import("../src/app/api/projects/[id]/route");

  // A perfectly valid id round-trips: Next decodes the segment once, and it is
  // used as delivered.
  const found = await route.GET(
    new Request(`http://localhost/api/projects/${id}`),
    params(id),
  );
  assert.equal(found.status, 200, "a known id should resolve");

  // A value whose decode fails must be an ordinary miss, never a thrown 500.
  for (const bad of ["%", "%zz", "%2", "%E0%A4%A"]) {
    const res = await route.GET(
      new Request("http://localhost/api/projects/x"),
      params(bad),
    );
    assert.equal(res.status, 404, `GET with ${JSON.stringify(bad)} must be a miss`);
  }
});

test("mutating routes treat a malformed project id as not-found, not a crash", async (t) => {
  withTempDb(t, () => {});

  const route = await import("../src/app/api/projects/[id]/route");

  const put = await route.PUT(json({ name: "Renamed" }), params("%"));
  assert.equal(put.status, 400, "an unknown project cannot be updated");

  const del = await route.DELETE(
    new Request("http://localhost/api/projects/x", { method: "DELETE" }),
    params("%"),
  );
  assert.equal(del.status, 404, "an unknown project cannot be deleted");
});

test("alert explain treats a malformed fingerprint as not-found", async (t) => {
  withTempDb(t, () => {});

  const route = await import("../src/app/api/alerts/[id]/explain/route");

  for (const bad of ["%", "%zz", "not-a-fingerprint"]) {
    const res = await route.POST(json({}), params(bad));
    assert.equal(
      res.status,
      404,
      `explain with ${JSON.stringify(bad)} must be a miss`,
    );
  }
});

test("source assignment treats a malformed project id as a rejected request", async (t) => {
  withTempDb(t, () => {});

  const route = await import("../src/app/api/projects/[id]/sources/route");

  const res = await route.POST(json({ type: "website", id: "w1" }), params("%"));
  assert.equal(res.status, 400, "an unknown project cannot adopt a source");
});

/* ---------------------- 2. child process environment ---------------------- */

test("credential variables are removed from a child environment", () => {
  const parent: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: "/usr/bin",
    SystemRoot: "C:\\Windows",
    GITHUB_TOKEN: "ghp_averyrealtokenvalue123456",
    DEEPSEEK_API_KEY: "sk-averyrealkeyvalue1234567",
  };

  const child = withoutCredentials(parent);

  for (const name of CREDENTIAL_ENV_VARS) {
    assert.equal(name in child, false, `${name} must not reach a child`);
  }
  // Everything a child actually needs survives.
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.SystemRoot, "C:\\Windows");
  // The parent object is not mutated.
  assert.ok(parent.GITHUB_TOKEN, "the caller's environment is left alone");
});

test("the PowerShell spawn sites do not hand the credentials to a child", () => {
  const sites = [
    "src/lib/notifications/windows.ts",
    "src/lib/security/windows.ts",
    "src/lib/telemetry/network.ts",
  ];
  for (const rel of sites) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /withoutCredentials\(\)/, `${rel} should strip credentials`);
    assert.doesNotMatch(
      src,
      /env:\s*\{?\s*\.\.\.process\.env/,
      `${rel} should not relay the whole environment`,
    );
  }
});

/* ------------------------ 3. launcher bind address ------------------------ */

test("the launcher validates DEVPULSE_HOST before it becomes an argument", () => {
  const src = readFileSync(LAUNCHER, "utf8");

  assert.match(src, /function Test-BindAddress/, "the guard should exist");
  assert.match(
    src,
    /if \(-not \(Test-BindAddress -Address \$BindAddress\)\)/,
    "the resolved bind address should be validated",
  );
  // A value that could append flags is refused before Start-Process sees it.
  assert.match(src, /StartsWith\('-'\)/, "a leading '-' must be refused");
});

test("the launcher warns when a non-loopback bind is selected", () => {
  const src = readFileSync(LAUNCHER, "utf8");

  assert.match(src, /function Test-LoopbackBind/, "loopback detection should exist");
  assert.match(
    src,
    /Test-LoopbackBind[^\n]*\n[^\n]*Write-RuntimeWarning/,
    "Run should warn before starting an exposed bind",
  );
  assert.match(src, /NO authentication/i, "the warning should name the risk");
  assert.match(
    src,
    /Do not expose DevPulse directly to an untrusted network/,
    "the warning should carry the documented guidance",
  );
});
