# DevPulse v1.0.0

First release. DevPulse is a local-first developer observability dashboard: it
watches this machine and the services you point it at, and serves what it finds
from a dashboard on `127.0.0.1`.

Everything is collected and stored locally in SQLite. Nothing leaves the machine
unless you configure a credential and invoke an AI feature.

## Monitoring

- **System telemetry** - CPU, memory and load, sampled on a 30s cadence.
- **Network** - local network sampling.
- **Websites** - uptime and response-time checks against the sites you add.
- **APIs** - HTTP checks against the endpoints you add, on the same cadence as
  website monitoring, with redirect handling hardened against SSRF.
- **GitHub** - repository activity via the GitHub API. Optional; inactive
  without a token.
- **Devices** - reachability for the machines you list.
- **Storage** - capacity and free space per volume.
- **Security** - local posture: firewall state, Defender state and listening
  sockets, sampled on a slow cadence because it changes on a human timescale.
- **AI usage** - local Claude Code token usage and estimated cost, read
  read-only from transcripts already on this machine. This is not a model call.

Every collector reports its own health, so a source that has stopped producing
data is shown as stale or inactive rather than silently missing.

## Alerts and history

- An alert engine that fires on threshold transitions rather than on every
  sample, so the timeline stays readable.
- A unified history timeline across all sources, with the timeline query
  optimized so a long history stays responsive.
- Optional AI explanations for an individual alert, grounded in the alert's own
  recorded data.
- Desktop notifications, with per-source preferences.

## Projects

Group monitored websites, APIs and repositories into projects, and roll their
individual state up into a single project health view.

## AI intelligence

Four features, all requiring `DEEPSEEK_API_KEY`:

- **Ask DevPulse** - ask a question and have it answered from your own collected
  data.
- **Daily brief** - a grounded operational summary over a rolling 24 hours.
- **Intelligence analysis** - on-demand analysis from the insights panel.
- **Alert explanation** - a plain-language explanation of one alert.

These are the only features that call a model, and they call it only when you
invoke them. There are no background or scheduled AI calls. Requests go to the
DeepSeek API; only request metadata (timestamp, model, token counts, latency,
status) is stored locally.

## Windows runtime

DevPulse is one long-lived process that owns the dashboard, the API routes and
the background scheduler - monitoring continues with no browser tab open.

- `npm run build` then `npm run runtime` for a persistent production server.
- `npm run runtime:check` / `:status` / `:stop` for preflight, health and a
  clean shutdown.
- Optional auto-start at logon (`npm run autostart:install` / `:status` /
  `:remove`). It is never installed implicitly - nothing in `npm install`,
  `npm run build` or application startup registers a scheduled task.
- A single-instance lock: a second start is refused while the first is alive,
  and a lock left behind by a crash is detected as stale and cleared. Stopping
  only ever targets the pid recorded in the lock.

## Security and privacy

- No account, no telemetry upload, no hosted backend. Default bind is
  `127.0.0.1`.
- Credentials live in `.env.local` only, are never written into the runtime log
  or the generated task, and are stripped from the environment of every child
  process DevPulse spawns.
- Collector error text is redacted before storage or display.
- The launcher warns when it is configured to bind to a non-loopback address.

## Known limitations

- **Windows-focused.** The launcher, auto-start task and the local security,
  storage and network collectors target Windows 10/11. The dashboard and the
  database layer are portable; the persistent runtime path is not.
- **No authentication.** Anyone who can reach the port can read the dashboard
  and change its settings. Do not expose DevPulse directly to an untrusted
  network.
- **DNS rebinding / validation-to-connect TOCTOU.** Outbound requests are
  validated against private and loopback ranges before connecting, but a
  hostname can re-resolve between validation and connect. Known and accepted.
- **Malformed percent-escapes** in dynamic route segments are handled by the
  framework, outside the application's control.
- **AI features need a key.** Without `DEEPSEEK_API_KEY` they are unavailable;
  everything else keeps working.
- **Observational, not a security product.** The security, device and storage
  monitors report what the local machine can observe. They are not intrusion
  detection, not a vulnerability scanner, and not a substitute for either.

## Requirements

Windows 10/11, Node.js 20.9 or newer (LTS 22 recommended), npm.
