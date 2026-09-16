/**
 * Unified DevPulse History timeline.
 *
 * Reduces persisted rows from every monitoring source into a single normalized
 * event stream (see ./model). Normalization lives here, server-side — React
 * components never touch source tables. Each source generator is isolated so a
 * failure or gap in one never drops the others: the read helpers already return
 * []/empty on failure, and every builder is additionally wrapped.
 *
 * Privacy: events carry only small metadata keys. No prompts, completions,
 * bodies, workflow logs, or credentials ever cross this boundary.
 */

import { monitoredSites } from "@/data/monitored-sites";
import { monitoredRepos } from "@/data/monitored-repos";
import { listRepositories, listWebsites } from "@/lib/settings/storage";
import { readAlerts } from "@/lib/alerts/storage";
import type { AlertRecord } from "@/lib/alerts/model";
import { readWebsiteChecks } from "@/lib/monitoring/storage";
import type { StoredWebsiteCheck } from "@/lib/monitoring/storage";
import { readGithubSnapshotsSince } from "@/lib/monitoring/github-snapshots";
import type { StoredGithubSnapshot } from "@/lib/monitoring/github-snapshots";
import { readUsageRowsSince } from "@/lib/monitoring/ai-storage";
import type { UsageRowForHistory } from "@/lib/monitoring/ai-storage";
import { readTelemetryRows } from "@/lib/telemetry/storage";
import type { TelemetryRow } from "@/lib/telemetry/storage";

import {
  HISTORY_RANGES,
  type HistoryRangeKey,
  type TimelineEvent,
  type TimelineMetadata,
  type TimelineSource,
} from "./model";

