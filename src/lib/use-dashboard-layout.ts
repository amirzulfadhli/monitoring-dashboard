"use client";

import { useEffect, useState } from "react";
import {
  defaultDashboardLayout,
  normalizeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard/model";

/**
 * Read the persisted Overview layout once on mount.
 *
 * Returns null only while the first read is in flight, so the page can hold the
 * section area back rather than mounting a section the preference hides and then
 * unmounting it. It always settles on a concrete layout: an unavailable,
 * unknown or malformed preference resolves to the default dashboard, which is
 * the same layout DevPulse renders when nothing has ever been customized.
 */
export function useDashboardLayout(): DashboardLayout | null {
  const [layout, setLayout] = useState<DashboardLayout | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next = defaultDashboardLayout();
      try {
        const res = await fetch("/api/settings/dashboard", { cache: "no-store" });
        if (res.ok) {
          const body: unknown = await res.json();
          // The route answers `{ ok, data }`; tolerate a bare layout too.
          next = normalizeDashboardLayout(
            body && typeof body === "object" && "data" in body
              ? (body as { data: unknown }).data
              : body,
          );
        }
      } catch {
        // Non-fatal: the default dashboard renders instead.
      }
      if (!cancelled) setLayout(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return layout;
}
