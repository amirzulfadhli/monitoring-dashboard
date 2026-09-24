"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EmptyState,
  PageHeader,
  Panel,
  StatusBadge,
  btnPrimary,
  footnoteCls,
  mutedCls,
  narrowPageCls,
} from "@/components/ui";

/**
 * Daily operational brief. A grounded summary of the monitoring evidence
 * DevPulse already stored for one 24-hour period.
 *
 * Nothing runs on load: mounting reads GET /api/brief, which only ever reflects
 * the stored brief and makes no model call. A brief is generated solely by
 * pressing the button, and a brief already stored for the current period is
 * returned as-is — "Regenerate" is the explicit, deliberate way to spend one.
 */

type Evidence = {
  id: string;
  kind: string;
  source: string;
  ts: number | null;
  title: string;
  detail: string;
};

type Record = {
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  windowHours: number;
  summary: string;
  highlights: string[];
  problems: string[];
  recoveries: string[];
  watchNext: string[];
  evidence: Evidence[];
  citedEvidenceIds: string[];
  evidenceCount: number;
  insufficientEvidence: boolean;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
};

type Report = {
  available: boolean;
  windowHours: number;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  latest: Record | null;
  cachedForCurrentPeriod: boolean;
};

type PostResult =
  | { ok: true; computed: boolean; record: Record | null; report: Report }
  | { ok: false; reason: string; message: string; report: Report };

/** The four bounded prose sections, in the order they are rendered. */
const SECTIONS = [
  { key: "highlights", label: "Highlights" },
  { key: "problems", label: "Problems" },
  { key: "recoveries", label: "Recoveries" },
  { key: "watchNext", label: "Watch next" },
] as const;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtPeriod(start: number, end: number): string {
  const day = new Date(start).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const from = new Date(start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const to = new Date(end).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${from}–${to}`;
}

export default function BriefPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/brief", { cache: "no-store" });
        if (!cancelled && res.ok) setReport((await res.json()) as Report);
      } catch {
        // A failed read leaves the empty state rather than inventing a brief.
      } finally {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(
    async (regenerate: boolean) => {
      setRunning(true);
      setError(null);
      try {
        const res = await fetch("/api/brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ regenerate }),
          cache: "no-store",
        });
        const data = (await res.json()) as PostResult;
        if (data.report) setReport(data.report);
        if (!data.ok) setError(data.message);
      } catch {
        setError("The brief could not be requested. Nothing was changed.");
      } finally {
        setRunning(false);
      }
    },
    [],
  );

  // Deliberately blank while the stored brief loads — the page appears once,
  // rather than flashing a placeholder first.
  if (state === "loading") {
    return <div className={narrowPageCls} />;
  }

  const brief = report?.latest ?? null;
  const cited = new Set(brief?.citedEvidenceIds ?? []);
  const cached = report?.cachedForCurrentPeriod ?? false;

  return (
    <div className={narrowPageCls}>
      <PageHeader
        title="Daily Brief"
        description={`A grounded summary of the monitoring evidence DevPulse has already stored for the current ${report?.windowHours ?? 24}h period.`}
        meta={
          <button
            type="button"
            onClick={() => void generate(cached)}
            disabled={running || !report?.available}
            className={`shrink-0 ${btnPrimary}`}
          >
            {running ? "Generating…" : cached ? "Regenerate" : "Generate brief"}
          </button>
        }
      />

      {!report?.available && (
        <p className={`rounded-md border border-zinc-200 px-3 py-2 ${mutedCls} dark:border-zinc-800`}>
          Briefs cannot be generated — DEEPSEEK_API_KEY is not configured. Monitoring
          continues normally.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          {error}
        </p>
      )}

      {!brief ? (
        <EmptyState
          title="No brief yet"
          message={
            report?.available
              ? "Press “Generate brief” to summarize this period. Nothing is generated automatically."
              : "Configure DEEPSEEK_API_KEY to enable briefs."
          }
        />
      ) : (
        <div className="space-y-4">
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${footnoteCls}`}>
            <span>{fmtPeriod(brief.periodStart, brief.periodEnd)}</span>
            <span>Generated {fmtTime(brief.generatedAt)}</span>
            <span>
              {brief.evidenceCount} evidence item{brief.evidenceCount === 1 ? "" : "s"}
            </span>
            {brief.model && <span>{brief.model}</span>}
            {brief.insufficientEvidence && (
              <StatusBadge tone="warn">Insufficient evidence</StatusBadge>
            )}
          </div>

          <Panel title="Summary">
            <p className="text-sm leading-relaxed whitespace-pre-line text-zinc-800 dark:text-zinc-200">
              {brief.summary}
            </p>
          </Panel>

          {SECTIONS.map(({ key, label }) => {
            const items = brief[key];
            return (
              <Panel key={key} title={label} padded={false}>
                {items.length === 0 ? (
                  <p className={`px-4 py-3 ${footnoteCls}`}>
                    Nothing observed in this period.
                  </p>
                ) : (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {items.map((item, i) => (
                      <li
                        key={i}
                        className="px-4 py-2.5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            );
          })}

          <Panel
            title="Evidence"
            hint={`${brief.evidenceCount} supplied · ${cited.size} cited`}
            padded={false}
          >
            {brief.evidence.length === 0 ? (
              <p className={`px-4 py-3 ${footnoteCls}`}>
                No evidence was recorded for this period.
              </p>
            ) : (
              <ul>
                {brief.evidence.map((e) => {
                  const isCited = cited.has(e.id);
                  return (
                    <li
                      key={e.id}
                      className="flex gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-0 dark:border-zinc-900"
                    >
                      <span
                        className={`w-8 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums ${
                          isCited
                            ? "text-zinc-900 dark:text-zinc-100"
                            : "text-zinc-300 dark:text-zinc-600"
                        }`}
                        title={isCited ? "Cited by the brief" : "Supplied but not cited"}
                      >
                        {e.id}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                          {e.title}
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {e.detail}
                        </p>
                      </div>
                      <span className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                        {e.ts != null ? fmtTime(e.ts) : "—"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <p className={footnoteCls}>
            Grounded only in the evidence above. Nothing was checked, run or fetched to
            produce this brief
            {brief.usage?.outputTokens != null ? ` · ${brief.usage.outputTokens} output tokens` : ""}
            .
          </p>
        </div>
      )}
    </div>
  );
}
