"use client";

import { useCallback, useEffect, useState } from "react";

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

  if (state === "loading") {
    return <div className="mx-auto max-w-3xl p-4 md:p-6" />;
  }

  const brief = report?.latest ?? null;
  const cited = new Set(brief?.citedEvidenceIds ?? []);
  const cached = report?.cachedForCurrentPeriod ?? false;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Daily Brief
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            A grounded summary of the monitoring evidence DevPulse has already stored for
            the current {report?.windowHours ?? 24}h period.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void generate(cached)}
          disabled={running || !report?.available}
          className="shrink-0 rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {running ? "Generating…" : cached ? "Regenerate" : "Generate brief"}
        </button>
      </div>

      {!report?.available && (
        <p className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Briefs cannot be generated — DEEPSEEK_API_KEY is not configured. Monitoring
          continues normally.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {error}
        </p>
      )}

      {!brief ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center dark:border-zinc-800 dark:bg-black">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No brief yet.</p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            {report?.available
              ? "Press “Generate brief” to summarize this period. Nothing is generated automatically."
              : "Configure DEEPSEEK_API_KEY to enable briefs."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-zinc-400 dark:text-zinc-500">
            <span>{fmtPeriod(brief.periodStart, brief.periodEnd)}</span>
            <span>Generated {fmtTime(brief.generatedAt)}</span>
            <span>
              {brief.evidenceCount} evidence item{brief.evidenceCount === 1 ? "" : "s"}
            </span>
            {brief.model && <span>{brief.model}</span>}
            {brief.insufficientEvidence && (
              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                Insufficient evidence
              </span>
            )}
          </div>

          <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
            <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Summary
            </p>
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-zinc-800 dark:text-zinc-200">
              {brief.summary}
            </p>
          </section>

          {SECTIONS.map(({ key, label }) => {
            const items = brief[key];
            return (
              <section
                key={key}
                className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black"
              >
                <p className="border-b border-zinc-100 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-900 dark:text-zinc-500">
                  {label}
                </p>
                {items.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-zinc-400 dark:text-zinc-500">
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
              </section>
            );
          })}

          <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-900">
              <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Evidence
              </span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {brief.evidenceCount} supplied · {cited.size} cited
              </span>
            </div>
            {brief.evidence.length === 0 ? (
              <p className="px-4 py-3 text-sm text-zinc-400 dark:text-zinc-500">
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
          </section>

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
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
