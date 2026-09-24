"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navSections } from "@/data/dashboard";
import { useMonitoringStatus } from "@/lib/use-monitoring-status";
import type { SchedulerStatus } from "@/lib/scheduler/model";
import { isActive, navLinkCls } from "@/components/sidebar";
import { StatusDot, type Tone } from "@/components/ui";

/**
 * The status shown here is read from the scheduler's own state — never assumed.
 * A collector that is failing, stale or deliberately inactive is named as such,
 * so the header can never claim everything is fine while something is broken.
 */
function summarise(status: SchedulerStatus | null): { tone: Tone; label: string } {
  if (!status) return { tone: "neutral", label: "Monitoring status unavailable" };
  if (!status.running) return { tone: "critical", label: "Monitoring is stopped" };

  const jobs = Object.values(status.jobs);
  const count = (state: string) => jobs.filter((j) => j.state === state).length;
  const failing = count("failing");
  const stale = count("stale");
  const inactive = count("inactive");

  if (failing > 0) {
    return { tone: "critical", label: `${failing} collector${failing === 1 ? "" : "s"} failing` };
  }
  if (stale > 0) {
    return { tone: "warn", label: `${stale} collector${stale === 1 ? "" : "s"} stale` };
  }
  if (status.freshness.state === "starting") return { tone: "warn", label: "Collectors starting" };
  if (inactive > 0) {
    return { tone: "neutral", label: `${inactive} collector${inactive === 1 ? "" : "s"} inactive` };
  }
  return { tone: "good", label: "All collectors healthy" };
}

export function TopBar() {
  const pathname = usePathname();
  const status = useMonitoringStatus();
  const { tone, label } = summarise(status);

  return (
    <header className="shrink-0 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      <div className="flex h-14 items-center justify-between gap-4 px-4">
        <div className="md:hidden">
          <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            devpulse
          </span>
        </div>
        <div className="hidden items-center gap-2 text-sm text-zinc-500 md:flex dark:text-zinc-400">
          <StatusDot tone={tone} />
          <span>{label}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">dev · local</span>
        </div>
      </div>

      {/* Narrow viewports hide the sidebar, so the same links scroll here
          instead — one navigation model, not a second one. */}
      <nav
        aria-label="Sections"
        className="flex gap-1 overflow-x-auto px-2 pb-1.5 md:hidden"
      >
        {navSections.map((item) => {
          const active = isActive(pathname, item.href);
          const cls = `${navLinkCls(active, Boolean(item.href))} shrink-0 whitespace-nowrap`;
          return item.href ? (
            <Link
              key={item.label}
              href={item.href}
              className={cls}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          ) : (
            <span key={item.label} className={cls}>
              {item.label}
            </span>
          );
        })}
      </nav>
    </header>
  );
}
