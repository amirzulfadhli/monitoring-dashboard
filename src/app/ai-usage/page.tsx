"use client";

import { useEffect, useState } from "react";

const REFRESH_MS = 15_000;

type WindowKey = "24H" | "7D" | "30D";
const WINDOW_KEYS: WindowKey[] = ["24H", "7D", "30D"];

type ModelStat = {
  model: string;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
};

type TimeBucket = { ts: number; requests: number; tokens: number };

type AiUsageSummary = {
  windowMs: number;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
  byModel: ModelStat[];
  overTime: TimeBucket[];
};

/** Compact token count, e.g. 1.2M or 340K. */
function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function fmtMs(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${n.toFixed(0)}ms`;
}

/** Currency, sized to magnitude — DeepSeek usage is typically sub-cent. */
function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "–";
  if (v === 0) return "$0";
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(6)}`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-3 font-mono text-xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {value}
      </p>
    </div>
  );
}

const W = 600;
const H = 150;
const PAD = 8;

/** A restrained line of tokens-per-bucket. Only rendered when data exists. */
function UsageChart({ buckets, unit }: { buckets: TimeBucket[]; unit: string }) {
  const data = buckets.filter((b) => b.requests > 0);
  const peak = Math.max(1, ...data.map((b) => b.tokens));
  const yMax = peak * 1.1;
  const n = data.length;
  const pts = data
    .map((b, i) => {
      const x = PAD + (i / (n - 1)) * (W - PAD * 2);
      const y = PAD + (1 - b.tokens / yMax) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>tokens per interval</span>
        <span className="font-mono">{unit}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full text-sky-500"
        role="img"
        aria-label="Model tokens used over the selected window"
      >
        {data.length > 1 ? (
          <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
        ) : (
          <circle cx={PAD} cy={H - PAD} r="2" fill="currentColor" />
        )}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
        <span>{new Date(data[0].ts).toLocaleString()}</span>
        <span>{new Date(data[data.length - 1].ts).toLocaleString()}</span>
      </div>
    </div>
  );
}

function EmptyNote() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-8 text-center dark:border-zinc-700 dark:bg-black">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">No AI usage recorded</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Usage starts recording when a request is made through DevPulse&apos;s DeepSeek wrapper.
        No fabricated figures are shown — this page reports real instrumented requests only.
      </p>
    </div>
  );
}

export default function AiUsagePage() {
  const [range, setRange] = useState<WindowKey>("24H");
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setState("loading");
      try {
        const res = await fetch(`/api/ai-usage?window=${range}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          setSummary((await res.json()) as AiUsageSummary);
          setState("idle");
        } else if (!cancelled) {
          setState("error");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [range]);

  const tiles = summary
    ? [
        { label: "Requests", value: String(summary.requests) },
        { label: "Total tokens", value: fmtTokens(summary.totalTokens) },
        { label: "Input tokens", value: fmtTokens(summary.inputTokens) },
        { label: "Output tokens", value: fmtTokens(summary.outputTokens) },
        { label: "Avg latency", value: fmtMs(summary.avgLatencyMs) },
        { label: "Est. cost", value: fmtUsd(summary.estimatedCostUsd) },
      ]
    : [];

  const hasData = summary != null && summary.requests > 0;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            AI Usage
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Model token consumption and estimated cost for requests made through DevPulse.
          </p>
        </div>
        <div className="flex items-center rounded-md border border-zinc-200 bg-white p-0.5 text-xs dark:border-zinc-800 dark:bg-black">
          {WINDOW_KEYS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              aria-pressed={r === range}
              className={
                r === range
                  ? "rounded bg-zinc-900 px-2.5 py-1 font-medium text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                  : "cursor-pointer rounded px-2.5 py-1 text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Scope / accuracy notes — never present fabricated coverage. */}
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-xs leading-relaxed text-zinc-500 dark:border-zinc-800 dark:bg-black dark:text-zinc-400">
        <p>
          This page only reflects requests that pass through DevPulse&apos;s DeepSeek wrapper.
          It does not and cannot report on Claude Code usage: Claude Code talks to its model
          providers directly, not through DevPulse, so that usage is not visible here unless a
          separate, reliable usage source is later integrated.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <StatTile key={t.label} label={t.label} value={t.value} />
        ))}
      </div>

      {state === "error" ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-600">
          Usage history is currently unavailable.
        </div>
      ) : state === "loading" ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-600">
          Loading usage…
        </div>
      ) : !hasData ? (
        <EmptyNote />
      ) : summary ? (
        <>
          <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Provider / model
              </p>
              <span className="text-[11px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                DeepSeek · V1
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-zinc-100 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800/60 dark:text-zinc-500">
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 text-right font-medium">Requests</th>
                    <th className="px-4 py-2 text-right font-medium">Tokens</th>
                    <th className="px-4 py-2 text-right font-medium">Failures</th>
                    <th className="px-4 py-2 text-right font-medium">Latency</th>
                    <th className="px-4 py-2 text-right font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 font-mono tabular-nums dark:divide-zinc-800/60">
                  {summary.byModel.map((m) => (
                    <tr key={m.model}>
                      <td className="px-4 py-2 text-zinc-900 dark:text-zinc-100">{m.model}</td>
                      <td className="px-4 py-2 text-right text-zinc-500 dark:text-zinc-400">
                        {m.requests}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-900 dark:text-zinc-100">
                        {fmtTokens(m.totalTokens)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {m.failures > 0 ? (
                          <span className="text-red-600 dark:text-red-400">{m.failures}</span>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-600">0</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-500 dark:text-zinc-400">
                        {fmtMs(m.avgLatencyMs)}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-500 dark:text-zinc-400">
                        {fmtUsd(m.estimatedCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
            <p className="mb-4 text-sm font-medium text-zinc-900 dark:text-zinc-100">Usage over time</p>
            {summary.overTime.some((b) => b.requests > 0) ? (
              <UsageChart buckets={summary.overTime} unit="tokens" />
            ) : (
              <p className="text-xs text-zinc-400 dark:text-zinc-600">No interval has recorded usage in this window.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
