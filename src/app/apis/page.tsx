"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ApiHistory } from "@/app/api/apis/route";
import type { ApiCheckResult, ApiState } from "@/lib/monitoring/apis";
import {
  EmptyState,
  PageHeader,
  StatTile,
  StatusLabel,
  cellMonoCls,
  cellMutedCls,
  footnoteCls,
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
// Below this many stored samples the 24h uptime figure is not yet meaningful.
const SPARSE_SAMPLES = 10;

const stateTone: Record<ApiState, Tone> = {
  healthy: "good",
  degraded: "warn",
  down: "critical",
};

type Api = {
  generatedAt: number;
  results: ApiCheckResult[];
  counts: { total: number; healthy: number; degraded: number; down: number };
  history: ApiHistory;
};

function fmtMs(ms: number | null) {
  if (ms === null || !isFinite(ms)) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtTime(ts: number | null) {
  if (!ts) return "–";
  return new Date(ts).toLocaleTimeString();
}

function fmtAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default function ApisPage() {
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/apis", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as Api;
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
    body = <EmptyState message="API monitoring is unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Checking endpoints…" />;
  } else {
    body = (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Endpoints" value={String(data.counts.total)} />
          <StatTile label="Healthy" value={String(data.counts.healthy)} tone="good" />
          <StatTile label="Degraded" value={String(data.counts.degraded)} tone="warn" />
          <StatTile label="Down" value={String(data.counts.down)} tone="critical" />
        </div>

        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[720px]`}>
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>Endpoint</th>
                <th className={thCls}>Method</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Latency</th>
                <th className={thCls}>Checked</th>
                <th className={thCls}>24h uptime</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((r) => {
                const h = data.history[r.api.id];
                const sparse = !!h && h.samples < SPARSE_SAMPLES;
                const uptime =
                  h?.uptimePct === null
                    ? "–"
                    : h?.uptimePct === undefined
                      ? "n/a"
                      : `${h.uptimePct}%`;
                return (
                  <tr key={r.api.id} className={trCls}>
                    <td className={tdCls}>
                      <p className="font-medium text-zinc-900 dark:text-zinc-50">{r.api.name}</p>
                      <p className="max-w-[320px] truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">
                        {r.host ?? r.api.url}
                      </p>
                    </td>
                    <td className={`${tdCls} ${cellMonoCls}`}>{r.api.method}</td>
                    <td className={tdCls}>
                      <StatusLabel tone={stateTone[r.state]} className="capitalize">
                        {r.state}
                      </StatusLabel>
                    </td>
                    <td className={`${tdCls} ${cellMonoCls}`}>{r.httpStatus ?? "–"}</td>
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
                          ·{h.samples} sample{h.samples === 1 ? "" : "s"}
                        </span>
                      )}
                      {h?.avgLatencyMs != null && (
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          avg {fmtMs(h.avgLatencyMs)}
                        </p>
                      )}
                      {h?.latestFailureAt != null && (
                        <p className="text-[11px] text-red-500/80">
                          last fail {fmtTime(h.latestFailureAt)}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.counts.total === 0 && (
          <p className={mutedCls}>
            No API endpoints configured. Add them under{" "}
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
          Endpoints are checked server-side on the scheduler cadence (~60s) with a bounded timeout.
          Only status, latency and a short error are recorded — response bodies are never read or
          stored. Uptime reflects only observed checks.
        </p>
      </div>
    );
  }

  return (
    <div className={pageCls}>
      <PageHeader
        title="APIs"
        description="Availability and latency for configured API endpoints."
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
