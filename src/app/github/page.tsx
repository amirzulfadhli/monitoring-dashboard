"use client";

import { useEffect, useState } from "react";
import type { GitHubResult, RepoSnapshot, RepoState } from "@/lib/monitoring/github";

// Refresh cadence. The server additionally caches ~60s, so near-simultaneous
// polls never spawn duplicate GitHub API calls.
const REFRESH_MS = 60_000;

type Tone = "good" | "warn" | "run" | "critical" | "muted";

const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  run: "bg-sky-500",
  critical: "bg-red-500",
  muted: "bg-zinc-300 dark:bg-zinc-600",
};

const stateTone: Record<RepoState, Tone> = {
  healthy: "good",
  attention: "warn",
  running: "run",
  unavailable: "critical",
};

type Api = GitHubResult;

function fmtAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function fmtClock(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

function StatTile({
  label,
  value,
  dot,
}: {
  label: string;
  value: string;
  dot?: Tone;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-3 flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {dot && <span className={`h-2 w-2 rounded-full ${toneDot[dot]}`} aria-hidden="true" />}
        {value}
      </p>
    </div>
  );
}

export default function GitHubPage() {
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/github", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as Api;
          if (!cancelled) {
            setData(d);
            setState("ok");
          }
        } else if (!cancelled) {
          setState("error");
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
  }, []);

  let body: React.ReactNode;
  if (state === "error" && !data) {
    body = <Empty message="GitHub monitoring is unavailable." />;
  } else if (!data) {
    body = <Empty message="Contacting GitHub…" />;
  } else {
    const c = data.counts;
    body = (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Repos" value={String(c.monitored)} />
          <StatTile label="Healthy" value={String(c.healthy)} dot="good" />
          <StatTile label="Attention" value={String(c.attention)} dot="warn" />
          <StatTile label="Running / down" value={String(c.running + c.unavailable)} dot="critical" />
        </div>

        {!data.auth.configured && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            GitHub monitoring needs a <code className="font-mono">GITHUB_TOKEN</code> to query
            repositories. Health data is paused until it is set.
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="px-4 py-2.5 font-medium">Repository</th>
                <th className="px-4 py-2.5 font-medium">Branch</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Latest commit</th>
                <th className="px-4 py-2.5 font-medium">Last push</th>
                <th className="px-4 py-2.5 font-medium text-right">Issues</th>
                <th className="px-4 py-2.5 font-medium text-right">PRs</th>
                <th className="px-4 py-2.5 font-medium">Latest run</th>
              </tr>
            </thead>
            <tbody>
              {data.repos.map((r) => (
                <Row key={r.key} repo={r} />
              ))}
            </tbody>
          </table>
        </div>

        <Quota rate={data.rate} />

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Queried server-side against the GitHub REST API every ~
          {Math.round(REFRESH_MS / 1000)}s while DevPulse is open, and cached ~60s. The token stays
          on the server. Health reflects the latest workflow run, not issue or PR volume.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            GitHub
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Health of configured repositories and their latest CI runs.
          </p>
        </div>
        {data && (
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            Updated {new Date(data.checkedAtMs).toLocaleTimeString()}
          </span>
        )}
      </div>
      {body}
    </div>
  );
}

function Row({ repo }: { repo: RepoSnapshot }) {
  return (
    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
      <td className="px-4 py-3">
        <p className="font-medium text-zinc-900 dark:text-zinc-50">{repo.displayName}</p>
        <p className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
          {repo.owner}/{repo.repo} · {repo.visibility ?? "–"}
          {repo.stars != null && repo.forks != null && (
            <span className="text-zinc-400 dark:text-zinc-500">
              {" "}
              · ★{repo.stars} ⑂{repo.forks}
            </span>
          )}
        </p>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
        {repo.defaultBranch ?? "–"}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 capitalize text-zinc-700 dark:text-zinc-200">
          <span className={`h-2 w-2 rounded-full ${toneDot[stateTone[repo.state]]}`} aria-hidden="true" />
          {repo.state}
        </span>
        {repo.errorMessage && (
          <p className="mt-0.5 max-w-[220px] text-[11px] text-zinc-400 dark:text-zinc-500">
            {repo.errorMessage}
          </p>
        )}
      </td>
      <td className="max-w-[220px] px-4 py-3">
        {repo.commitSha ? (
          <>
            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {repo.commitSha}
            </span>
            <p className="truncate text-xs text-zinc-400 dark:text-zinc-500" title={repo.commitMessage ?? undefined}>
              {repo.commitMessage}
            </p>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {repo.commitAuthor ?? "–"}
              {repo.commitDateMs != null && ` · ${fmtAgo(repo.commitDateMs)}`}
            </p>
          </>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">–</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
        {repo.pushedAtMs != null ? fmtAgo(repo.pushedAtMs) : "–"}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
        {repo.openIssues ?? "–"}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
        {repo.openPrs ?? "–"}
      </td>
      <td className="max-w-[200px] px-4 py-3">
        {repo.hasWorkflow ? (
          <>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={repo.workflowName ?? undefined}>
              {repo.workflowName}
            </p>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {repo.workflowStatus}
              {repo.workflowConclusion ? ` · ${repo.workflowConclusion}` : ""}
              {repo.workflowBranch && ` · ${repo.workflowBranch}`}
            </p>
            {repo.workflowUpdatedAtMs != null && (
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                {fmtAgo(repo.workflowUpdatedAtMs)}
              </p>
            )}
          </>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">
            {repo.state === "unavailable" ? "–" : "no runs"}
          </span>
        )}
      </td>
    </tr>
  );
}

function Quota({ rate }: { rate: Api["rate"] }) {
  if (!rate) return null;
  const known = rate.remaining != null && rate.limit != null;
  const shown = known || rate.resetMs != null;
  if (!shown) return null;
  const remaining = known ? rate.remaining! : null;
  const limit = known ? rate.limit! : null;
  const low = remaining != null && limit != null && remaining / limit < 0.1;
  return (
    <p className="text-xs text-zinc-400 dark:text-zinc-500">
      GitHub API quota:
      <span className={`font-mono tabular-nums ${low ? "text-amber-500" : ""}`}>
        {" "}
        {known ? `${remaining}/${limit}` : "n/a"}
      </span>
      {rate.resetMs != null && <> · resets {fmtClock(rate.resetMs)}</>}
    </p>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
      {message}
    </div>
  );
}
