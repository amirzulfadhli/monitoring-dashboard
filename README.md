# DevPulse

Developer observability dashboard for this machine: system telemetry, website
and API checks, devices, storage, security posture, GitHub activity, alerts and
an AI-assisted brief - collected in the background and served from a local
dashboard.

## Stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS v4
- SQLite (`node:sqlite`) for local history
- Server Components by default; a process-wide scheduler drives all collection

## Requirements

- Windows 10/11
- Node.js 20.9 or newer (LTS 22 recommended) - Next.js 16 requires it
- npm (bundled with Node)

## Quick start (development)

```powershell
npm install
copy .env.example .env.local     # optional; fill in what you use
npm run dev
```

Development mode is for editing. Monitoring runs in the same way, but `next dev`
is not the supported persistent runtime.

## Production runtime (Windows)

DevPulse is one long-lived Node/Next.js process. That single process owns
everything: the dashboard, the API routes, and the background scheduler that
keeps collecting while no browser tab is open.

```powershell
npm install
npm run build
npm run runtime          # long-lived production server on http://127.0.0.1:3000
```

| | |
| --- | --- |
| Host / port | `127.0.0.1:3000` (`DEVPULSE_HOST` / `DEVPULSE_PORT`) |
| Database | `<project root>\.devpulse\telemetry.db` |
| Environment | `.env.local` (Next.js loads it; the launcher never reads secrets) |
| Scheduler | started once by `src/instrumentation.ts` on server boot |
| Runtime log | `<project root>\.devpulse\logs\runtime.log` |
| Server logs | `.devpulse\logs\server.out.log`, `server.err.log` (auto-start mode) |
| Lock | `.devpulse\runtime.lock` |

### Commands

```powershell
npm run runtime            # start in the foreground (Ctrl+C stops it)
npm run runtime:check      # preflight: node, npm, build, env file, DB path, port, lock
npm run runtime:status     # is it running, on which pid/port, what is the scheduler doing
npm run runtime:stop       # stop the recorded pid and its children, clear the lock
```

### Auto-start at logon

Optional, and **only** installed when you ask for it - nothing in `npm install`,
`npm run build` or application startup registers a task.

```powershell
npm run autostart:install    # one scheduled task, current user, at logon
npm run autostart:status     # inspect it (name, action, user, last result)
npm run autostart:remove     # unregister it (does not stop a running process)
```

The task is named `DevPulse` and is registered with Windows Task Scheduler:

- trigger: at logon, for the current user, in their interactive session
  (desktop notifications need a logged-in session - DevPulse is never a
  SYSTEM/service task)
- run level: limited / unelevated; creating the task normally needs no
  administrator rights. If your machine's policy refuses, re-run
  `npm run autostart:install` from an elevated PowerShell.
- working directory: the project root, so the database path is the same one a
  manual start uses
- `MultipleInstances: IgnoreNew`, so a second logon cannot stack a second server
- no time limit (a server has to keep running); tasks are not started on demand
- its arguments are a script path and switch names only: no token, key or other
  environment value is ever written into the task

To see exactly what would be registered without registering it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\devpulse-autostart.ps1 -Action Install -DryRun
```

### Start, stop, restart

| Goal | Command |
| --- | --- |
| Start | `npm run runtime` |
| Stop (foreground) | `Ctrl+C` in its console |
| Stop (background / auto-start) | `npm run runtime:stop` |
| Restart | `npm run runtime:stop`, then `npm run runtime` |
| Check health | `npm run runtime:status` |
| Disable auto-start | `npm run autostart:remove` |
| Disable auto-start and stop | `npm run autostart:remove` then `npm run runtime:stop` |

Only one instance runs at a time. The launcher holds `.devpulse\runtime.lock`
containing the pid it started; a second start is refused while that pid is
alive. A lock left behind by a crash (the pid is gone, or the pid now belongs to
an unrelated program) is detected as stale and cleared automatically - a crash
never makes DevPulse permanently unstartable. Stopping only ever targets the pid
recorded in that lock, never a wildcard match on `node`.

### Environment and secrets

- Secrets live in `.env.local` only. It is git-ignored; `.env.example` is the
  documented template and contains no values.
- The launcher, the generated task and the runtime log never contain a token or
  key. Nothing copies a secret onto a command line.
- `.env.local` is read by Next.js itself, for `next start` as well as
  `next dev`, so no launcher-side environment handling is needed.
- Optional variables (`GITHUB_TOKEN`, `DEEPSEEK_API_KEY`) degrade gracefully:
  without them the affected collectors report themselves as inactive and
  everything else keeps running.

### Troubleshooting startup

```powershell
npm run runtime:check
```

It reports the project root, Node version, npm path, whether a production build
is present, whether `.env.local` exists, the resolved database path, whether the
port is free, and the state of the lock. Common answers:

| Symptom | Cause |
| --- | --- |
| `no production build in .next` | run `npm run build` first |
| `another DevPulse instance is already running (pid N)` | use `npm run runtime:status`, or `npm run runtime:stop` |
| `port 3000 is already in use` | something else owns the port; set `DEVPULSE_PORT` |
| `node ... is too old` | install Node 20.9+ |
| Server starts then exits immediately | read `.devpulse\logs\runtime.log`; in auto-start mode the last lines of `server.err.log` are appended there |
| Dashboard reachable but collectors stay stale | `npm run runtime:status` for per-collector state; check `GITHUB_TOKEN` / `DEEPSEEK_API_KEY` for inactive ones |

Desktop notifications additionally require an interactive, logged-in user
session - they cannot appear for a process running without one. That is exactly
why the auto-start task runs at logon in the user's own session.

## Layout

```
src/app/          routes and layouts
src/components/   shared UI
src/lib/          utilities and services (scheduler, collectors, storage)
src/data/         mock data
scripts/          Windows runtime launcher and auto-start task management
tests/            node:test suites
```

## Verification

```powershell
npm test
npx tsc --noEmit
npm run lint
npm run build
```
