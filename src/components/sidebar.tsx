import { navSections } from "@/data/dashboard";

export function Sidebar() {
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
          {navSections.map((item) => (
            <li key={item.label}>
              <span
                className={
                  item.active
                    ? "flex rounded-md bg-zinc-900 px-2 py-1.5 text-[13px] font-medium text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                    : "flex cursor-default rounded-md px-2 py-1.5 text-[13px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
                }
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
