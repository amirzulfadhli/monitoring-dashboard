import type { Kpi } from "@/data/dashboard";

const arrowFor = {
  up: "↑",
  down: "↓",
  flat: "·",
} as const;

const toneDot = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
} as const;

export function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {kpi.label}
        </p>
        {kpi.status && (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <span
              className={`h-1.5 w-1.5 rounded-full ${toneDot[kpi.status.tone]}`}
              aria-hidden="true"
            />
            {kpi.status.label}
          </span>
        )}
      </div>
      <p className="mt-3 font-mono text-3xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {kpi.value}
        {kpi.unit && (
          <span className="ml-1 text-base font-normal text-zinc-400 dark:text-zinc-500">
            {kpi.unit}
          </span>
        )}
      </p>
      <p className="mt-2 flex items-center gap-1 text-xs text-zinc-400 dark:text-zinc-500">
        {kpi.deltaDirection !== "flat" && (
          <span aria-hidden="true">{arrowFor[kpi.deltaDirection]}</span>
        )}
        {kpi.delta}
      </p>
    </div>
  );
}
