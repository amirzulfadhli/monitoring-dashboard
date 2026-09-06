"use client";

import { useEffect, useRef, useState } from "react";
import type { TelemetrySnapshot } from "@/lib/telemetry";

type Options = {
  refreshMs?: number;
  /** Called after each successful live snapshot. Held in a ref, so it may be a
   * fresh closure every render without restarting the poll. */
  onSnapshot?: (snap: TelemetrySnapshot) => void;
};

/**
 * Poll the live telemetry endpoint on a short interval and expose the latest
 * snapshot plus an "unavailable" flag. Shared by Overview and Network so the
 * live polling loop is not duplicated. Failing requests mark the flag; they
 * never throw.
 */
export function useLiveTelemetry({ refreshMs = 3000, onSnapshot }: Options = {}) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const onSnap = useRef(onSnapshot);
  onSnap.current = onSnapshot;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/telemetry", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as TelemetrySnapshot;
          if (cancelled) return;
          setSnapshot(data);
          setUnavailable(false);
          onSnap.current?.(data);
        } else if (!cancelled) {
          setUnavailable(true);
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    };
    load();
    const id = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshMs]);

  return { snapshot, unavailable };
}
