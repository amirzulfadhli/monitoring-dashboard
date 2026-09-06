import { networkMetrics, trafficSeries, timeRanges } from "@/data/network";

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

// Fold a series into "x,y" polyline points, largest-value-on-top (like Mbps
// where download dwarfs upload) so both lines stay readable.
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
  // Horizontal gridlines at 0 / 25 / 50 / 70 Mbps.
  const guides = [0, 25, 50, MAX];
  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-sky-500" aria-hidden="true" />
          Download
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-emerald-500" aria-hidden="true" />
          Upload
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full text-zinc-300 dark:text-zinc-700"
        role="img"
        aria-label="Download and upload throughput over time"
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

export default function NetworkPage() {
  const m = networkMetrics;
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Network
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Live throughput, latency and packet health for the primary interface.
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Status" value={m.status.label} dot={m.status.tone} />
        <StatTile label="Download" value={String(m.downloadMbps)} unit="Mbps" />
        <StatTile label="Upload" value={String(m.uploadMbps)} unit="Mbps" />
        <StatTile label="Ping" value={String(m.pingMs)} unit="ms" />
        <StatTile label="Jitter" value={String(m.jitterMs)} unit="ms" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Packet loss" value={`${m.packetLossPct}%`} />
        <StatTile label="Down today" value={String(m.downloadTrafficMB)} unit="MB" />
        <StatTile label="Up today" value={String(m.uploadTrafficMB)} unit="MB" />
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
        <div className="mb-4 flex items-baseline justify-between">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Throughput</p>
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">past hour · Mbps</span>
        </div>
        <TrafficChart />
      </div>
    </div>
  );
}
