# DevPulse

Developer observability dashboard for this machine: system telemetry, website
and API checks, devices, storage, security posture, GitHub activity, alerts and
an AI-assisted brief - collected in the background and served from a local
dashboard.

Local-first: everything is collected and stored on this machine, in a SQLite
file you own. Nothing is sent anywhere unless you configure a credential and ask
for an AI feature.

## What V1 includes

- **Monitoring** - local system telemetry (CPU, memory, load), network sampling,
  website uptime/response checks, HTTP API checks, GitHub activity, device
  reachability, storage capacity, and local security posture
  (firewall / Defender / listening sockets).
- **Alerts and history** - an alert engine over threshold transitions, a unified
  history timeline, and optional AI explanations for a single alert.
- **Projects** - group monitored websites, APIs and repositories into projects
  and roll their state up into per-project health.
- **AI intelligence** - Ask DevPulse (question answering over your own
  collected data), a grounded daily brief, and on-demand analysis.
- **Settings** - source management for every monitored target, integration
  status, notification preferences, retention, and dashboard customization.
- **Runtime** - a background scheduler in the server process, centralized SQLite
  with versioned migrations, collector health reporting, and a persistent
  Windows launcher with optional auto-start at logon.

## Screenshots

No screenshots are committed to this repository yet. Run the dashboard locally
(see [Quick start](#quick-start-development)) to see it; the UI is a compact,
neutral developer-tool layout with a sidebar, a status topbar, and one page per
monitoring area. Screenshots will be added here before the first public release
announcement.

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
containing the pid it started and the database path it resolved; a second start
is refused while that pid is alive. A lock left behind by a crash (the pid is gone, or the pid now belongs to
an unrelated program) is detected as stale and cleared automatically - a crash
never makes DevPulse permanently unstartable. Stopping only ever targets the pid
recorded in that lock, never a wildcard match on `node`.

### Environment and secrets

All six variables are optional; every one has a working default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | _(unset)_ | GitHub API access. Without it the GitHub collector is inactive. |
| `DEEPSEEK_API_KEY` | _(unset)_ | Enables the AI features. Without it they report a missing key. |
| `DEVPULSE_PORT` | `3000` | Port for the production server. `-Port` wins over it. |
| `DEVPULSE_HOST` | `127.0.0.1` | Bind address. Only an IP address or hostname is accepted. |
| `DEVPULSE_DB_PATH` | _(unset)_ | Exact SQLite file to use. Highest precedence. |
| `DEVPULSE_DB_DIR` | _(unset)_ | Directory holding `telemetry.db`. Second precedence. |

With neither database variable set, the database is
`<project root>\.devpulse\telemetry.db`. A relative `DEVPULSE_DB_DIR` resolves
against the process working directory, which the launcher sets to the project
root. See `.env.example` for the commented template.

- Secrets live in `.env.local` only. It is git-ignored; `.env.example` is the
  documented template and contains no values.
- The launcher, the generated task and the runtime log never contain a token or
  key. Nothing copies a secret onto a command line.
- `.env.local` is read by Next.js itself, for `next start` as well as
  `next dev`, so no launcher-side environment handling is needed.
- Optional variables (`GITHUB_TOKEN`, `DEEPSEEK_API_KEY`) degrade gracefully:
  without them the affected collectors report themselves as inactive and
  everything else keeps running.
- Child processes never inherit a credential: the PowerShell helpers (toast,
  security, storage, network) are spawned with `GITHUB_TOKEN` and
  `DEEPSEEK_API_KEY` removed from their environment.

### Network exposure

DevPulse V1 has **no authentication**. It binds to `127.0.0.1` by default, which
keeps it on the machine that runs it.

Setting `DEVPULSE_HOST` to a non-loopback address (for example `0.0.0.0`) makes
the dashboard reachable from anywhere that can route to the port, and anyone who
reaches it can read the dashboard and change its settings. The launcher prints a
warning when that happens, and `npm run runtime:check` reports the bind as
reachable from other machines.

> Do not expose DevPulse directly to an untrusted network.

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

## AI features

Four features generate text, and all four need `DEEPSEEK_API_KEY`:

| Feature | Where |
| --- | --- |
| Ask DevPulse - questions answered from your own collected data | `/ask` |
| Daily brief - a rolling 24-hour operational summary | `/brief` |
| Intelligence analysis | Insights panel |
| Alert explanation - explains one alert | Alert detail |

**When DeepSeek is called.** Only when you trigger one of those four, and only
through their own API routes (`POST /api/ask`, `/api/brief`,
`/api/intelligence/analyze`, `/api/alerts/<id>/explain`). DevPulse makes no
background or scheduled model calls: the scheduler never generates AI text, and
simply loading a dashboard page never calls the model. Requests go to
`https://api.deepseek.com` (default model `deepseek-chat`) with the collected
context as the prompt, and only request metadata - timestamp, model, token
counts, latency, status - is stored locally.

**AI usage is not a model call.** The AI usage page reads the Claude Code
transcripts DevPulse already has on this machine, read-only, to report local
token usage and estimated cost. It contacts nothing.

## Privacy

DevPulse is local-first by design:

- Monitoring data is written to a local SQLite file and served from
  `127.0.0.1`. There is no DevPulse account, telemetry upload, or hosted backend.
- Outbound requests are limited to what you configure: the GitHub API (with a
  token), the websites and APIs you add, and the four AI features above when you
  invoke them.
- Credentials stay in `.env.local`, are never written to the runtime log or task,
  and are stripped from the environment of every child process DevPulse spawns.
- Collector error messages are redacted before they are stored or displayed, so
  a token that appears in an upstream error text does not reach the database.

## Known V1 limitations

Accepted and documented, not hidden:

- **Windows-focused runtime.** The launcher, auto-start task and the local
  security, storage and network collectors target Windows 10/11. The dashboard
  and the database layer are portable, but the persistent runtime path is not.
- **No authentication.** DevPulse binds to `127.0.0.1` by default and has no
  login. Anyone who can reach the port can read the dashboard and change its
  settings - see [Network exposure](#network-exposure).
- **Outbound request validation.** Requests to monitored targets are validated
  against private/loopback ranges before connecting, but a DNS rebinding attack
  can still change what a hostname resolves to between validation and connect
  (a validation-to-connect TOCTOU). This is a known limitation of the redirect
  and SSRF hardening, not a regression.
- **Malformed percent-escapes in dynamic routes.** A URL segment containing a
  malformed percent-escape is handled by the framework before it reaches the
  handler. DevPulse no longer double-decodes a parameter, but the shape of the
  framework's own response is not something the app controls.
- **AI features require a key.** Without `DEEPSEEK_API_KEY`, Ask DevPulse, the
  daily brief, intelligence analysis and alert explanations are unavailable.
  Everything else keeps working.
- **Observational, not a security product.** Security, device and storage
  monitoring report what the local machine can observe. They are not an
  intrusion detection system, not a vulnerability scanner, and not a substitute
  for one.

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
