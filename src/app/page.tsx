"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLiveTelemetry } from "@/lib/use-live-telemetry";
import { useMonitoringStatus } from "@/lib/use-monitoring-status";
import { IntelligencePanel } from "@/components/intelligence-panel";

const REFRESH_MS = 4000; // live telemetry poll (~3–5s requested)
const WARN_PCT = 90; // CPU or memory % at/above this flags a Warning status
const LIMITED_POINTS = 20; // below this many 24h samples, note sparse history

type Tone = "good" | "warn" | "critical";
const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};
const toneText: Record<Tone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

// Aggregate returned by /api/telemetry/summary over the last 24 hours.
type HistorySummary = {
  points: number;
  cpu: { avg: number | null; peak: number | null };
  usedMem: { avg: number | null; peak: number | null }; // bytes
  rxRate: number | null; // peak bytes/sec
  txRate: number | null; // peak bytes/sec
};

/** Pretty-print a byte count, e.g. 1.4 GB. */
function fmtBytes(bytes: number | null): string {
  if (bytes == null) return "–";
  const b = Math.max(0, bytes);
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b.toFixed(0)} B`;
}

/** Bytes/second -> compact rate label, e.g. 12.4 KB/s. */
function fmtRate(bps: number | null): string {
  if (bps == null) return "–";
  const b = Math.max(0, bps);
  if (b >= 1e6) return `${(b / 1e6).toFixed(2)} MB/s`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB/s`;
  return `${b.toFixed(0)} B/s`;
}

function fmtPct(v: number | null): string {
  return v == null ? "–" : `${v.toFixed(0)}%`;
}