/** Build the full newest-first timeline over a range. Never throws. */
export function buildTimeline(range: HistoryRangeKey): TimelineEvent[] {
  const rangeMs = HISTORY_RANGES[range];
  const since = Date.now() - rangeMs;
  const events: TimelineEvent[] = [];
  const names = createNameLookup();

  // Each source contributes independently; a failure leaves that slice empty.
  try {
    events.push(
      ...systemAndNetworkEvents(rangeMs, since, readTelemetryRows(since)),
    );
  } catch {
    /* system slice unavailable — keep the rest */
  }
  try {
    events.push(...websiteEvents(readWebsiteChecks(since), names));
  } catch {
    /* website slice unavailable */
  }
  try {
    events.push(...githubEvents(readGithubSnapshotsSince(since), names));
  } catch {
    /* github slice unavailable */
  }
  try {
    events.push(...aiEvents(rangeMs, since, readUsageRowsSince(since)));
  } catch {
    /* ai slice unavailable */
  }
  try {
    events.push(...alertEvents(since, readAlerts("all")));
  } catch {
    /* alert slice unavailable */
  }

  // Newest first; cap total so a response is always bounded.
  events.sort((a, b) => b.ts - a.ts);
  return events.slice(0, 2000);
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Equal-width bucket that mirrors the AI page (24H hourly → 30D daily). */
function bucketStepMs(rangeMs: number): number {
  if (rangeMs <= HISTORY_RANGES["24H"]) return 3_600_000; // hourly
  if (rangeMs <= HISTORY_RANGES["7D"]) return 6 * 3_600_000; // 6-hourly
  return 86_400_000; // daily
}

/** Bucket index containing `ts` for buckets aligned to `since`. */
function bucketAt(ts: number, since: number, step: number): number {
  return Math.floor((ts - since) / step);
}

function bucketStart(idx: number, since: number, step: number): number {
  return since + idx * step;
}

/** Compact whole-number formatter: 184000 -> "184K", 1009694 -> "1.0M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

/**
 * Render a cost in USD, trimmed to at most 4 decimals.
 *
 * Equivalent to `toLocaleString("en-US", { maximumFractionDigits: 4 })` for the
 * non-negative costs this formats — `toFixed` already bounds the fraction to 4
 * digits, so only the thousands separators are left to render. Doing it directly
 * avoids the ICU round-trip, which dominated the AI slice's assembly cost.
 */
function fmtCost(usd: number): string {
  const v = Number(usd.toFixed(4));
  const [whole, fraction] = String(v).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${fraction ? `${grouped}.${fraction}` : grouped}`;
}

function fmtBytes(b: number): string {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)}GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)}MB`;
  if (b >= 1 << 10) return `${(b / (1 << 10)).toFixed(1)}KB`;
  return `${Math.round(b)}B`;
}

function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(bytesPerSec)}/s`;
}

/** Label for a bucket's time span, e.g. "20:00–21:00" or "Sep 4". */
function bucketLabel(idx: number, since: number, step: number): string {
  const start = bucketStart(idx, since, step);
  const end = start + step;
  const fmt = (t: number) =>
    step < 86_400_000
      ? `${String(new Date(t).getHours()).padStart(2, "0")}:00`
      : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return step < 86_400_000
    ? `${fmt(start)}–${fmt(end)}`
    : fmt(start);
}

const escId = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

function ev(
  source: TimelineSource,
  type: string,
  subject: string,
  ts: number,
  severity: TimelineEvent["severity"],
  title: string,
  description: string,
  metadata?: TimelineMetadata,
): TimelineEvent {
  return {
    id: `${source}:${type}:${escId(subject)}:${ts}`,
    ts,
    source,
    type,
    ...(severity ? { severity } : {}),
    title,
    description,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Display names for timeline subjects, resolved once per build.
 *
 * Names prefer the persisted settings store so renames reflect in the timeline;
 * the source-seeded arrays remain a fallback for removed targets whose history
 * still exists, and when the settings DB is unavailable.
 *
 * The settings lists are read lazily and cached for the whole build because the
 * builders ask for them per emitted event (and, for GitHub, per snapshot pair).
 * Resolving each lookup with its own SELECT made timeline assembly — not the
 * event derivation — the dominant cost. The maps are read-only views of a store
 * that is never written during a build, so the result is unchanged.
 */
type NameLookup = {
  site(targetId: string): string;
  repo(repoKey: string, snap: StoredGithubSnapshot): string;
};

function createNameLookup(): NameLookup {
  let sites: Map<string, string> | null = null;
  let repos: Map<string, string> | null = null;

  return {
    site(targetId) {
      if (!sites) {
        sites = new Map();
        // Seeded first, then settings — last write wins, so a persisted rename
        // takes precedence exactly as the previous `??` chain did.
        for (const s of monitoredSites) if (!sites.has(s.id)) sites.set(s.id, s.name);
        for (const w of listWebsites() ?? []) sites.set(w.id, w.name);
      }
      return sites.get(targetId) ?? targetId;
    },
    repo(repoKey, snap) {
      // `||` semantics: a blank display name falls through to the lookups.
      if (snap.displayName) return snap.displayName;
      if (!repos) {
        repos = new Map();
        for (const r of monitoredRepos) {
          const key = `${r.owner}/${r.repo}`;
          if (r.displayName && !repos.has(key)) repos.set(key, r.displayName);
        }
        for (const r of listRepositories() ?? []) {
          const key = `${r.owner}/${r.repo}`;
          if (r.displayName) repos.set(key, r.displayName);
        }
      }
      return repos.get(repoKey) ?? repoKey;
    },
  };
}

/* ------------------------------------------------------------------ *
 * System + network (hourly summaries, never raw 30s samples)
 * ------------------------------------------------------------------ */

const TELEMETRY_SOURCE_SEV: Record<string, TimelineSource> = {
  system: "system",
  network: "network",
};

function systemAndNetworkEvents(
  rangeMs: number,
  since: number,
  rows: TelemetryRow[],
): TimelineEvent[] {
  const step = bucketStepMs(rangeMs);
  const events: TimelineEvent[] = [];
  if (rows.length === 0) return events;

  // Accumulate per bucket: cpu/mem samples and rx/tx rate peaks+average.
  type Acc = {
    samples: number;
    cpu: number[];
    usedMem: number[];
    rx: number[];
    tx: number[];
  };
  const buckets = new Map<number, Acc>();

  for (const r of rows) {
    const i = bucketAt(r.ts, since, step);
    let a = buckets.get(i);
    if (!a) {
      a = { samples: 0, cpu: [], usedMem: [], rx: [], tx: [] };
      buckets.set(i, a);
    }
    a.samples++;
    if (r.cpuPct != null) a.cpu.push(r.cpuPct);
    if (r.usedMem != null) a.usedMem.push(r.usedMem);
    if (r.rxRate != null) a.rx.push(r.rxRate);
    if (r.txRate != null) a.tx.push(r.txRate);
  }

  const avg = (a: number[]) =>
    a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

  for (const [i, a] of buckets) {
    const ts = bucketStart(i, since, step);
    const when = bucketLabel(i, since, step);
    const cpu = avg(a.cpu);
    if (a.samples && (cpu != null || a.usedMem.length)) {
      const mem = avg(a.usedMem);
      events.push(
        ev(
          TELEMETRY_SOURCE_SEV.system,
          "system_summary",
          `sys:${ts}`,
          ts,
          cpu != null && cpu >= 90 ? "warning" : undefined,
          `${when} · System summary`,
          `${a.samples} samples · CPU ${cpu != null ? cpu.toFixed(1) : "—"}% avg` +
            (mem != null ? ` · mem ${fmtBytes(mem)} avg` : ""),
        ),
      );
    }
    if (a.rx.length || a.tx.length) {
      const rxAvg = avg(a.rx);
      const txAvg = avg(a.tx);
      const parts = [
        rxAvg != null ? `↓ ${fmtRate(rxAvg)} avg` : null,
        txAvg != null ? `↑ ${fmtRate(txAvg)} avg` : null,
      ].filter(Boolean);
      events.push(
        ev(
          TELEMETRY_SOURCE_SEV.network,
          "network_summary",
          `net:${ts}`,
          ts,
          undefined,
          `${when} · Network activity`,
          parts.join(" · ") || "No throughput recorded",
        ),
      );
    }
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * Websites (state transitions only — never one event per healthy poll)
 * ------------------------------------------------------------------ */

const STATE_SEV: Record<string, TimelineEvent["severity"]> = {
  healthy: "info",
  degraded: "warning",
  down: "critical",
};

function websiteEvents(
  rows: StoredWebsiteCheck[],
  names: NameLookup,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (rows.length === 0) return events;

  // Latest observed state per target, initialized lazily from the first in-range
  // row (a baseline, not an event — we only emit on a later change). Only the
  // state is needed from the previous row, so it is stored as a bare string
  // rather than an object: this loop runs once per persisted check.
  const last = new Map<string, string>();

  for (const r of rows) {
    const prev = last.get(r.targetId);
    if (prev !== undefined && prev !== r.state) {
      const name = names.site(r.targetId);
      const sev = STATE_SEV[r.state];
      events.push(
        ev(
          "website",
          "website_state",
          r.targetId,
          r.ts,
          sev,
          `${name} → ${r.state}`,
          `Transitioned from ${prev} to ${r.state}` +
            (r.latencyMs != null ? ` · ${r.latencyMs.toFixed(0)}ms` : "") +
            (r.httpStatus != null ? ` · HTTP ${r.httpStatus}` : ""),
          {
            targetId: r.targetId,
            from: prev,
            state: r.state,
            latencyMs: r.latencyMs,
            httpStatus: r.httpStatus,
          },
        ),
      );
    }
    last.set(r.targetId, r.state);
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * GitHub (only real changes — unchanged snapshots never emit)
 * ------------------------------------------------------------------ */

function githubEvents(
  rows: StoredGithubSnapshot[],
  names: NameLookup,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (rows.length === 0) return events;

  // Group newest-first runs per repo; walk oldest→newest comparing neighbours.
  const byRepo = new Map<string, StoredGithubSnapshot[]>();
  for (const r of rows) {
    let arr = byRepo.get(r.repoKey);
    if (!arr) {
      arr = [];
      byRepo.set(r.repoKey, arr);
    }
    arr.push(r);
  }

  for (const [repoKey, snaps] of byRepo) {
    snaps.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const cur = snaps[i];
      const display = names.repo(repoKey, cur);

      if (cur.commitSha && prev.commitSha !== cur.commitSha) {
        events.push(
          ev(
            "github",
            "commit_changed",
            `commit:${repoKey}`,
            cur.ts,
            undefined,
            `${display} · new commit`,
            `Head ${cur.commitSha}${cur.commitDateMs ? ` · ${new Date(cur.commitDateMs).toISOString().slice(0, 10)}` : ""}`,
            { repoKey, commitSha: cur.commitSha, repoName: cur.repoName },
          ),
        );
      }

      if (
        (cur.workflowConclusion || cur.workflowStatus) &&
        (prev.workflowConclusion !== cur.workflowConclusion ||
          prev.workflowStatus !== cur.workflowStatus)
      ) {
        const conclusion = cur.workflowConclusion;
        const sev =
          conclusion === "failure" ? "warning" : conclusion === "success" ? "info" : undefined;
        events.push(
          ev(
            "github",
            "workflow_changed",
            `wf:${repoKey}`,
            cur.ts,
            sev,
            `${display} · workflow ${conclusion ?? cur.workflowStatus}`,
            cur.workflowName
              ? `${cur.workflowName} on ${cur.workflowBranch ?? "default"}`
              : `${cur.workflowStatus ?? "updated"} on ${cur.workflowBranch ?? "default"}`,
            {
              repoKey,
              workflow: cur.workflowName,
              conclusion: cur.workflowConclusion,
              status: cur.workflowStatus,
            },
          ),
        );
      }

      if (prev.state !== cur.state) {
        events.push(
          ev(
            "github",
            "repo_state_changed",
            `state:${repoKey}`,
            cur.ts,
            cur.state === "attention" ? "warning" : undefined,
            `${display} → ${cur.state}`,
            `Repository health moved from ${prev.state} to ${cur.state}`,
            { repoKey, from: prev.state, state: cur.state },
          ),
        );
      }
    }
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * AI usage (per time-bucket summaries — never one event per request)
 * ------------------------------------------------------------------ */

const AI_SOURCE_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  direct: "Direct DeepSeek",
};

function aiEvents(
  rangeMs: number,
  since: number,
  rows: UsageRowForHistory[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (rows.length === 0) return events;
  const step = bucketStepMs(rangeMs);

  type Acc = {
    requests: number;
    input: number;
    output: number;
    total: number;
    cost: number;
    hasCost: boolean;
    modelTokens: Map<string, number>;
  };
  // key = bucketIdx:source
  const buckets = new Map<string, Acc>();
  const keyOf = (i: number, src: string) => `${i}:${src}`;
  const newAcc = (): Acc => ({
    requests: 0,
    input: 0,
    output: 0,
    total: 0,
    cost: 0,
    hasCost: false,
    modelTokens: new Map(),
  });

  for (const r of rows) {
    const i = bucketAt(r.ts, since, step);
    const src = r.source === "claude-code" ? "claude-code" : "direct";
    const key = keyOf(i, src);
    let a = buckets.get(key);
    if (!a) {
      a = newAcc();
      buckets.set(key, a);
    }
    a.requests++;
    a.input += r.inputTokens ?? 0;
    a.output += r.outputTokens ?? 0;
    a.total += r.totalTokens ?? 0;
    if (r.estimatedCostUsd != null) {
      a.cost += r.estimatedCostUsd;
      a.hasCost = true;
    }
    const model = r.model || "unknown";
    a.modelTokens.set(model, (a.modelTokens.get(model) ?? 0) + (r.totalTokens ?? 0));
  }

  for (const [key, a] of buckets) {
    const sep = key.indexOf(":");
    const i = Number(key.slice(0, sep));
    const src = key.slice(sep + 1);
    if (a.requests === 0) continue;
    const label = AI_SOURCE_LABEL[src] ?? src;
    const ts = bucketStart(i, since, step);
    const when = bucketLabel(i, since, step);
    // Dominant model by tokens, when one clearly leads (else "mixed").
    const [domModel] = [...a.modelTokens.entries()].sort((x, y) => y[1] - x[1])[0] ?? [
      null,
      0,
    ];
    const model =
      a.modelTokens.size === 1 || (a.modelTokens.get(domModel!) ?? 0) >= 0.5 * a.total
        ? domModel
        : "mixed";
    const desc =
      `${a.requests} request${a.requests === 1 ? "" : "s"} · ` +
      `${compact(a.total)} tokens ` +
      `(${compact(a.input)} in / ${compact(a.output)} out)` +
      (a.hasCost && a.cost > 0 ? ` · ${fmtCost(a.cost)} est` : "");

    events.push(
      ev(
        "ai",
        "ai_usage_bucket",
        `ai:${src}:${ts}`,
        ts,
        a.hasCost && a.cost >= 5 ? "warning" : undefined,
        `${label} · ${when}`,
        desc,
        {
          source: src,
          model,
          requests: a.requests,
          inputTokens: a.input,
          outputTokens: a.output,
          totalTokens: a.total,
          estimatedCostUsd: a.hasCost ? Number(a.cost.toFixed(4)) : null,
        },
      ),
    );
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * Alerts (activation / resolution — derived only from persisted state)
 * ------------------------------------------------------------------ */

function alertEvents(since: number, alerts: AlertRecord[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const a of alerts) {
    // A currently-active alert was first observed at firstSeenAt.
    if (a.status === "active" && a.firstSeenAt >= since) {
      events.push(
        ev(
          "alert",
          "alert_active",
          a.fingerprint,
          a.firstSeenAt,
          a.severity,
          `Alert · ${a.title}`,
          a.message,
          {
            ruleId: a.ruleId,
            alertSource: a.source,
            severity: a.severity,
          },
        ),
      );
    } else if (a.status === "resolved" && a.resolvedAt != null && a.resolvedAt >= since) {
      events.push(
        ev(
          "alert",
          "alert_resolved",
          a.fingerprint,
          a.resolvedAt,
          undefined,
          `Resolved · ${a.title}`,
          a.message,
          {
            ruleId: a.ruleId,
            alertSource: a.source,
            severity: a.severity,
          },
        ),
      );
    }
  }
  return events;
}
