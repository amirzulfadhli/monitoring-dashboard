"use client";

import { useEffect, useState } from "react";
import type { AlertCounts, AlertRecord } from "@/lib/alerts/model";
import {
  EmptyState,
  PageHeader,
  StatTile,
  StatusLabel,
  btnSmall,
  cellMonoCls,
  cellMutedCls,
  footnoteCls,
  labelCls,
  mutedCls,
  pageCls,
  severityTone,
  tabCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  theadRowCls,
  toneText,
  trCls,
  type Tone,
} from "@/components/ui";

// Poll ~30s to match the engine's guarded evaluation cadence; each request
// evaluates at most once per interval and otherwise serves stored state.
const REFRESH_MS = 30_000;

type View = "active" | "history";

const sourceLabel: Record<string, string> = {
  system: "System",
  websites: "Websites",
  apis: "APIs",
  github: "GitHub",
  ai: "AI",
};

type Api = { status: View; counts: AlertCounts; alerts: AlertRecord[] };

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
    body = <EmptyState message="Alerts are temporarily unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Loading alerts…" />;
  } else {
    const alerts = data.alerts;
    body = (
      <div className="space-y-4">
        {counts && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatTile label="Active" value={String(counts.active)} />
            <StatTile label="Critical" value={String(counts.critical)} tone="critical" />
            <StatTile label="Warning" value={String(counts.warning)} tone="warn" />
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
                aria-pressed={on}
                className={tabCls(on)}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {alerts.length === 0 ? (
          <EmptyState
            message={
              view === "active"
                ? "No active alerts. Everything is within thresholds."
                : "No recently resolved alerts."
            }
          />
        ) : (
          <div className={tableWrapCls}>
            <table className={`${tableCls} min-w-[760px]`}>
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>Severity</th>
                  <th className={thCls}>Source</th>
                  <th className={thCls}>Alert</th>
                  <th className={thCls}>Message</th>
                  <th className={thCls}>First seen</th>
                  <th className={thCls}>
                    {view === "history" ? "Resolved" : "Last seen"}
                  </th>
                  <th className={thCls} aria-label="Explain" />
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <ExplainRow key={a.fingerprint} a={a} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className={footnoteCls}>
          Alerts are derived deterministically from DevPulse&apos;s own monitoring signals and
          evaluated on a modest cadence — no external notifications are sent.
        </p>
      </div>
    );
  }

  return (
    <div className={pageCls}>
      <PageHeader
        title="Alerts"
        description="Thresholds applied to live monitoring signals — CPU, memory, websites, GitHub CI and AI usage."
      />
      {body}
    </div>
  );
}

/** Typed shapes for the /api/alerts/[id]/explain response. */
type ExplainRef = { eventId: string; relevance: string };
type ExplainPanel = {
  summary: string;
  likelyCause: string | null;
  confidence: "low" | "medium" | "high";
  evidence: ExplainRef[];
  checks: string[];
};
type ExplainOk = {
  ok: true;
  cached: boolean;
  createdAt: number;
  evidenceCount: number;
  explanation: ExplainPanel;
  model: string | null;
};
type ExplainErr = { ok: false; reason: string; message: string };

const confTone: Record<ExplainPanel["confidence"], Tone> = {
  low: "neutral",
  medium: "warn",
  high: "good",
};

function ExplainRow({ a }: { a: AlertRecord }) {
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<ExplainPanel | null>(null);
  const [meta, setMeta] = useState<{ createdAt: number; cached: boolean; model: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const explain = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/alerts/${encodeURIComponent(a.fingerprint)}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // ignored by the server — the action is fixed
        cache: "no-store",
      });
      const data = (await res.json()) as ExplainOk | ExplainErr;
      if (data.ok) {
        setPanel(data.explanation);
        setMeta({
          createdAt: data.createdAt,
          cached: data.cached,
          model: data.model,
        });
      } else {
        setError(data.message);
        setPanel(null);
        setMeta(null);
      }
    } catch {
      setError("Explanation request failed. The alert remains visible.");
      setPanel(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className={trCls}>
        <td className={tdCls}>
          <StatusLabel tone={severityTone[a.severity]} className="text-xs capitalize">
            {a.severity}
          </StatusLabel>
        </td>
        <td className={`${tdCls} ${cellMutedCls} capitalize`}>
          {sourceLabel[a.source] ?? a.source}
        </td>
        <td className={`${tdCls} font-medium text-zinc-900 dark:text-zinc-50`}>{a.title}</td>
        <td className={`max-w-[320px] truncate ${tdCls} ${cellMutedCls}`} title={a.message}>
          {a.message}
        </td>
        <td className={`${tdCls} ${cellMonoCls}`}>{fmtWhen(a.firstSeenAt)}</td>
        <td className={`${tdCls} ${cellMonoCls}`}>
          {a.resolvedAt != null ? fmtWhen(a.resolvedAt) : fmtWhen(a.lastSeenAt)}
        </td>
        <td className={`${tdCls} text-right`}>
          <button onClick={explain} disabled={busy} className={btnSmall}>
            {busy ? "Explaining…" : "Explain"}
          </button>
        </td>
      </tr>
      {(panel || error || busy) && (
        <tr className="border-b border-zinc-100 bg-zinc-50/50 last:border-0 dark:border-zinc-900 dark:bg-zinc-900/30">
          <td colSpan={7} className={`${tdCls} text-xs text-zinc-500 dark:text-zinc-400`} aria-live="polite">
            {busy && !panel ? (
              <p className={footnoteCls}>Analyzing nearby DevPulse evidence…</p>
            ) : panel ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className={labelCls}>AI-generated · grounded in DevPulse evidence</p>
                  {meta && (
                    <p className={footnoteCls}>
                      {fmtWhen(meta.createdAt)}
                      {meta.cached ? " · cached" : ""}
                      {meta.model ? ` · ${meta.model}` : ""}
                    </p>
                  )}
                </div>
                <p className={mutedCls}>
                  <span className={`font-semibold capitalize ${toneText[confTone[panel.confidence]]}`}>
                    {panel.confidence} confidence
                  </span>{" "}
                  — {panel.summary}
                </p>
                {panel.likelyCause && (
                  <p className="text-xs text-zinc-700 dark:text-zinc-300">
                    <span className="font-medium">Likely cause: </span>
                    {panel.likelyCause}
                  </p>
                )}
                {panel.evidence.length > 0 && (
                  <div>
                    <p className={`mb-1 ${labelCls}`}>Supporting evidence</p>
                    <ul className="space-y-1">
                      {panel.evidence.map((e, i) => (
                        <li key={i} className={mutedCls}>
                          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                            {e.eventId}
                          </span>{" "}
                          — {e.relevance}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {panel.checks.length > 0 && (
                  <div>
                    <p className={`mb-1 ${labelCls}`}>Recommended checks</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
                      {panel.checks.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
