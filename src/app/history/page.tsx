"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  HistoryRangeKey,
  HistorySourceKey,
  TimelineEvent,
  TimelineSource,
} from "@/lib/history/model";
import {
  EmptyState,
  PageHeader,
  StatusDot,
  footnoteCls,
  labelCls,
  pageCls,
  selectCls,
  severityTone,
  tabCls,
} from "@/components/ui";

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
  { key: "api", label: "APIs" },
  { key: "device", label: "Devices" },
  { key: "github", label: "GitHub" },
  { key: "ai", label: "AI" },
  { key: "security", label: "Security" },
  { key: "storage", label: "Storage" },
  { key: "alert", label: "Alerts" },
];

const sourceLabel: Record<TimelineSource, string> = {
  system: "System",
  network: "System",
  website: "Websites",
  api: "APIs",
  device: "Devices",
  github: "GitHub",
  ai: "AI",
  security: "Security",
  storage: "Storage",
  alert: "Alert",
};

type Api = { range: string; count: number; events: TimelineEvent[] };

type ProjectOption = { id: string; name: string };

/**
 * Project filter. Events are labelled server-side with the project their source
 * belongs to *now* — DevPulse stores no historical membership, so this filter
 * answers "events from sources grouped here today", not "events that were in
 * this project at the time". Sources that belong to no project carry no
 * projectId and are only visible under "All projects".
 */
function projectIdOf(e: TimelineEvent): string | null {
  const v = e.metadata?.projectId;
  return typeof v === "string" ? v : null;
}

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
  const [project, setProject] = useState<string>("all");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  // The project list is configuration and changes rarely, so it is read once —
  // not on every timeline refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { projects: ProjectOption[] };
        if (!cancelled) setProjects(d.projects ?? []);
      } catch {
        /* no project filter — the timeline itself is unaffected */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    const bySource = filter === "all" ? base : base.filter((e) => matches(e.source, filter));
    if (project === "all") return bySource;
    return bySource.filter((e) => projectIdOf(e) === project);
  }, [data, filter, project]);

  let body: React.ReactNode;
  if (state === "error" && !data) {
    body = <EmptyState message="History is temporarily unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Loading history…" />;
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        message={
          project !== "all"
            ? "No events in this window for sources grouped in this project."
            : filter === "all"
              ? "No events in this window yet."
              : "No events for this source in the window."
        }
      />
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
    <div className={pageCls}>
      <PageHeader
        title="History"
        description="Chronological events from monitored sources — websites, API endpoints, GitHub, AI usage, alerts and system telemetry."
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">{SOURCE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={tabCls(filter === t.key)}
            aria-pressed={filter === t.key}
          >
            {t.label}
          </button>
        ))}</div>
        <div className="flex items-center gap-2">
          {projects.length > 0 && (
            <>
              <label htmlFor="history-project" className="sr-only">
                Filter by project
              </label>
              <select
                id="history-project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className={selectCls}
              >
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="flex items-center gap-1">{RANGE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setRange(t.key)}
            className={tabCls(range === t.key)}
            aria-pressed={range === t.key}
          >
            {t.label}
          </button>
          ))}</div>
        </div>
      </div>

      {data && state === "ok" && (
        <p className={`-mt-3 ${footnoteCls}`}>
          {data.count} event{data.count === 1 ? "" : "s"} across all sources · showing{" "}
          {visible.length} in this view
          {project !== "all" && (
            <>
              {" · "}
              <span title="DevPulse stores the source's current project, not its project at the time of the event.">
                filtered by current project membership
              </span>
            </>
          )}
        </p>
      )}

      {body}
    </div>
  );
}

function TimelineRow({ e }: { e: TimelineEvent }) {
  return (
    <li className="flex gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-900">
      <div className="flex w-4 shrink-0 justify-center pt-1.5">
        <StatusDot tone={e.severity ? severityTone[e.severity] : "neutral"} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`${labelCls} font-medium`}>
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
