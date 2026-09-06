"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navSections } from "@/data/dashboard";

function isActive(pathname: string, href?: string) {
  if (!href) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

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
            const content = <>{item.label}</>;

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
