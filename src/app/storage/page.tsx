"use client";

import { useEffect, useState } from "react";
import type { StorageView, StorageVolumeView } from "@/app/api/storage/route";
import type { DiskState } from "@/lib/disks/model";

// The scheduler owns the collection cadence (~5m); this only controls how often
// the page re-reads the collected state.
const REFRESH_MS = 30_000;

type Tone = "good" | "warn" | "critical" | "muted";

const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
  muted: "bg-zinc-300 dark:bg-zinc-600",
};

const stateTone: Record<DiskState, Tone> = {
  normal: "good",
  warning: "warn",
  critical: "critical",
};

const stateLabel: Record<DiskState, string> = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
};

// A bar is only coloured when the band means something; a healthy volume stays
// neutral rather than being decorated.
const barFill: Record<DiskState, string> = {
  normal: "bg-zinc-400 dark:bg-zinc-500",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

/** Pretty-print a byte count, e.g. 1.4 GB. */
function fmtBytes(bytes: number | null): string {
  if (bytes == null) return "–";
  const b = Math.max(0, bytes);
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e3).toFixed(1)} KB`;
}

function fmtAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A compact utilization bar; the numeric value is always shown beside it. */
function UsageBar({ pct, state }: { pct: number; state: DiskState }) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div
      className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
      role="img"
      aria-label={`${pct.toFixed(1)}% used`}
    >
      <div className={`h-full rounded-full ${barFill[state]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export default function StoragePage() {
  const [data, setData] = useState<StorageView | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/storage", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as StorageView;
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
    body = <Empty message="Storage monitoring is unavailable." />;
  } else if (!data) {
    body = <Empty message="Reading local storage state…" />;
  } else if (!data.supported) {
    body = (
      <Empty
        message={`Local storage monitoring is Windows-only — this host reports platform "${data.platform}".`}
      />
    );
  } else if (data.volumes.length === 0) {
    body = (
      <Empty message={data.reason ?? "No local volume has been observed yet."} />
    );
  } else {
    body = <StorageBody data={data} />;
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Storage
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Local fixed volume capacity for this machine.
          </p>
        </div>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
          {data?.lastCheckedAt ? `Checked ${fmtAgo(data.lastCheckedAt)}` : "No observation yet"}
        </span>
      </div>
      {body}
    </div>
  );
}

function StorageBody({ data }: { data: StorageView }) {
  const { volumes, totals, thresholds } = data;
  const worst = volumes.reduce<StorageVolumeView | null>(
    (best, v) => (best == null || v.usagePct > best.usagePct ? v : best),
    null,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-black">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${toneDot[worst ? stateTone[worst.state] : "muted"]}`}
          aria-hidden="true"
        />
        <span className="text-sm text-zinc-700 dark:text-zinc-200">
          {totals
            ? `${totals.volumes} volume${totals.volumes === 1 ? "" : "s"} · ${fmtBytes(totals.freeBytes)} free of ${fmtBytes(totals.totalBytes)}`
            : "No volume observed"}
        </span>
        <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
          Warning ≥ {thresholds.warningPct}% · Critical ≥ {thresholds.criticalPct}%
        </span>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
        <div className="border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/60">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Volumes</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="px-4 py-2 font-medium">Volume</th>
                <th className="px-4 py-2 font-medium">Filesystem</th>
                <th className="px-4 py-2 font-medium">Used / total</th>
                <th className="px-4 py-2 font-medium">Free</th>
                <th className="px-4 py-2 font-medium">Usage</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Checked</th>
              </tr>
            </thead>
            <tbody>
              {volumes.map((v) => (
                <tr
                  key={v.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                >
                  <td className="px-4 py-2 font-mono text-xs text-zinc-800 dark:text-zinc-100">
                    {v.id}
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {v.filesystem ?? "–"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {fmtBytes(v.usedBytes)} / {fmtBytes(v.totalBytes)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {fmtBytes(v.freeBytes)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <UsageBar pct={v.usagePct} state={v.state} />
                      <span className="font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-200">
                        {v.usagePct.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-200">
                      <span
                        className={`h-2 w-2 rounded-full ${toneDot[stateTone[v.state]]}`}
                        aria-hidden="true"
                      />
                      {stateLabel[v.state]}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500"
                    title={data.lastCheckedAt ? fmtTime(data.lastCheckedAt) : undefined}
                  >
                    {data.lastCheckedAt ? fmtAgo(data.lastCheckedAt) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Read-only capacity queries for locally attached fixed volumes. DevPulse never enumerates
        files or folders, measures directory sizes, reads file names, runs SMART diagnostics or
        modifies a disk — a nearly-full volume is reported as a condition, not as a failure.
      </p>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 text-center text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
      {message}
    </div>
  );
}
