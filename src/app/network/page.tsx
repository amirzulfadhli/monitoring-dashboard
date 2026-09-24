"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveTelemetry } from "@/lib/use-live-telemetry";
import {
  PageHeader,
  Panel,
  StatTile,
  footnoteCls,
  metaCls,
  mutedCls,
  pageCls,
  tabCls,
  type Tone,
} from "@/components/ui";

const REFRESH_MS = 3000;
const LIVE_POINTS = 60; // ~3 minutes of live readings at the poll rate

type RangeKey = "Live" | "1H" | "24H" | "7D" | "30D";
const RANGE_KEYS: RangeKey[] = ["Live", "1H", "24H", "7D", "30D"];

type Point = { ts: number; rxRate: number; txRate: number };

const W = 600;
const H = 150;
const PAD = 10;

/** Pick a rate unit so the peak reads as a sensible number, e.g. MB/s. */
function rateUnit(maxBytesPerSec: number) {
  if (maxBytesPerSec >= 1e6) return { div: 1e6, unit: "MB/s" };
  if (maxBytesPerSec >= 1e3) return { div: 1e3, unit: "KB/s" };
  return { div: 1, unit: "B/s" };
}

/** Round a value up to the next nice axis bound (1/2/5 × 10^k). */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/** Compact numeric label for an axis guide value. */
function fmtAxis(v: number) {
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function linePoints(scaled: number[], yMax: number) {
  const n = scaled.length;
  return scaled
    .map((v, i) => {
      const x = PAD + (i / (n - 1)) * (W - PAD * 2);
      const y = PAD + (1 - v / yMax) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function ThroughputChart({ points }: { points: Point[] }) {
  const peak = points.reduce((m, p) => Math.max(m, p.rxRate, p.txRate), 1);
  const { div, unit } = rateUnit(peak);
  const rx = points.map((p) => p.rxRate / div);
  const tx = points.map((p) => p.txRate / div);
  const yMax = niceCeil(Math.max(0, ...rx, ...tx, 0.01));
  const guides = [0, 0.5, 1];

  return (
    <div>
      <div className={`mb-3 flex items-center gap-4 ${mutedCls}`}>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-sky-500" aria-hidden="true" />
          Receive
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-emerald-500" aria-hidden="true" />
          Transmit
        </span>
        <span className={`ml-auto ${metaCls}`}>{unit}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full text-zinc-300 dark:text-zinc-700"
        role="img"
        aria-label={`Receive and transmit rates, ${unit}`}
      >
        {guides.map((g) => {
          const y = PAD + (1 - g) * (H - PAD * 2);
          return (
            <g key={g}>
              <line x1={PAD} x2={W - PAD} y1={y} y2={y} stroke="currentColor" strokeWidth="1" />
              <text
                x={W - PAD}
                y={y - 3}
                textAnchor="end"
                className="fill-zinc-400 text-[9px] font-mono dark:fill-zinc-500"
              >
                {fmtAxis(g * yMax)}
              </text>
            </g>
          );
        })}
        <polyline
          points={linePoints(tx, yMax)}
          fill="none"
          stroke="currentColor"
          className="text-emerald-500"
          strokeWidth="1.5"
        />
        <polyline
          points={linePoints(rx, yMax)}
          fill="none"
          stroke="currentColor"
          className="text-sky-500"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

// Pretty-print a byte count, e.g. 1.4 GB.
function fmtBytes(bytes: number) {
  if (bytes >= 1e9) return { v: (bytes / 1e9).toFixed(2), u: "GB" };
  if (bytes >= 1e6) return { v: (bytes / 1e6).toFixed(1), u: "MB" };
  if (bytes >= 1e3) return { v: (bytes / 1e3).toFixed(1), u: "KB" };
  return { v: String(bytes), u: "B" };
}

// Bytes/second -> a compact rate label (KB/s or MB/s).
function fmtRate(bytesPerSec: number) {
  if (bytesPerSec >= 1e6) return { v: (bytesPerSec / 1e6).toFixed(2), u: "MB/s" };
  if (bytesPerSec >= 1e3) return { v: (bytesPerSec / 1e3).toFixed(1), u: "KB/s" };
  return { v: bytesPerSec.toFixed(0), u: "B/s" };
}

// A muted placeholder used for loading / empty / unavailable chart states. The
// wording, not the styling, carries which of the three it is.
function ChartState({ message }: { message: string }) {
  return (
    <div className={`flex h-40 items-center justify-center px-6 text-center ${footnoteCls}`}>
      {message}
    </div>
  );
}

export default function NetworkPage() {
  const [range, setRange] = useState<RangeKey>("Live");
  const liveRef = useRef<Point[]>([]);
  const [, forceTick] = useState(0);

  const { snapshot, unavailable } = useLiveTelemetry({
    refreshMs: REFRESH_MS,
    onSnapshot: (data) => {
      const net = data.network;
      if (net && isFinite(net.rxRate) && isFinite(net.txRate)) {
        liveRef.current = [
          ...liveRef.current.slice(-(LIVE_POINTS - 1)),
          { ts: data.collectedAt, rxRate: net.rxRate, txRate: net.txRate },
        ];
        forceTick((t) => t + 1);
      }
    },
  });

  // History state (only fetched when not on Live).
  const [hist, setHist] = useState<{ range: RangeKey; points: Point[] } | null>(null);
  const [histState, setHistState] = useState<"idle" | "loading" | "error">("idle");

  // Historical fetch whenever a non-live range is selected.
  useEffect(() => {
    if (range === "Live") return;
    let cancelled = false;
    setHistState("loading");
    const load = async () => {
      try {
        const res = await fetch(`/api/telemetry/history?range=${range}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { range: RangeKey; points: Point[] };
          if (!cancelled) {
            setHist(data);
            setHistState("idle");
          }
        } else if (!cancelled) {
          setHistState("error");
        }
      } catch {
        if (!cancelled) setHistState("error");
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const net = snapshot?.network ?? null;
  const up = unavailable || !snapshot || !net;

  const status: { label: string; tone: Tone } = up
    ? { label: "Unavailable", tone: "critical" }
    : { label: "Online", tone: "good" };

  const rxRate = net ? fmtRate(net.rxRate) : { v: "–", u: "" };
  const txRate = net ? fmtRate(net.txRate) : { v: "–", u: "" };
  const rxTot = net ? fmtBytes(net.rxTotal) : { v: "–", u: "" };
  const txTot = net ? fmtBytes(net.txTotal) : { v: "–", u: "" };

  const active = net?.interfaces.find((i) => !/Virtual|Loopback|vEthernet/i.test(i.name))?.name;

  // Decide what the chart shows for the selected range.
  const livePoints = liveRef.current;
  const chartPoints = range === "Live" ? livePoints : hist?.range === range ? hist.points : [];
  const chartSubtitle =
    range === "Live"
      ? up
        ? "recent — awaiting live data"
        : "recent — live"
      : `${range} history`;

  let chartBody: React.ReactNode;
  if (chartPoints.length === 0) {
    if (up && range === "Live") {
      chartBody = <ChartState message="Live telemetry unavailable." />;
    } else if (range === "Live") {
      chartBody = <ChartState message="Waiting for live readings…" />;
    } else if (histState === "loading") {
      chartBody = <ChartState message="Loading history…" />;
    } else if (histState === "error") {
      chartBody = <ChartState message="History unavailable." />;
    } else {
      chartBody = (
        <ChartState message="No history recorded yet for this range. History is collected while DevPulse is running." />
      );
    }
  } else {
    chartBody = <ThroughputChart points={chartPoints} />;
  }

  return (
    <div className={pageCls}>
      <PageHeader
        title="Network"
        description="Live receive/transmit rates and totals for this machine's physical interfaces."
        meta={
          <div className="flex flex-wrap items-center gap-1">
            {RANGE_KEYS.map((r) => (
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Status" value={status.label} tone={status.tone} />
        <StatTile label="Receive rate" value={rxRate.v} unit={rxRate.u} />
        <StatTile label="Transmit rate" value={txRate.v} unit={txRate.u} />
        <StatTile label="Active link" value={active ?? "n/a"} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Total received" value={rxTot.v} unit={rxTot.u} />
        <StatTile label="Total transmitted" value={txTot.v} unit={txTot.u} />
        <div className="flex flex-col justify-center rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-black">
          <p className={mutedCls}>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              Ping · jitter · packet loss
            </span>{" "}
            are not measured yet.
          </p>
          <p className={`mt-1 ${mutedCls}`}>Link rates are machine throughput, not internet speed.</p>
          {snapshot && (
            <p className={`mt-1 tabular-nums ${metaCls}`}>
              Updated {new Date(snapshot.collectedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>

      <Panel title="Throughput" hint={chartSubtitle}>
        {chartBody}
      </Panel>
    </div>
  );
}
