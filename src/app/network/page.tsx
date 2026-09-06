"use client";

import { useEffect, useState } from "react";
import { timeRanges, trafficSeries } from "@/data/network";
import type { TelemetrySnapshot } from "@/lib/telemetry";

const REFRESH_MS = 3000;

type Tone = "good" | "warn" | "critical";

const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

function StatTile({
  label,
  value,
  unit,
  dot,
}: {
  label: string;
  value: string;
  unit?: string;
  dot?: Tone;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-3 flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {dot && <span className={`h-2 w-2 rounded-full ${toneDot[dot]}`} aria-hidden="true" />}
        {value}
        {unit && (
          <span className="text-sm font-normal text-zinc-400 dark:text-zinc-500">{unit}</span>
        )}
      </p>
    </div>
  );
}

const W = 600;
const H = 160;
const PAD = 8;
const MAX = 70;

function toPoints(series: { down: number; up: number }[], key: "down" | "up") {
  const n = series.length;
  return series
    .map((p, i) => {
      const x = PAD + (i / (n - 1)) * (W - PAD * 2);
      const y = PAD + (1 - p[key] / MAX) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const downPts = toPoints(trafficSeries, "down");
const upPts = toPoints(trafficSeries, "up");

function TrafficChart() {
  const guides = [0, 25, 50, MAX];
  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-sky-500" aria-hidden="true" />
          Receive
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-emerald-500" aria-hidden="true" />
          Transmit
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full text-zinc-300 dark:text-zinc-700"
        role="img"
        aria-label="Sample receive and transmit throughput over the past hour (mock)"
      >
        {guides.map((g) => {
          const y = PAD + (1 - g / MAX) * (H - PAD * 2);
          return (
            <g key={g}>
              <line x1={PAD} x2={W - PAD} y1={y} y2={y} stroke="currentColor" strokeWidth="1" />
              <text x={W - PAD} y={y - 3} textAnchor="end" className="fill-zinc-400 text-[9px] font-mono dark:fill-zinc-500">
                {g}
              </text>
            </g>
          );
        })}
        <polyline points={upPts} fill="none" stroke="currentColor" className="text-emerald-500" strokeWidth="1.5" />
        <polyline points={downPts} fill="none" stroke="currentColor" className="text-sky-500" strokeWidth="1.5" />
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

export default function NetworkPage() {
  const [snap, setSnap] = useState<TelemetrySnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/telemetry", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as TelemetrySnapshot;
          if (!cancelled) {
            setSnap(data);
            setUnavailable(false);
          }
        } else if (!cancelled) {
          setUnavailable(true);
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const net = snap?.network ?? null;
  const up = unavailable || !snap || !net;

  const status: { label: string; tone: Tone } = up
    ? { label: "Unavailable", tone: "critical" }
    : { label: "Online", tone: "good" };

  const rxRate = net ? fmtRate(net.rxRate) : { v: "–", u: "" };
  const txRate = net ? fmtRate(net.txRate) : { v: "–", u: "" };
  const rxTot = net ? fmtBytes(net.rxTotal) : { v: "–", u: "" };
  const txTot = net ? fmtBytes(net.txTotal) : { v: "–", u: "" };

  const active = net?.interfaces.find((i) => !/Virtual|Loopback|vEthernet/i.test(i.name))?.name;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Network
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Live receive/transmit rates and totals for this machine&apos;s physical interfaces.
          </p>
        </div>
        <div className="flex items-center rounded-md border border-zinc-200 bg-white p-0.5 text-xs dark:border-zinc-800 dark:bg-black">
          {timeRanges.map((r) => (
            <button
              key={r}
              className={
                r === "Live"
                  ? "rounded bg-zinc-900 px-2.5 py-1 font-medium text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                  : "cursor-default rounded px-2.5 py-1 text-zinc-500 dark:text-zinc-400"
              }
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Status" value={status.label} dot={status.tone} />
        <StatTile label="Receive rate" value={rxRate.v} unit={rxRate.u} />
        <StatTile label="Transmit rate" value={txRate.v} unit={txRate.u} />
        <StatTile label="Active link" value={active ?? "n/a"} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Total received" value={rxTot.v} unit={rxTot.u} />
        <StatTile label="Total transmitted" value={txTot.v} unit={txTot.u} />
        <div className="flex flex-col justify-center rounded-lg border border-zinc-200 bg-white px-4 py-4 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-black dark:text-zinc-400">
          <p>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Ping · jitter · packet loss</span>{" "}
            are not measured yet.
          </p>
          <p className="mt-1">
            Link rates are machine throughput, not internet speed.
          </p>
          {snap && (
            <p className="mt-1 font-mono tabular-nums">
              Updated {new Date(snap.collectedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
        <div className="mb-4 flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Throughput</p>
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            past hour · sample (mock)
          </span>
        </div>
        <TrafficChart />
      </div>
    </div>
  );
}
