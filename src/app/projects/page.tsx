"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectSummary, SourceHealth } from "@/lib/projects/types";

/**
 * Projects list. A project groups sources DevPulse already monitors, so this
 * page shows configuration plus the *stored* latest state of each group — it
 * never triggers a check, and opening it contacts nothing it groups.
 */

const REFRESH_MS = 30_000;

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-black dark:text-zinc-100";
const btnPrimary =
  "rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const btnCls =
  "rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800/60";

const healthDot: Record<SourceHealth, string> = {
  healthy: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
  unknown: "bg-zinc-300 dark:bg-zinc-600",
};

const healthText: Record<SourceHealth, string> = {
  healthy: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  unknown: "text-zinc-400 dark:text-zinc-500",
};

type Api = { count: number; projects: ProjectSummary[] };

function fmtAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compact observed-status summary: only non-zero bands are named. */
function StatusSummary({ health, total }: { health: ProjectSummary["health"]; total: number }) {
  if (total === 0) {
    return <span className="text-xs text-zinc-400 dark:text-zinc-500">No sources</span>;
  }
  const bands: { key: SourceHealth; label: string }[] = [
    { key: "critical", label: "failing" },
    { key: "warn", label: "degraded" },
    { key: "healthy", label: "healthy" },
    { key: "unknown", label: "unreported" },
  ];
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {bands
        .filter((b) => health[b.key] > 0)
        .map((b) => (
          <span key={b.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${healthDot[b.key]}`} aria-hidden="true" />
            <span className={`font-mono text-xs tabular-nums ${healthText[b.key]}`}>
              {health[b.key]}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{b.label}</span>
          </span>
        ))}
    </span>
  );
}

export default function ProjectsPage() {
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  // Bumped after a mutation so the effect below refetches immediately rather
  // than waiting out the polling interval.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const d = (await res.json()) as Api;
        if (!cancelled) {
          setData(d);
          setState("ok");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reloadKey]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        setError(j.error ?? "Could not save the project.");
        return;
      }
      setName("");
      setDescription("");
      setAdding(false);
      setReloadKey((v) => v + 1);
    } catch {
      setError("Could not save the project.");
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (state === "error" && !data) {
    body = <Empty message="Projects are temporarily unavailable." />;
  } else if (!data) {
    body = <Empty message="Loading projects…" />;
  } else if (data.projects.length === 0) {
    body = <Empty message="No projects yet. Create one to group related sources." />;
  } else {
    body = (
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
              <th className="px-4 py-2.5 font-medium">Project</th>
              <th className="px-4 py-2.5 font-medium">Sources</th>
              <th className="px-4 py-2.5 font-medium">Observed status</th>
              <th className="px-4 py-2.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.projects.map((p) => (
              <tr
                key={p.id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/projects/${encodeURIComponent(p.id)}`}
                    className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                  >
                    {p.name}
                  </Link>
                  {p.description && (
                    <p className="mt-0.5 max-w-[320px] truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {p.description}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {p.sources.total}
                  </span>
                  <span className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                    {[
                      p.sources.website && `${p.sources.website} site`,
                      p.sources.repository && `${p.sources.repository} repo`,
                      p.sources.api && `${p.sources.api} api`,
                      p.sources.device && `${p.sources.device} device`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusSummary health={p.health} total={p.health.total} />
                </td>
                <td className="px-4 py-3 text-xs text-zinc-400 dark:text-zinc-500">
                  <span className="tabular-nums">{fmtAgo(p.updatedAt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Projects
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Grouping for sources DevPulse already monitors. A project labels its sources — it
            does not collect data of its own.
          </p>
        </div>
        <button type="button" className={btnCls} onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "New project"}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={create}
          className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="project-name" className="block pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Name
              </label>
              <input
                id="project-name"
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Storefront"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="project-description" className="block pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Description (optional)
              </label>
              <input
                id="project-description"
                className={inputCls}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Everything the customer-facing site depends on"
                autoComplete="off"
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </form>
      )}

      {body}

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Deleting a project never deletes its sources or their history — the sources simply become
        ungrouped.
      </p>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 text-center text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
      {message}
    </div>
  );
}
