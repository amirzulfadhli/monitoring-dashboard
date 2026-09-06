"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  HistoryRangeKey,
  HistorySourceKey,
  TimelineEvent,
  TimelineSource,
} from "@/lib/history/model";

const REFRESH_MS = 30_000;

const RANGE_TABS: { key: HistoryRangeKey; label: string }[] = [
  { key: "24H", label: "24H" },
  { key: "7D", label: "7D" },
  { key: "30D", label: "30D" },
];

// The System filter groups system + network summaries under one label.
const SOURCE_TABS: { key: HistorySourceKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "system", label: "System" },
  { key: "website", label: "Websites" },
  { key: "github", label: "GitHub" },
  { key: "ai", label: "AI" },
  { key: "alert", label: "Alerts" },
];

const sourceLabel: Record<TimelineSource, string> = {
  system: "System",
  network: "System",
  website: "Websites",
  github: "GitHub",
  ai: "AI",
  alert: "Alert",
};

const sourceChip: Record<string, string> = {
  system: "text-zinc-500 dark:text-zinc-400",
  network: "text-zinc-500 dark:text-zinc-400",
  website: "text-sky-600 dark:text-sky-400",
  github: "text-violet-600 dark:text-violet-400",
  ai: "text-amber-600 dark:text-amber-400",
  alert: "text-red-600 dark:text-red-400",
};

const sevDot: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

type Api = { range: string; count: number; events: TimelineEvent[] };

function matches(source: TimelineSource, filter: HistorySourceKey): boolean {
  if (filter === "all") return true;
  if (filter === "system") return source === "system" || source === "network";
  return source === filter;
}

function fmtWhen(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HistoryPage() {
  const [range, setRange] = useState<HistoryRangeKey>("24H");
  const [filter, setFilter] = useState<HistorySourceKey>("all");
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/history?range=${range}`, { cache: "no-store" });
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
  }, [range]);

  // Client-side filtering: the server already bounds the payload per range, so
  // re-filtering here avoids a second round-trip per source tab.
  const visible = useMemo(() => {
    const base = data?.events ?? [];
    if (filter === "all") return base;
    return base.filter((e) => matches(e.source, filter));
  }, [data, filter]);

  const tabClass = (on: boolean) =>
    `rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
      on
        ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
        : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
    }`;

  let body: React.ReactNode;
  if (state === "error" && !data) {
    body = (
      <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
        History is temporarily unavailable.
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
        Loading history…
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className="flex h-32 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
        {filter === "all"
          ? "No events in this window yet."
          : "No events for this source in the window."}
      </div>
    );
  } else {
    body = (
      <ol className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
        {visible.map((e) => (
          <TimelineRow key={e.id} e={e} />
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          History
        </h1>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          Chronological events from monitored sources — websites, GitHub, AI usage, alerts and
          system telemetry.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">{SOURCE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={tabClass(filter === t.key)}
            aria-pressed={filter === t.key}
          >
            {t.label}
          </button>
        ))}</div>
        <div className="flex items-center gap-1">{RANGE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setRange(t.key)}
            className={tabClass(range === t.key)}
            aria-pressed={range === t.key}
          >
            {t.label}
          </button>
        ))}</div>
      </div>

      {data && state === "ok" && (
        <p className="-mt-3 text-xs text-zinc-400 dark:text-zinc-500">
          {data.count} event{data.count === 1 ? "" : "s"} across all sources · showing{" "}
          {visible.length} in this view
        </p>
      )}

      {body}
    </div>
  );
}

function TimelineRow({ e }: { e: TimelineEvent }) {
  const dot = e.severity ? sevDot[e.severity] : "bg-zinc-300 dark:bg-zinc-600";
  return (
    <li className="flex gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-900">
      <div className="flex w-4 shrink-0 justify-center pt-1.5">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className={`text-[11px] font-medium uppercase tracking-wider ${sourceChip[e.source] ?? ""}`}
          >
            {sourceLabel[e.source] ?? e.source}
          </span>
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {e.title}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400" title={e.description}>
          {e.description}
        </p>
      </div>
      <div className="shrink-0 pt-1 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
        {fmtWhen(e.ts)}
      </div>
    </li>
  );
}
