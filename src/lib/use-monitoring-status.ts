"use client";

import { useEffect, useState } from "react";
import type { SchedulerStatus } from "@/lib/scheduler/model";

// Freshness is a slow-moving signal (jobs run every 30–90s), so a gentle poll
// is enough; this never triggers collection, it only reads scheduler state.
const REFRESH_MS = 10_000;

/**
 * Poll GET /api/system/status for the background monitoring scheduler's state.
 * Returns null until the first successful read; failures leave the last known
 * status in place rather than blanking the indicator.
 */
export function useMonitoringStatus(): SchedulerStatus | null {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/system/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as SchedulerStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // Non-fatal: the indicator keeps its previous value.
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}
