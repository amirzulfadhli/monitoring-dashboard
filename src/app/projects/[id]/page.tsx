"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type {
  ProjectDetail,
  ProjectHealth,
  ProjectHealthState,
  ProjectSource,
  ProjectSourceType,
  SourceHealth,
} from "@/lib/projects/types";
import {
  EmptyState,
  Field,
  PageHeader,
  StatusDot,
  StatusLabel,
  btnCls,
  btnPrimary,
  btnQuiet,
  cellMonoCls,
  cellMutedCls,
  footnoteCls,
  inputCls,
  mutedCls,
  pageCls,
  severityTone,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  theadRowCls,
  trCls,
  type Tone,
} from "@/components/ui";

/**
 * Project detail. Every value on this page comes from the project API, which
 * reads *persisted* state — no collector is triggered and no grouped source is
 * contacted to render it. Alerts shown here are the ordinary source alerts
 * filtered to this project's members; Task 25 defines no project-level rule.
 */

const REFRESH_MS = 30_000;

const healthTone: Record<SourceHealth, Tone> = {
  healthy: "good",
  warn: "warn",
  critical: "critical",
  unknown: "neutral",
};

const projectState: Record<ProjectHealthState, { band: SourceHealth; label: string }> = {
  healthy: { band: "healthy", label: "Healthy" },
  degraded: { band: "warn", label: "Degraded" },
  critical: { band: "critical", label: "Critical" },
  unknown: { band: "unknown", label: "Unknown" },
};

type Api = { project: ProjectDetail };

const SECTIONS: { type: ProjectSourceType; title: string; empty: string }[] = [
  { type: "website", title: "Websites", empty: "No websites in this project." },
  { type: "repository", title: "Repositories", empty: "No repositories in this project." },
  { type: "api", title: "APIs", empty: "No API endpoints in this project." },
  { type: "device", title: "Devices", empty: "No devices in this project." },
];

