"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectHealthState, ProjectSummary } from "@/lib/projects/types";

/**
 * Compact project health for the Overview: how many projects exist and how they
 * are distributed across the four states.
 *
 * The counts come from GET /api/projects, which derives them from stored state
 * only — this panel never triggers a check. It renders nothing at all until
 * there is at least one project, so an install that does not use grouping is not
 * given an empty box to ignore.
 */

const REFRESH_MS = 30_000;

const stateTone: Record<ProjectHealthState, string> = {
  healthy: "text-emerald-600 dark:text-emerald-400",
  degraded: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  unknown: "text-zinc-400 dark:text-zinc-500",
};

const stateDot: Record<ProjectHealthState, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  critical: "bg-red-500",
  unknown: "bg-zinc-300 dark:bg-zinc-600",
};

/** Fixed order, so the row never reshuffles as counts change. */
const STATES: ProjectHealthState[] = ["healthy", "degraded", "critical", "unknown"];
const LABELS: Record<ProjectHealthState, string> = {
  healthy: "healthy",
  degraded: "degraded",
  critical: "critical",
  unknown: "unknown",
};

type Api = { count: number; projects: ProjectSummary[] };

export function ProjectsSummary() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as Api;
        if (!cancelled) setProjects(d.projects);
      } catch {
        // Projects are an organizational layer; if they are unavailable the
        // Overview simply does not show the panel.
        if (!cancelled) setProjects(null);
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!projects || projects.length === 0) return null;

  const counts: Record<ProjectHealthState, number> = {
    healthy: 0,
    degraded: 0,
    critical: 0,
    unknown: 0,
  };
  for (const p of projects) counts[p.health.state]++;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      <div className="flex items-baseline justify-between gap-4 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Projects</p>
        <Link
          href="/projects"
          className="text-xs text-zinc-500 underline decoration-zinc-300 underline-offset-2 dark:text-zinc-400 dark:decoration-zinc-700"
        >
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        {STATES.map((state) => (
          <span key={state} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${stateDot[state]}`} aria-hidden="true" />
            <span className={`font-mono text-xs tabular-nums ${stateTone[state]}`}>
              {counts[state]}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{LABELS[state]}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
