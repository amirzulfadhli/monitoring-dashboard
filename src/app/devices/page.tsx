"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DeviceHistory } from "@/app/api/devices/route";
import type { DeviceCheckResult } from "@/lib/devices/model";
import type { CollectorState } from "@/lib/scheduler/health";
import { COLLECTOR_STATE_LABELS } from "@/lib/scheduler/model";

// Refresh cadence. The scheduler owns the actual check cadence (~60s), so this
// only controls how often the page re-reads the collected results.
const REFRESH_MS = 20_000;
// Below this many stored checks the 24h uptime figure is not yet meaningful.
const SPARSE_SAMPLES = 10;

type Tone = "good" | "warn" | "critical" | "muted";

const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
  muted: "bg-zinc-300 dark:bg-zinc-600",
};

/**
 * Collector health, distinct from device health. The collector describes whether
 * DevPulse can perform device monitoring; an unreachable device never makes the
 * collector itself unhealthy.
 */
const collectorTone: Record<CollectorState, Tone> = {
  healthy: "good",
  stale: "warn",
  failing: "critical",
  inactive: "muted",
};

type DevicesResponse = {
  generatedAt: number;
  localMachine: { hostname: string; platform: string };
  results: DeviceCheckResult[];
  counts: { total: number; reachable: number; unreachable: number };
  history: DeviceHistory;
  collector: {
    state: CollectorState;
    cadenceMs: number;
    staleAfterMs: number;
    inactiveReason: string | null;
    lastSuccessAt: number | null;
    lastError: string | null;
  };
};

function fmtMs(ms: number | null) {
  if (ms === null || !isFinite(ms)) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtAgo(ts: number | null) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function StatTile({ label, value, dot }: { label: string; value: string; dot?: Tone }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-3 flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {dot && <span className={`h-2 w-2 rounded-full ${toneDot[dot]}`} aria-hidden="true" />}
        {value}
      </p>
    </div>
  );
}

export default function DevicesPage() {
  const [data, setData] = useState<DevicesResponse | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/devices", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as DevicesResponse;
          if (!cancelled) {
            setData(d);
            setState("ok");
          }
        } else if (!cancelled) {
          setState("error");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  let body: React.ReactNode;
  if (!data && state === "error") {
    body = <Empty message="Device monitoring is unavailable." />;
  } else if (!data) {
    body = <Empty message="Checking devices…" />;
  } else {
    const { collector } = data;
    body = (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Devices" value={String(data.counts.total)} />
          <StatTile label="Reachable" value={String(data.counts.reachable)} dot="good" />
          <StatTile label="Unreachable" value={String(data.counts.unreachable)} dot="critical" />
          <StatTile
            label="Collector"
            value={COLLECTOR_STATE_LABELS[collector.state]}
            dot={collectorTone[collector.state]}
          />
        </div>

        {/* The local machine is named here but its CPU / memory / network data
            stays in the telemetry system — nothing is duplicated into device
            monitoring. */}
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-black">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                This machine
              </p>
              <p className="mt-1 font-mono text-sm text-zinc-900 dark:text-zinc-50">
                {data.localMachine.hostname}
              </p>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              CPU, memory and network for this host come from{" "}
              <Link href="/" className="underline decoration-zinc-300 underline-offset-2 dark:decoration-zinc-700">
                telemetry
              </Link>{" "}
              and{" "}
              <Link href="/network" className="underline decoration-zinc-300 underline-offset-2 dark:decoration-zinc-700">
                Network
              </Link>
              .
            </p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="px-4 py-2.5 font-medium">Device</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Host</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Latency</th>
                <th className="px-4 py-2.5 font-medium">Last checked</th>
                <th className="px-4 py-2.5 font-medium">24h uptime</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((r) => {
                const h = data.history[r.device.id];
                const sparse = !!h && h.samples < SPARSE_SAMPLES;
                const uptime =
                  h?.uptimePct === null
                    ? "–"
                    : h?.uptimePct === undefined
                      ? "n/a"
                      : `${h.uptimePct}%`;
                return (
                  <tr
                    key={r.device.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                      {r.device.name}
                    </td>
                    <td className="px-4 py-3 text-xs capitalize text-zinc-500 dark:text-zinc-400">
                      {r.device.type}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {r.device.host}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-200">
                        <span
                          className={`h-2 w-2 rounded-full ${r.reachable ? toneDot.good : toneDot.critical}`}
                          aria-hidden="true"
                        />
                        {r.reachable ? "reachable" : "unreachable"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {fmtMs(r.latencyMs)}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-400 dark:text-zinc-500">
                      <span className="tabular-nums">{fmtAgo(r.checkedAt)}</span>
                      {r.error && (
                        <p className="mt-0.5 max-w-[220px] truncate text-[11px] text-red-500/80">
                          {r.error}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                        {uptime}
                      </span>
                      {sparse && (
                        <span className="ml-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                          ·{h.samples} check{h.samples === 1 ? "" : "s"}
                        </span>
                      )}
                      {h?.avgLatencyMs != null && (
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          avg {fmtMs(h.avgLatencyMs)}
                        </p>
                      )}
                      {h?.latestFailureAt != null && (
                        <p className="text-[11px] text-red-500/80">
                          last fail {new Date(h.latestFailureAt).toLocaleTimeString()}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {collector.state === "inactive" && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {collector.inactiveReason ?? "Device monitoring is not collecting."}
          </p>
        )}
        {collector.lastError && (
          <p className="text-xs text-red-500/80">
            Collector error: {collector.lastError}
          </p>
        )}

        {data.counts.total === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No devices configured. Add them under{" "}
            <Link
              href="/settings"
              className="underline decoration-zinc-300 underline-offset-2 dark:decoration-zinc-700"
            >
              Settings
            </Link>
            .
          </p>
        )}

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Reachability only: one bounded ICMP echo request per device on the scheduler cadence (
          {Math.round(collector.cadenceMs / 1000)}s). DevPulse never authenticates to a device, runs
          anything on it, scans an address range or probes a port. Uptime reflects only observed
          checks.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Devices
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Reachability for configured machines.
          </p>
        </div>
        {data && (
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            Updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      {body}
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
      {message}
    </div>
  );
}
