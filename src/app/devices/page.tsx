"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DeviceHistory } from "@/app/api/devices/route";
import type { DeviceCheckResult } from "@/lib/devices/model";
import type { CollectorState } from "@/lib/scheduler/health";
import { COLLECTOR_STATE_LABELS } from "@/lib/scheduler/model";
import {
  EmptyState,
  PageHeader,
  StatTile,
  StatusLabel,
  cellMonoCls,
  cellMutedCls,
  footnoteCls,
  labelCls,
  metaCls,
  mutedCls,
  pageCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  theadRowCls,
  trCls,
  type Tone,
} from "@/components/ui";

// Refresh cadence. The scheduler owns the actual check cadence (~60s), so this
// only controls how often the page re-reads the collected results.
const REFRESH_MS = 20_000;
// Below this many stored checks the 24h uptime figure is not yet meaningful.
const SPARSE_SAMPLES = 10;

/**
 * Collector health, distinct from device health. The collector describes whether
 * DevPulse can perform device monitoring; an unreachable device never makes the
 * collector itself unhealthy.
 */
const collectorTone: Record<CollectorState, Tone> = {
  healthy: "good",
  stale: "warn",
  failing: "critical",
  inactive: "neutral",
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
    body = <EmptyState message="Device monitoring is unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Checking devices…" />;
  } else {
    const { collector } = data;
    body = (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Devices" value={String(data.counts.total)} />
          <StatTile label="Reachable" value={String(data.counts.reachable)} tone="good" />
          <StatTile label="Unreachable" value={String(data.counts.unreachable)} tone="critical" />
          <StatTile
            label="Collector"
            value={COLLECTOR_STATE_LABELS[collector.state]}
            tone={collectorTone[collector.state]}
          />
        </div>

        {/* The local machine is named here but its CPU / memory / network data
            stays in the telemetry system — nothing is duplicated into device
            monitoring. */}
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-black">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className={labelCls}>This machine</p>
              <p className="mt-1 font-mono text-sm text-zinc-900 dark:text-zinc-50">
                {data.localMachine.hostname}
              </p>
            </div>
            <p className={footnoteCls}>
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

        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>Device</th>
                <th className={thCls}>Type</th>
                <th className={thCls}>Host</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Latency</th>
                <th className={thCls}>Last checked</th>
                <th className={thCls}>24h uptime</th>
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
                  <tr key={r.device.id} className={trCls}>
                    <td className={`${tdCls} font-medium text-zinc-900 dark:text-zinc-50`}>
                      {r.device.name}
                    </td>
                    <td className={`${tdCls} ${cellMutedCls} capitalize`}>{r.device.type}</td>
                    <td className={`${tdCls} ${cellMonoCls}`}>{r.device.host}</td>
                    <td className={tdCls}>
                      <StatusLabel tone={r.reachable ? "good" : "critical"}>
                        {r.reachable ? "reachable" : "unreachable"}
                      </StatusLabel>
                    </td>
                    <td className={`${tdCls} ${cellMonoCls}`}>{fmtMs(r.latencyMs)}</td>
                    <td className={`${tdCls} ${cellMutedCls}`}>
                      <span className="tabular-nums">{fmtAgo(r.checkedAt)}</span>
                      {r.error && (
                        <p className="mt-0.5 max-w-[220px] truncate text-[11px] text-red-500/80">
                          {r.error}
                        </p>
                      )}
                    </td>
                    <td className={tdCls}>
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
          <p className={mutedCls}>
            {collector.inactiveReason ?? "Device monitoring is not collecting."}
          </p>
        )}
        {collector.lastError && (
          <p className="text-xs text-red-500/80">
            Collector error: {collector.lastError}
          </p>
        )}

        {data.counts.total === 0 && (
          <p className={mutedCls}>
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

        <p className={footnoteCls}>
          Reachability only: one bounded ICMP echo request per device on the scheduler cadence (
          {Math.round(collector.cadenceMs / 1000)}s). DevPulse never authenticates to a device, runs
          anything on it, scans an address range or probes a port. Uptime reflects only observed
          checks.
        </p>
      </div>
    );
  }

  return (
    <div className={pageCls}>
      <PageHeader
        title="Devices"
        description="Reachability for configured machines."
        meta={
          data ? (
            <span className={metaCls}>
              Updated {new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          ) : null
        }
      />
      {body}
    </div>
  );
}
