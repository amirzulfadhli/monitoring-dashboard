"use client";

import { useEffect, useState } from "react";
import type { CollectorState, JobName, JobStatus } from "@/lib/scheduler/model";
import { COLLECTOR_STATE_LABELS } from "@/lib/scheduler/model";
import { Panel, StatusDot, cellMutedCls, toneText, type Tone } from "@/components/ui";

// Ages are recomputed on this tick, matched to the status poll cadence.
const TICK_MS = 10_000;

/** Same mapping as the Devices page, so a collector reads the same in both. */
const stateTone: Record<CollectorState, Tone> = {
  healthy: "good",
  stale: "warn",
  failing: "critical",
  inactive: "neutral",
};

// Status colour is meaningful here (something is wrong or it is not), so states
// beyond "healthy" get a tone and "healthy" stays neutral text.
const stateText: Record<CollectorState, string> = {
  healthy: "text-zinc-500 dark:text-zinc-400",
  stale: toneText.warn,
  failing: toneText.critical,
  inactive: "text-zinc-400 dark:text-zinc-500",
};

/** Which collector produces which DevPulse surface. */
const COLLECTOR_LABELS: Record<JobName, string> = {
  telemetry: "Telemetry",
  websites: "Websites",
  apis: "APIs",
  devices: "Devices",
  security: "Security",
  storage: "Storage",
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
    <Panel
      title="Collectors"
      hint={
        failing > 0 ? `${failing} failing` : "Background collection is running server-side"
      }
      padded={false}
    >
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {names.map((name) => {
          const job = jobs[name];
          return (
            <div key={name} className="flex items-center justify-between gap-4 px-4 py-2">
              <dt className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <StatusDot tone={stateTone[job.state]} className="h-1.5 w-1.5" />
                {COLLECTOR_LABELS[name]}
              </dt>
              <dd className="flex items-baseline gap-3">
                <span className={cellMutedCls}>{detail(job, now)}</span>
                <span className={`w-16 text-right text-xs font-medium ${stateText[job.state]}`}>
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
              <p key={n} className={`font-mono text-xs ${toneText.critical}`}>
                {COLLECTOR_LABELS[n]}: {jobs[n].lastError}
                {jobs[n].consecutiveFailures > 1
                  ? ` (${jobs[n].consecutiveFailures} consecutive)`
                  : ""}
              </p>
            ))}
        </div>
      )}
    </Panel>
  );
}
