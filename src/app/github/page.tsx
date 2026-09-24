"use client";

import { useEffect, useState } from "react";
import type { GitHubResult, RepoSnapshot, RepoState } from "@/lib/monitoring/github";
import {
  EmptyState,
  PageHeader,
  StatTile,
  StatusLabel,
  cellMonoCls,
  footnoteCls,
  metaCls,
  pageCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  theadRowCls,
  trCls,
  type Tone,
} from "@/components/ui";

// Refresh cadence. The server additionally caches ~60s, so near-simultaneous
// polls never spawn duplicate GitHub API calls.
const REFRESH_MS = 60_000;

const stateTone: Record<RepoState, Tone> = {
  healthy: "good",
  attention: "warn",
  running: "info",
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
    body = <EmptyState message="GitHub monitoring is unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Contacting GitHub…" />;
  } else {
    const c = data.counts;
    body = (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Repos" value={String(c.monitored)} />
          <StatTile label="Healthy" value={String(c.healthy)} tone="good" />
          <StatTile label="Attention" value={String(c.attention)} tone="warn" />
          <StatTile
            label="Running / down"
            value={String(c.running + c.unavailable)}
            tone="critical"
          />
        </div>

        {!data.auth.configured && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            GitHub monitoring needs a <code className="font-mono">GITHUB_TOKEN</code> to query
            repositories. Health data is paused until it is set.
          </p>
        )}

        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>Repository</th>
                <th className={thCls}>Branch</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Latest commit</th>
                <th className={thCls}>Last push</th>
                <th className={`${thCls} text-right`}>Issues</th>
                <th className={`${thCls} text-right`}>PRs</th>
                <th className={thCls}>Latest run</th>
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

        <p className={footnoteCls}>
          Queried server-side against the GitHub REST API every ~
          {Math.round(REFRESH_MS / 1000)}s while DevPulse is open, and cached ~60s. The token stays
          on the server. Health reflects the latest workflow run, not issue or PR volume.
        </p>
      </div>
    );
  }

  return (
    <div className={pageCls}>
      <PageHeader
        title="GitHub"
        description="Health of configured repositories and their latest CI runs."
        meta={
          data ? (
            <span className={metaCls}>
              Updated {new Date(data.checkedAtMs).toLocaleTimeString()}
            </span>
          ) : null
        }
      />
      {body}
    </div>
  );
}

function Row({ repo }: { repo: RepoSnapshot }) {
  return (
    <tr className={trCls}>
      <td className={tdCls}>
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
      <td className={`${tdCls} ${cellMonoCls}`}>{repo.defaultBranch ?? "–"}</td>
      <td className={tdCls}>
        <StatusLabel tone={stateTone[repo.state]} className="capitalize">
          {repo.state}
        </StatusLabel>
        {repo.errorMessage && (
          <p className="mt-0.5 max-w-[220px] text-[11px] text-zinc-400 dark:text-zinc-500">
            {repo.errorMessage}
          </p>
        )}
      </td>
      <td className={`max-w-[220px] ${tdCls}`}>
        {repo.commitSha ? (
          <>
            <span className={cellMonoCls}>{repo.commitSha}</span>
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
      <td className={`${tdCls} text-xs text-zinc-500 dark:text-zinc-400`}>
        {repo.pushedAtMs != null ? fmtAgo(repo.pushedAtMs) : "–"}
      </td>
      <td className={`${tdCls} text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300`}>
        {repo.openIssues ?? "–"}
      </td>
      <td className={`${tdCls} text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300`}>
        {repo.openPrs ?? "–"}
      </td>
      <td className={`max-w-[200px] ${tdCls}`}>
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
    <p className={footnoteCls}>
      GitHub API quota:
      <span className={`font-mono tabular-nums ${low ? "text-amber-500" : ""}`}>
        {" "}
        {known ? `${remaining}/${limit}` : "n/a"}
      </span>
      {rate.resetMs != null && <> · resets {fmtClock(rate.resetMs)}</>}
    </p>
  );
}
