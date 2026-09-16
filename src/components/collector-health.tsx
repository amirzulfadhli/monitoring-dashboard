"use client";

import { useEffect, useState } from "react";
import type { CollectorState, JobName, JobStatus } from "@/lib/scheduler/model";
import { COLLECTOR_STATE_LABELS } from "@/lib/scheduler/model";

// Ages are recomputed on this tick, matched to the status poll cadence.
const TICK_MS = 10_000;

// Status colour is meaningful here (something is wrong or it is not), so states
// beyond "healthy" get a tone and "healthy" stays neutral.
const stateTone: Record<CollectorState, string> = {
  healthy: "text-zinc-500 dark:text-zinc-400",
  stale: "text-amber-600 dark:text-amber-400",
  failing: "text-red-600 dark:text-red-400",
  inactive: "text-zinc-400 dark:text-zinc-500",
};

const stateDot: Record<CollectorState, string> = {
  healthy: "bg-emerald-500",
  stale: "bg-amber-500",
  failing: "bg-red-500",
  inactive: "bg-zinc-400 dark:bg-zinc-600",
};

/** Which collector produces which DevPulse surface. */
const COLLECTOR_LABELS: Record<JobName, string> = {
  telemetry: "Telemetry",
  websites: "Websites",
  github: "GitHub",
  alerts: "Alerts",
};

/** Compact age, e.g. "12s ago" / "4m ago". */
function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The one-line freshness detail shown beside each collector. */
function detail(job: JobStatus, now: number | null): string {
  if (job.state === "inactive") return job.inactiveReason ?? "Not collecting";
  if (job.lastSuccessAt == null) return "No successful run yet";
  if (now == null) return "—";
  return `Last success ${fmtAge(now - job.lastSuccessAt)}`;
}

export function CollectorHealth({ jobs }: { jobs: Record<JobName, JobStatus> }) {
  // The clock starts as null so the first render stays pure; it is seeded on
  // mount (via a timer, not synchronously in the effect body) and then ticks.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const seed = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearTimeout(seed);
      clearInterval(id);
    };
  }, []);

  const names = Object.keys(COLLECTOR_LABELS) as JobName[];
  const failing = names.filter((n) => jobs[n].state === "failing").length;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      <div className="flex items-baseline justify-between gap-4 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Collectors</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          {failing > 0
            ? `${failing} failing`
            : "Background collection is running server-side"}
        </p>
      </div>
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {names.map((name) => {
          const job = jobs[name];
          return (
            <div key={name} className="flex items-center justify-between gap-4 px-4 py-2">
              <dt className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDot[job.state]}`}
                  aria-hidden="true"
                />
                {COLLECTOR_LABELS[name]}
              </dt>
              <dd className="flex items-baseline gap-3">
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  {detail(job, now)}
                </span>
                <span className={`w-16 text-right text-xs font-medium ${stateTone[job.state]}`}>
                  {COLLECTOR_STATE_LABELS[job.state]}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
      {/* Failure metadata is only surfaced when it exists — a healthy grid needs
          no explanation. The message is sanitized server-side. */}
      {names.some((n) => jobs[n].lastError) && (
        <div className="space-y-1 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
          {names
            .filter((n) => jobs[n].lastError)
            .map((n) => (
              <p key={n} className="font-mono text-xs text-red-600 dark:text-red-400">
                {COLLECTOR_LABELS[n]}: {jobs[n].lastError}
                {jobs[n].consecutiveFailures > 1
                  ? ` (${jobs[n].consecutiveFailures} consecutive)`
                  : ""}
              </p>
            ))}
        </div>
      )}
    </section>
  );
}