/** Compact age of the last background sample, e.g. "12s ago" / "4m ago". */
function fmtAge(ms: number | null): string {
  if (ms == null) return "–";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fmtUptime(sec: number | null): string {
  if (sec == null) return "–";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** A muted small stat: label over a mono value (used for metrics & summaries). */
function StatTile({
  label,
  value,
  unit,
  dot,
  foot,
}: {
  label: string;
  value: string;
  unit?: string;
  dot?: Tone;
  foot?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-3 flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {dot && <span className={`h-2 w-2 rounded-full ${toneDot[dot]}`} aria-hidden="true" />}
        {value}
        {unit && (
          <span className="text-sm font-normal text-zinc-400 dark:text-zinc-500">{unit}</span>
        )}
      </p>
      {foot && <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">{foot}</p>}
    </div>
  );
}

/** A titled panel of label/value definition rows. */
function DetailPanel({ title, rows }: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      <p className="border-b border-zinc-100 px-4 py-3 text-sm font-medium text-zinc-900 dark:border-zinc-800/60 dark:text-zinc-100">
        {title}
      </p>
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4 px-4 py-2">
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{r.label}</dt>
            <dd className="truncate text-right font-mono text-xs text-zinc-900 tabular-nums dark:text-zinc-100">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function OverviewPage() {
  const { snapshot, unavailable } = useLiveTelemetry({ refreshMs: REFRESH_MS });
  // Background scheduler state — tells us whether collection is still happening
  // (and how recently) independently of this tab's own polling.
  const monitoring = useMonitoringStatus();
  const freshness = monitoring?.freshness ?? null;

  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "idle" | "error">("loading");

  // Active-alert summary for the header indicator. Fetched once on mount (like
  // the 24h summary), independent of the live poll.
  const [alertCounts, setAlertCounts] = useState<{ active: number; critical: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/alerts?status=active", { cache: "no-store" });
        if (!cancelled && res.ok) {
          const d = (await res.json()) as { counts: { active: number; critical: number } };
          setAlertCounts(d.counts);
        }
      } catch {
        // Non-fatal: the indicator simply stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);


  // 24h historical summary. Fetched once on mount and independent of the live
  // poll: if it fails, live metrics above keep working.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/telemetry/summary", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          setSummary((await res.json()) as HistorySummary);
          setSummaryState("idle");
        } else if (!cancelled) {
          setSummaryState("error");
        }
      } catch {
        if (!cancelled) setSummaryState("error");
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sys = snapshot?.system ?? null;
  const net = snapshot?.network ?? null;

  const cpuPct = sys?.cpuUsagePct ?? null;
  const totalMem = sys?.totalMem ?? null;
  const usedMem = sys?.usedMem ?? null;
  const availMem = sys?.availMem ?? null;
  const memPct =
    totalMem != null && usedMem != null && totalMem > 0 ? (usedMem / totalMem) * 100 : null;

  // Deterministic local status. Unavailable when live telemetry failed;
  // otherwise Warning on high CPU or memory, else Healthy.
  const up = !unavailable && snapshot != null;
  const status: { label: string; tone: Tone } = !up
    ? { label: "Unavailable", tone: "critical" }
    : (cpuPct != null && cpuPct >= WARN_PCT) || (memPct != null && memPct >= WARN_PCT)
      ? { label: "Warning", tone: "warn" }
      : { label: "Healthy", tone: "good" };

  // Physical (non-virtual) link names for the network panel.
  const physicalLinks = (net?.interfaces ?? [])
    .map((i) => i.name)
    .filter((n) => !/Virtual|Loopback|vEthernet|isatap|VMware|docker|Tailscale/i.test(n));

  const memPctTone: Tone = memPct != null && memPct >= WARN_PCT ? "warn" : "good";
  const cpuTone: Tone = cpuPct != null && cpuPct >= WARN_PCT ? "warn" : "good";

  const osSummary = sys ? `${sys.osType} · ${sys.platform} (${sys.osRelease})` : null;

  const sysRows = sys
    ? [
        { label: "Hostname", value: sys.hostname },
        { label: "OS", value: `${sys.osType} (${sys.osRelease})` },
        { label: "Architecture", value: sys.arch },
        { label: "CPU model", value: sys.cpuModel ?? "–" },
        { label: "Logical cores", value: String(sys.cores) },
        { label: "Uptime", value: fmtUptime(sys.uptimeSec) },
        { label: "Total memory", value: fmtBytes(totalMem) },
        { label: "Used memory", value: fmtBytes(usedMem) },
        { label: "Available memory", value: fmtBytes(availMem) },
      ]
    : [];

  const netRows = net
    ? [
        { label: "Receive rate", value: fmtRate(net.rxRate) },
        { label: "Transmit rate", value: fmtRate(net.txRate) },
        { label: "Total received", value: fmtBytes(net.rxTotal) },
        { label: "Total transmitted", value: fmtBytes(net.txTotal) },
        {
          label: "Active links",
          value: physicalLinks.length ? physicalLinks.join(", ") : "n/a",
        },
      ]
    : [];

  const memFoot =
    totalMem != null
      ? `${fmtPct(memPct)} of ${fmtBytes(totalMem)} in use`
      : "no data";

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header / status */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              DevPulse Overview
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 text-xs ${toneText[status.tone]}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${toneDot[status.tone]}`} aria-hidden="true" />
              {status.label}
            </span>
            {alertCounts && alertCounts.active > 0 && (
              <Link
                href="/alerts"
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                {alertCounts.active} active
                {alertCounts.critical > 0 && (
                  <span className="font-semibold">{alertCounts.critical} critical</span>
                )}
              </Link>
            )}
          </div>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            {up ? (
              <>
                {sys?.hostname ?? "this machine"}
                {osSummary ? ` — ${osSummary}` : ""}
              </>
            ) : (
              "Live telemetry is currently unavailable."
            )}
          </p>
          {/* Background monitoring freshness: collection continues while this
              tab is closed, so staleness is worth surfacing. */}
          {freshness && (
            <p
              className={`mt-1 text-xs ${
                freshness.state === "active"
                  ? "text-zinc-400 dark:text-zinc-500"
                  : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {freshness.state === "active"
                ? `Monitoring active · last sample ${fmtAge(freshness.ageMs)}`
                : freshness.state === "starting"
                  ? "Monitoring starting…"
                  : "Monitoring stale"}
            </p>
          )}
        </div>
        {snapshot && (
          <p className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            Updated {new Date(snapshot.collectedAt).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* Primary metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="CPU usage" value={fmtPct(cpuPct)} dot={cpuTone} foot={sys ? `${sys.cores} logical cores` : undefined} />
        <StatTile label="Memory usage" value={fmtBytes(usedMem)} dot={memPctTone} foot={memFoot} />
        <StatTile label="Receive rate" value={fmtRate(net?.rxRate ?? null)} />
        <StatTile label="Transmit rate" value={fmtRate(net?.txRate ?? null)} />
      </div>

      {/* System + network detail */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DetailPanel title="System" rows={sysRows.length ? sysRows : [{ label: "System info", value: "Unavailable" }]} />
        <DetailPanel title="Network" rows={netRows.length ? netRows : [{ label: "Network info", value: "Unavailable" }]} />
      </div>

      {/* Last 24 hours */}
      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
        <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Last 24 hours</p>
        </div>
        <div className="p-4">
          {summaryState === "loading" ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-600">Loading history…</p>
          ) : summaryState === "error" ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-600">
              History is unavailable. Live metrics above continue to update.
            </p>
          ) : summary && summary.points === 0 ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-600">
              No history recorded in the last 24 hours. Telemetry is saved while DevPulse runs.
            </p>
          ) : summary ? (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <StatTile label="Avg CPU" value={fmtPct(summary.cpu.avg)} unit="" foot="24h average" />
                <StatTile label="Peak CPU" value={fmtPct(summary.cpu.peak)} unit="" foot="24h peak" />
                <StatTile label="Avg memory in use" value={fmtBytes(summary.usedMem.avg)} foot="24h average" />
                <StatTile label="Peak memory in use" value={fmtBytes(summary.usedMem.peak)} foot="24h peak" />
                <StatTile label="Peak receive rate" value={fmtRate(summary.rxRate)} foot="24h peak" />
                <StatTile label="Peak transmit rate" value={fmtRate(summary.txRate)} foot="24h peak" />
              </div>
              {summary.points < LIMITED_POINTS && (
                <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-600">
                  Limited history — DevPulse has only been collecting for a short time ({summary.points}{" "}
                  {summary.points === 1 ? "sample" : "samples"}).
                </p>
              )}
            </>
          ) : null}
        </div>
      </section>

      {/* Intelligence (DeepSeek operational brief — only runs on demand) */}
      <IntelligencePanel />
    </div>
  );
}
