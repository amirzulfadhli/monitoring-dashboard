"use client";

import { useEffect, useState } from "react";
import {
  EmptyState,
  PageHeader,
  Panel,
  StatTile,
  cellMonoCls,
  cellMutedCls,
  footnoteCls,
  metaCls,
  mutedCls,
  pageCls,
  tabCls,
  tableCls,
  tdCls,
  thCls,
  theadRowCls,
  trCls,
} from "@/components/ui";

const REFRESH_MS = 15_000;

type WindowKey = "24H" | "7D" | "30D";
const WINDOW_KEYS: WindowKey[] = ["24H", "7D", "30D"];

type UsageSource = "direct" | "claude-code";

type ModelStat = {
  source: UsageSource;
  model: string;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
};

type SourceStat = {
  source: UsageSource;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
};

type TimeBucket = { ts: number; requests: number; tokens: number };

type ClaudeCodeIngest = {
  attempted: boolean;
  ok: boolean;
  dirFound: boolean;
  throttled: boolean;
  filesScanned: number;
  insertedRows: number;
};

type AiUsageSummary = {
  windowMs: number;
  requests: number;
  success: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
  bySource: SourceStat[];
  byModel: ModelStat[];
  overTime: TimeBucket[];
  claudeCodeIngest?: ClaudeCodeIngest;
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
      <div className={`mb-2 flex items-center justify-between ${mutedCls}`}>
        <span>tokens per interval</span>
        <span className={metaCls}>{unit}</span>
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
      <div className={`mt-1 flex justify-between ${footnoteCls}`}>
        <span>{new Date(data[0].ts).toLocaleString()}</span>
        <span>{new Date(data[data.length - 1].ts).toLocaleString()}</span>
      </div>
    </div>
  );
}

const SOURCE_META: Record<
  UsageSource,
  { title: string; blurb: string }
> = {
  direct: {
    title: "DeepSeek direct · DevPulse",
    blurb: "Requests made through DevPulse’s own DeepSeek wrapper.",
  },
  "claude-code": {
    title: "DeepSeek via Claude Code",
    blurb: "Ingested from local Claude Code transcripts for this project.",
  },
};

function UsageTable({
  source,
  rows,
}: {
  source: UsageSource;
  rows: ModelStat[];
}) {
  const meta = SOURCE_META[source];
  return (
    <Panel title={meta.title} hint={meta.blurb} padded={false}>
      <div className="overflow-x-auto">
        <table className={`${tableCls} text-xs`}>
          <thead>
            <tr className={theadRowCls}>
              <th className={thCls}>Model</th>
              <th className={`${thCls} text-right`}>Requests</th>
              <th className={`${thCls} text-right`}>Input</th>
              <th className={`${thCls} text-right`}>Output</th>
              <th className={`${thCls} text-right`}>Thinking</th>
              <th className={`${thCls} text-right`}>Total</th>
              <th className={`${thCls} text-right`}>Failures</th>
              <th className={`${thCls} text-right`}>Latency</th>
              <th className={`${thCls} text-right`}>Est. cost</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {rows.map((m) => (
              <tr key={`${m.source}:${m.model}`} className={trCls}>
                <td className={`${tdCls} text-zinc-900 dark:text-zinc-100`}>{m.model}</td>
                <td className={`${tdCls} text-right ${cellMonoCls}`}>{m.requests}</td>
                <td className={`${tdCls} text-right ${cellMonoCls}`}>{fmtTokens(m.inputTokens)}</td>
                <td className={`${tdCls} text-right ${cellMonoCls}`}>{fmtTokens(m.outputTokens)}</td>
                <td className={`${tdCls} text-right ${cellMutedCls}`}>
                  {m.thinkingTokens > 0 ? fmtTokens(m.thinkingTokens) : "–"}
                </td>
                <td className={`${tdCls} text-right text-zinc-900 dark:text-zinc-100`}>
                  {fmtTokens(m.totalTokens)}
                </td>
                <td className={`${tdCls} text-right`}>
                  {m.failures > 0 ? (
                    <span className="text-red-600 dark:text-red-400">{m.failures}</span>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-500">0</span>
                  )}
                </td>
                <td className={`${tdCls} text-right ${cellMonoCls}`}>{fmtMs(m.avgLatencyMs)}</td>
                <td className={`${tdCls} text-right ${cellMonoCls}`}>
                  {fmtUsd(m.estimatedCostUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {source === "claude-code" ? (
        <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
          <p className={footnoteCls}>
            Token counts are the provider-returned usage metadata in the local transcript; latency
            is not available for ingested requests; cache accounting via the Anthropic-compatible
            bridge is not treated as authoritative; cost is estimated, not provider billing.
          </p>
        </div>
      ) : null}
    </Panel>
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
        { label: "Thinking tokens", value: fmtTokens(summary.thinkingTokens || null) },
        { label: "Est. cost", value: fmtUsd(summary.estimatedCostUsd) },
      ]
    : [];

  const hasData = summary != null && summary.requests > 0;

  // Sources actually present in the window, kept in a stable order.
  const presentSources: UsageSource[] = summary
    ? summary.bySource
        .filter((s) => s.requests > 0)
        .map((s) => s.source)
        .sort((a) => (a === "direct" ? -1 : 1))
    : [];

  const ccIngest = summary?.claudeCodeIngest;

  return (
    <div className={pageCls}>
      <PageHeader
        title="AI Usage"
        description="Model token consumption and estimated cost — direct DeepSeek calls and Claude Code."
        meta={
          <div className="flex flex-wrap items-center gap-1">
            {WINDOW_KEYS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={r === range}
                className={tabCls(r === range)}
              >
                {r}
              </button>
            ))}
          </div>
        }
      />

      {/* Scope / accuracy notes — concise, not visually dominant. */}
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-black">
        <p className={footnoteCls}>
          Direct usage is captured by DevPulse&apos;s DeepSeek wrapper. Claude Code usage is read
          from this project&apos;s local transcripts and is best-effort: cache accounting through the
          bridge is not authoritative, cost is estimated (not provider billing), and latency is
          unavailable for ingested requests.
        </p>
        {ccIngest && !ccIngest.throttled && ccIngest.ok && ccIngest.dirFound ? (
          <p className={`mt-1.5 ${footnoteCls}`}>
            Claude Code transcript scan: {ccIngest.filesScanned} file(s) read,{" "}
            {ccIngest.insertedRows} new row(s) ingested.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <StatTile key={t.label} label={t.label} value={t.value} />
        ))}
      </div>

      {state === "error" ? (
        <EmptyState message="Usage history is currently unavailable." />
      ) : state === "loading" ? (
        <EmptyState message="Loading usage…" />
      ) : !hasData ? (
        <EmptyState
          title="No AI usage recorded"
          message="Usage records requests made through DevPulse's DeepSeek wrapper and, when available, DeepSeek usage Claude Code reports in this project's local transcripts. No fabricated figures are shown — this page reports real instrumented usage only."
        />
      ) : summary ? (
        <>
          {presentSources.map((source) => (
            <UsageTable
              key={source}
              source={source}
              rows={summary.byModel.filter((m) => m.source === source && m.requests > 0)}
            />
          ))}

          <Panel title="Usage over time">
            {summary.overTime.some((b) => b.requests > 0) ? (
              <UsageChart buckets={summary.overTime} unit="tokens" />
            ) : (
              <p className={footnoteCls}>No interval has recorded usage in this window.</p>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
