export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-black">
      <div className="md:hidden">
        <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          devpulse
        </span>
      </div>
      <div className="hidden items-center gap-2 text-sm text-zinc-500 md:flex dark:text-zinc-400">
        <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        <span>All systems operational</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
          dev · local
        </span>
      </div>
    </header>
  );
}