function fmtAgo(ts: number | null) {
  if (ts == null) return "never observed";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = decodeURIComponent(String(params.id));

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  // Bumped after a mutation so the effect below refetches immediately rather
  // than waiting out the polling interval.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setState("error");
          return;
        }
        const d = (await res.json()) as Api;
        if (!cancelled) {
          setProject(d.project);
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
  }, [projectId, reloadKey]);

  async function mutate(path: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        setError(j.error ?? "The change could not be saved.");
        return false;
      }
      setReloadKey((v) => v + 1);
      return true;
    } catch {
      setError("The change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/projects/${encodeURIComponent(projectId)}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (await mutate(base, "PUT", { name, description })) setEditing(false);
  }

  async function remove() {
    if (!project) return;
    // Confirmed explicitly: the action removes the grouping, and the user should
    // be told what happens to the sources rather than discovering it.
    const okToDelete = window.confirm(
      `Delete "${project.name}"? Its ${project.sources.length} source${
        project.sources.length === 1 ? "" : "s"
      } stay monitored and keep their history — they just become ungrouped.`,
    );
    if (!okToDelete) return;
    if (await mutate(base, "DELETE")) router.push("/projects");
  }

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    if (!pick) return;
    const [type, id] = pick.split("\u0000");
    if (await mutate(`${base}/sources`, "POST", { type, id })) setPick("");
  }

  async function unassign(s: ProjectSource) {
    await mutate(
      `${base}/sources?type=${encodeURIComponent(s.type)}&id=${encodeURIComponent(s.id)}`,
      "DELETE",
    );
  }

  if (state === "error" && !project) {
    return (
      <div className={pageCls}>
        <BackLink />
        <EmptyState message="This project could not be loaded." />
      </div>
    );
  }
  if (!project) {
    return (
      <div className={pageCls}>
        <BackLink />
        <EmptyState message="Loading project…" />
      </div>
    );
  }

  return (
    <div className={pageCls}>
      <BackLink />

      <PageHeader
        title={project.name}
        description={
          <span className="block max-w-[640px]">{project.description ?? "No description."}</span>
        }
        meta={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={btnCls}
              onClick={() => {
                setName(project.name);
                setDescription(project.description ?? "");
                setEditing((v) => !v);
              }}
            >
              {editing ? "Cancel" : "Edit"}
            </button>
            <button type="button" className={btnCls} onClick={remove} disabled={busy}>
              Delete
            </button>
          </div>
        }
      />

      <HealthBanner health={project.health} />

      {editing && (
        <form
          onSubmit={save}
          className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name">
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Description">
              <input
                className={inputCls}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </form>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <form onSubmit={assign} className="flex flex-wrap items-end gap-2">
        <Field label="Assign an existing source" className="min-w-[260px] flex-1">
          <select
            className={inputCls}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Select a monitored source…</option>
            {SECTIONS.map((section) => {
              const options = project.unassigned.filter((s) => s.type === section.type);
              if (options.length === 0) return null;
              return (
                <optgroup key={section.type} label={section.title}>
                  {options.map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}\u0000${s.id}`}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </Field>
        <button type="submit" className={btnPrimary} disabled={busy || !pick}>
          Assign
        </button>
      </form>

      {project.alerts.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              Active alerts
            </h2>
            <Link
              href="/alerts"
              className="text-xs text-zinc-500 underline decoration-zinc-300 underline-offset-2 dark:text-zinc-400 dark:decoration-zinc-700"
            >
              All alerts
            </Link>
          </div>
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-black">
            {project.alerts.map((a) => (
              <li key={a.fingerprint} className="flex items-start gap-3 px-4 py-2.5">
                <StatusDot
                  tone={severityTone[a.severity]}
                  className="mt-1.5 h-2 w-2"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{a.title}</p>
                  <p className={`truncate ${mutedCls}`} title={a.message}>
                    {a.message}
                  </p>
                </div>
                <span className={`shrink-0 pt-0.5 ${cellMutedCls}`}>{fmtAgo(a.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="space-y-5">
        {SECTIONS.map((section) => {
          const rows = project.sources.filter((s) => s.type === section.type);
          return (
            <section key={section.type} className="space-y-2">
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                {section.title}
                <span className="ml-2 font-mono text-xs font-normal tabular-nums text-zinc-400 dark:text-zinc-500">
                  {rows.length}
                </span>
              </h2>
              {rows.length === 0 ? (
                <p className={footnoteCls}>{section.empty}</p>
              ) : (
                <div className={tableWrapCls}>
                  <table className={`${tableCls} min-w-[560px]`}>
                    <thead>
                      <tr className={theadRowCls}>
                        <th className={thCls}>Source</th>
                        <th className={thCls}>Target</th>
                        <th className={thCls}>Latest state</th>
                        <th className={thCls}>Observed</th>
                        <th className={thCls} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => (
                        <tr key={`${s.type}:${s.id}`} className={trCls}>
                          <td className={`${tdCls} font-medium text-zinc-900 dark:text-zinc-50`}>
                            {s.name}
                            {!s.enabled && <span className={`ml-2 ${cellMutedCls}`}>disabled</span>}
                          </td>
                          <td className={`max-w-[240px] truncate ${tdCls} ${cellMonoCls}`}>
                            {s.detail}
                          </td>
                          <td className={tdCls}>
                            <StatusLabel tone={healthTone[s.health]} className="text-xs capitalize">
                              {s.health === "unknown" ? "not reported" : s.health}
                            </StatusLabel>
                          </td>
                          <td className={`${tdCls} ${cellMutedCls} tabular-nums`}>
                            {fmtAgo(s.checkedAt)}
                          </td>
                          <td className={`${tdCls} text-right`}>
                            <button
                              type="button"
                              className={btnQuiet}
                              onClick={() => unassign(s)}
                              disabled={busy}
                            >
                              Unassign
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <p className={footnoteCls}>
        States above are the latest results DevPulse has already stored. Opening this page does not
        run a check. Unassigning a source stops grouping only — monitoring is unchanged.
      </p>
    </div>
  );
}

/**
 * Project health: the state, the source bands it was read from, and the
 * deterministic reasons behind it. No gauge, no percentage — the reasons name
 * the sources responsible, and nothing here is inferred beyond stored state.
 */
function HealthBanner({ health }: { health: ProjectHealth }) {
  const { band, label } = projectState[health.state];
  const { counts } = health;
  const summary =
    counts.total === 0
      ? "No sources are associated with this project."
      : [
          counts.critical && `${counts.critical} failing`,
          counts.warn && `${counts.warn} degraded`,
          counts.unknown && `${counts.unknown} unreported`,
          counts.healthy && `${counts.healthy} healthy`,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-black">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <StatusDot tone={healthTone[band]} />
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{label}</span>
        </span>
        <span className={`tabular-nums ${mutedCls}`}>{summary}</span>
      </div>
      {health.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {health.reasons.map((r) => (
            <li key={`${r.type}:${r.id}`} className={mutedCls}>
              {r.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/projects"
      className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
    >
      ← Projects
    </Link>
  );
}
