"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { Severity } from "@/lib/alerts/model";
import type {
  ProjectDetail,
  ProjectSource,
  ProjectSourceType,
  SourceHealth,
} from "@/lib/projects/types";

/**
 * Project detail. Every value on this page comes from the project API, which
 * reads *persisted* state — no collector is triggered and no grouped source is
 * contacted to render it. Alerts shown here are the ordinary source alerts
 * filtered to this project's members; Task 25 defines no project-level rule.
 */

const REFRESH_MS = 30_000;

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-black dark:text-zinc-100";
const btnPrimary =
  "rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const btnCls =
  "rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800/60";
const btnQuiet =
  "rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200";

const healthDot: Record<SourceHealth, string> = {
  healthy: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
  unknown: "bg-zinc-300 dark:bg-zinc-600",
};

const sevDot: Record<Severity, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
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
      <div className="space-y-4 p-4 md:p-6">
        <BackLink />
        <Empty message="This project could not be loaded." />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <BackLink />
        <Empty message="Loading project…" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {project.name}
          </h1>
          <p className="mt-0.5 max-w-[640px] text-sm text-zinc-500 dark:text-zinc-400">
            {project.description ?? "No description."}
          </p>
        </div>
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
          <button
            type="button"
            className={btnCls}
            onClick={remove}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      </div>

      {editing && (
        <form
          onSubmit={save}
          className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="edit-name" className="block pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Name
              </label>
              <input
                id="edit-name"
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="edit-description" className="block pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Description
              </label>
              <input
                id="edit-description"
                className={inputCls}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <form onSubmit={assign} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[260px] flex-1">
          <label htmlFor="assign-source" className="block pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Assign an existing source
          </label>
          <select
            id="assign-source"
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
        </div>
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
          <ul className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
            {project.alerts.map((a) => (
              <li
                key={a.fingerprint}
                className="flex items-start gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-0 dark:border-zinc-900"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sevDot[a.severity]}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{a.title}</p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={a.message}>
                    {a.message}
                  </p>
                </div>
                <span className="shrink-0 pt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                  {fmtAgo(a.lastSeenAt)}
                </span>
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
                <p className="text-xs text-zinc-400 dark:text-zinc-500">{section.empty}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                        <th className="px-4 py-2.5 font-medium">Source</th>
                        <th className="px-4 py-2.5 font-medium">Target</th>
                        <th className="px-4 py-2.5 font-medium">Latest state</th>
                        <th className="px-4 py-2.5 font-medium">Observed</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => (
                        <tr
                          key={`${s.type}:${s.id}`}
                          className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                        >
                          <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                            {s.name}
                            {!s.enabled && (
                              <span className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                                disabled
                              </span>
                            )}
                          </td>
                          <td className="max-w-[240px] truncate px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                            {s.detail}
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1.5 capitalize text-zinc-700 dark:text-zinc-200">
                              <span
                                className={`h-2 w-2 rounded-full ${healthDot[s.health]}`}
                                aria-hidden="true"
                              />
                              {s.health === "unknown" ? "not reported" : s.health}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-400 tabular-nums dark:text-zinc-500">
                            {fmtAgo(s.checkedAt)}
                          </td>
                          <td className="px-4 py-3 text-right">
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

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        States above are the latest results DevPulse has already stored. Opening this page does not
        run a check. Unassigning a source stops grouping only — monitoring is unchanged.
      </p>
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

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
      {message}
    </div>
  );
}
