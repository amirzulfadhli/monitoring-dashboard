"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { navSections } from "@/data/dashboard";

function isActive(pathname: string, href?: string) {
  if (!href) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Where the unread badge belongs. Only that nav item ever shows a count. */
const BADGE_HREF = "/notifications";

/** Slow poll: this only has to notice what the scheduler recorded meanwhile. */
const UNREAD_REFRESH_MS = 60_000;

function useUnreadCount(pathname: string): number {
  const [unread, setUnread] = useState(0);

  // Re-reads on navigation as well as on the interval, so arriving at the inbox
  // (or leaving it after reading) refreshes the badge without a reload.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/notifications", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { unread?: number };
        if (!cancelled) setUnread(typeof data.unread === "number" ? data.unread : 0);
      } catch {
        // A badge is decoration: a failed read leaves the last known count.
      }
    };
    void load();
    const id = setInterval(() => void load(), UNREAD_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pathname]);

  return unread;
}

export function Sidebar() {
  const pathname = usePathname();
  const unread = useUnreadCount(pathname);

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/70 md:flex dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex h-14 items-center border-b border-zinc-200 px-4 dark:border-zinc-800">
        <span className="font-mono text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          devpulse
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Monitor
        </p>
        <ul className="space-y-px">
          {navSections.map((item) => {
            const active = isActive(pathname, item.href);
            const linkClass = active
              ? "flex rounded-md bg-zinc-900 px-2 py-1.5 text-[13px] font-medium text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
              : item.href
                ? "flex rounded-md px-2 py-1.5 text-[13px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
                : "flex cursor-default rounded-md px-2 py-1.5 text-[13px] text-zinc-500 dark:text-zinc-400";
            const showBadge = item.href === BADGE_HREF && unread > 0;
            const content = (
              <>
                {item.label}
                {showBadge && (
                  // Inverted against the active row so the count stays legible
                  // whether or not the item is the current page.
                  <span
                    className={`ml-auto rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                      active
                        ? "bg-zinc-50 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                        : "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                    }`}
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </>
            );

            return (
              <li key={item.label}>
                {item.href ? (
                  <Link href={item.href} className={linkClass} aria-current={active ? "page" : undefined}>
                    {content}
                  </Link>
                ) : (
                  <span className={linkClass}>{content}</span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
