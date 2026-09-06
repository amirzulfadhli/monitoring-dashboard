"use client";

import { useEffect, useState } from "react";
import type { AlertCounts, AlertRecord, Severity } from "@/lib/alerts/model";

// Poll ~30s to match the engine's guarded evaluation cadence; each request
// evaluates at most once per interval and otherwise serves stored state.
const REFRESH_MS = 30_000;

type View = "active" | "history";

const sevDot: Record<Severity, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};
const sevText: Record<Severity, string> = {
  critical: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-sky-600 dark:text-sky-400",
};

const sourceLabel: Record<string, string> = {
  system: "System",
  websites: "Websites",
  github: "GitHub",
  ai: "AI",
};

type Api = { status: View; counts: AlertCounts; alerts: AlertRecord[] };

function StatTile({
  label,
  value,
  dot,
}: {
  label: string;
  value: string;
  dot?: Severity;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-3 flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {dot && <span className={`h-2 w-2 rounded-full ${sevDot[dot]}`} aria-hidden="true" />}
        {value}
      </p>
    </div>
  );
}

function fmtWhen(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AlertsPage() {
  const [view, setView] = useState<View>("active");
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/alerts?status=${view}`, { cache: "no-store" });
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
  }, [view]);

  const counts = data?.counts;

  let body: React.ReactNode;
  if (state === "error" && !data) {
    body = (
      <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
        Alerts are temporarily unavailable.
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
        Loading alerts…
      </div>
    );
  } else {
    const alerts = data.alerts;
    body = (
      <div className="space-y-4">
        {counts && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatTile label="Active" value={String(counts.active)} />
            <StatTile label="Critical" value={String(counts.critical)} dot="critical" />
            <StatTile label="Warning" value={String(counts.warning)} dot="warning" />
            <StatTile label="Resolved recent" value={String(counts.resolvedRecent)} />
          </div>
        )}

        <div className="flex items-center gap-1">
          {(
            [
              { key: "active", label: "Active" },
              { key: "history", label: "History" },
            ] as { key: View; label: string }[]
          ).map((t) => {
            const on = view === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  on
                    ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {alerts.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
            {view === "active"
              ? "No active alerts. Everything is within thresholds."
              : "No recently resolved alerts."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Severity</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                  <th className="px-4 py-2.5 font-medium">Alert</th>
                  <th className="px-4 py-2.5 font-medium">Message</th>
                  <th className="px-4 py-2.5 font-medium">First seen</th>
                  <th className="px-4 py-2.5 font-medium">
                    {view === "history" ? "Resolved" : "Last seen"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <Row key={a.fingerprint} a={a} view={view} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Alerts are derived deterministically from DevPulse&apos;s own monitoring signals and
          evaluated on a modest cadence — no external notifications are sent.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Alerts
        </h1>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          Thresholds applied to live monitoring signals — CPU, memory, websites, GitHub CI and AI
          usage.
        </p>
      </div>
      {body}
    </div>
  );
}

function Row({ a, view }: { a: AlertRecord; view: View }) {
  const label = a.severity;
  return (
    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 capitalize text-xs ${sevText[label]}`}>
          <span className={`h-2 w-2 rounded-full ${sevDot[label]}`} aria-hidden="true" />
          {label}
        </span>
      </td>
      <td className="px-4 py-3 text-xs capitalize text-zinc-500 dark:text-zinc-400">
        {sourceLabel[a.source] ?? a.source}
      </td>
      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">{a.title}</td>
      <td className="max-w-[320px] truncate px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400" title={a.message}>
        {a.message}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-zinc-400 dark:text-zinc-500">
        {fmtWhen(a.firstSeenAt)}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-zinc-400 dark:text-zinc-500">
        {view === "history" && a.resolvedAt != null ? fmtWhen(a.resolvedAt) : fmtWhen(a.lastSeenAt)}
      </td>
    </tr>
  );
}
