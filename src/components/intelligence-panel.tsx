"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Panel,
  StatusBadge,
  btnCls,
  footnoteCls,
  labelCls,
  metaCls,
  mutedCls,
  severityTone,
  type Tone,
} from "@/components/ui";

/**
 * Overview Intelligence panel. Renders the latest DeepSeek operational brief
 * for the last 24h. Read-only on mount (GET /api/intelligence — never a model
 * call); a live analysis runs only when the user presses "Analyze", which
 * either returns the fresh cached brief or triggers one new analysis.
 */

type Finding = {
  severity: "info" | "warning" | "critical";
  title: string;
  explanation: string;
  evidenceEventIds: string[];
};

type Report = {
  available: boolean;
  windowHours: number;
  lastAnalyzedAt: number | null;
  fresh: boolean;
  analysis: {
    status: Status;
    summary: string;
    findings: Finding[];
    recommendations: string[];
  } | null;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  evidenceCount: number;
};

type PostResult =
  | { ok: true; computed: boolean; report: Report }
  | { ok: false; reason: string; message: string; report: Report };

type Status = "normal" | "attention" | "critical";
const statusTone: Record<Status, Tone> = {
  normal: "good",
  attention: "warn",
  critical: "critical",
};
const sevLabel = { info: "Info", warning: "Warning", critical: "Critical" };
const statusLabel = { normal: "Normal", attention: "Attention", critical: "Critical" };

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function IntelligencePanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/intelligence", { cache: "no-store" });
        if (!cancelled && res.ok) {
          setReport((await res.json()) as Report);
          setState("ready");
        } else if (!cancelled) {
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const analyze = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/intelligence/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // ignored by the server — the action is fixed
        cache: "no-store",
      });
      const data = (await res.json()) as PostResult;
      if (data.ok) {
        setReport(data.report);
      } else {
        setError(data.message);
        if (data.report) setReport(data.report);
      }
    } catch {
      setError("Analysis request failed. The last good analysis, if any, is preserved.");
    } finally {
      setRunning(false);
    }
  }, []);

  if (state === "loading") return null; // keep Overview stable while the brief loads

  const analysis = report?.analysis ?? null;

  return (
    <Panel
      title="Intelligence"
      hint={`DeepSeek over the last ${report?.windowHours ?? 24}h of DevPulse evidence`}
      action={
        <button onClick={analyze} disabled={running || !report?.available} className={btnCls}>
          {running ? "Analyzing…" : "Analyze last 24h"}
        </button>
      }
    >
      {!report?.available ? (
        <p className={footnoteCls}>
          Intelligence is unavailable — DEEPSEEK_API_KEY is not configured. Monitoring continues
          normally.
        </p>
      ) : !analysis ? (
        <p className={footnoteCls}>
          No analysis yet. Press “Analyze last 24h” to generate an operational brief from the last{" "}
          {report.windowHours} hours of DevPulse evidence.
        </p>
      ) : (
        <>
          {report.lastAnalyzedAt && (
            <p className={`mb-3 ${footnoteCls}`}>
              Last analyzed {fmtTime(report.lastAnalyzedAt)} · based on {report.evidenceCount} events
              {report.fresh ? " · fresh" : ""}
              {report.model ? ` · ${report.model}` : ""}
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusBadge tone={statusTone[analysis.status]}>
              {statusLabel[analysis.status]}
            </StatusBadge>
            <p className={`text-sm text-zinc-700 dark:text-zinc-300`}>{analysis.summary}</p>
          </div>

          {analysis.findings.length > 0 && (
            <div className="mb-3">
              <p className={`mb-1.5 ${labelCls}`}>Key findings</p>
              <ul className="space-y-1.5">
                {analysis.findings.map((f, i) => (
                  <li
                    key={i}
                    className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={severityTone[f.severity]}>
                        {sevLabel[f.severity]}
                      </StatusBadge>
                      <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                        {f.title}
                      </span>
                    </div>
                    <p className={`mt-1 leading-relaxed ${mutedCls}`}>{f.explanation}</p>
                    {f.evidenceEventIds.length > 0 && (
                      <Link href="/history" className={`mt-1 inline-block ${metaCls} underline-offset-2 hover:underline`}>
                        {f.evidenceEventIds.length} supporting{" "}
                        {f.evidenceEventIds.length === 1 ? "event" : "events"} in timeline
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {analysis.recommendations.length > 0 && (
            <div>
              <p className={`mb-1.5 ${labelCls}`}>Recommendations</p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
                {analysis.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Panel>
  );
}
