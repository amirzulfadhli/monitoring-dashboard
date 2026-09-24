"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectHealth, ProjectHealthState, ProjectSummary, SourceHealth } from "@/lib/projects/types";
import {
  EmptyState,
  Field,
  PageHeader,
  StatusDot,
  btnCls,
  btnPrimary,
  cellMutedCls,
  footnoteCls,
  inputCls,
  pageCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  theadRowCls,
  toneText,
  trCls,
  type Tone,
} from "@/components/ui";

/**
 * Projects list. A project groups sources DevPulse already monitors, so this
 * page shows configuration plus the *stored* latest state of each group — it
 * never triggers a check, and opening it contacts nothing it groups.
 */

const REFRESH_MS = 30_000;

const healthTone: Record<SourceHealth, Tone> = {
  healthy: "good",
  warn: "warn",
  critical: "critical",
  unknown: "neutral",
};

const healthText: Record<SourceHealth, string> = {
  healthy: toneText.good,
  warn: toneText.warn,
  critical: toneText.critical,
  unknown: "text-zinc-400 dark:text-zinc-500",
};

/** Project state -> the source health band and wording it is read from. */
const projectState: Record<ProjectHealthState, { band: SourceHealth; label: string }> = {
  healthy: { band: "healthy", label: "Healthy" },
  degraded: { band: "warn", label: "Degraded" },
  critical: { band: "critical", label: "Critical" },
  unknown: { band: "unknown", label: "Unknown" },
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

/**
 * Project health, as state plus the source bands behind it. The state is the
 * headline; the counts are what it was read from, and the reasons (bounded, from
 * observable source state only) are the tooltip rather than another row.
 */
function HealthCell({ health }: { health: ProjectHealth }) {
  const { band, label } = projectState[health.state];
  const bands: { key: SourceHealth; label: string }[] = [
    { key: "critical", label: "failing" },
    { key: "warn", label: "degraded" },
    { key: "unknown", label: "unreported" },
  ];
  const impaired = bands.filter((b) => health.counts[b.key] > 0);
  const title = health.reasons.length
    ? health.reasons.map((r) => r.message).join("; ")
    : health.counts.total === 0
      ? "No sources are associated with this project."
      : "All associated sources are healthy.";

  return (
    <span className="block" title={title}>
      <span className="flex items-center gap-1.5">
        <StatusDot tone={healthTone[band]} />
        <span className={`text-sm ${healthText[band]}`}>{label}</span>
      </span>
      <span className={`mt-0.5 flex flex-wrap items-center gap-x-2 ${cellMutedCls}`}>
        {health.counts.total === 0 ? (
          <span>no sources</span>
        ) : impaired.length === 0 ? (
          <span className="tabular-nums">
            {health.counts.healthy}/{health.counts.total} healthy
          </span>
        ) : (
          impaired.map((b) => (
            <span key={b.key} className="tabular-nums">
              {health.counts[b.key]} {b.label}
            </span>
          ))
        )}
      </span>
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
    body = <EmptyState message="Projects are temporarily unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Loading projects…" />;
  } else if (data.projects.length === 0) {
    body = <EmptyState message="No projects yet. Create one to group related sources." />;
  } else {
    body = (
      <div className={tableWrapCls}>
        <table className={`${tableCls} min-w-[640px]`}>
          <thead>
            <tr className={theadRowCls}>
              <th className={thCls}>Project</th>
              <th className={thCls}>Sources</th>
              <th className={thCls}>Health</th>
              <th className={thCls}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.projects.map((p) => (
              <tr key={p.id} className={trCls}>
                <td className={tdCls}>
                  <Link
                    href={`/projects/${encodeURIComponent(p.id)}`}
                    className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                  >
                    {p.name}
                  </Link>
                  {p.description && (
                    <p className={`mt-0.5 max-w-[320px] truncate ${cellMutedCls}`}>
                      {p.description}
                    </p>
                  )}
                </td>
                <td className={tdCls}>
                  <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {p.sources.total}
                  </span>
                  <span className={`ml-2 ${cellMutedCls}`}>
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
                <td className={tdCls}>
                  <HealthCell health={p.health} />
                </td>
                <td className={`${tdCls} ${cellMutedCls}`}>
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
    <div className={pageCls}>
      <PageHeader
        title="Projects"
        description="Grouping for sources DevPulse already monitors. A project labels its sources — it does not collect data of its own."
        meta={
          <button type="button" className={btnCls} onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "New project"}
          </button>
        }
      />

      {adding && (
        <form
          onSubmit={create}
          className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name">
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Storefront"
                autoComplete="off"
              />
            </Field>
            <Field label="Description (optional)">
              <input
                className={inputCls}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Everything the customer-facing site depends on"
                autoComplete="off"
              />
            </Field>
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </form>
      )}

      {body}

      <p className={footnoteCls}>
        Deleting a project never deletes its sources or their history — the sources simply become
        ungrouped.
      </p>
    </div>
  );
}
