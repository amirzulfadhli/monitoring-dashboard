import { getEnabledRepos } from "@/lib/settings/service";
import { type MonitoredRepo } from "@/data/monitored-repos";

// A bounded timeout so a hung upstream never stalls a poll indefinitely.
const HTTP_TIMEOUT_MS = 8000;
// Server freshness window. The page polls ~60s, so this collapses concurrent
// or near-simultaneous requests into a single GitHub fetch run.
const FRESH_MS = 60_000;
const GITHUB_BASE = "https://api.github.com";

export type RepoState =
  | "healthy"
  | "attention"
  | "running"
  | "unavailable";

export type GitHubError =
  | "missing_token"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "timeout"
  | "network"
  | "api";

/** Safe human phrasing for an error — never raw GitHub body / stack traces. */
const ERROR_TEXT: Record<GitHubError, string> = {
  missing_token: "GITHUB_TOKEN is not configured",
  unauthorized: "GitHub rejected the token",
  forbidden: "Access to this repository is forbidden",
  rate_limited: "GitHub API rate limit exhausted",
  not_found: "Repository not found",
  timeout: "GitHub request timed out",
  network: "Could not reach GitHub",
  api: "GitHub API error",
};

// Terminal workflow conclusions that mean the latest run did not succeed.
const UNSUCCESSFUL_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "startup_failure",
  "action_required",
]);
const RUNNING_STATUSES = new Set(["queued", "in_progress"]);

export type RepoSnapshot = {
  key: string;
  displayName: string;
  owner: string;
  repo: string;
  state: RepoState;
  error: GitHubError | null;
  errorMessage: string | null;
  visibility: "public" | "private" | null;
  defaultBranch: string | null;
  stars: number | null;
  forks: number | null;
  pushedAtMs: number | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitDateMs: number | null;
  openIssues: number | null;
  openPrs: number | null;
  hasWorkflow: boolean;
  workflowName: string | null;
  workflowStatus: string | null;
  workflowConclusion: string | null;
  workflowBranch: string | null;
  workflowUpdatedAtMs: number | null;
  checkedAtMs: number;
};

export type RateLimitInfo = {
  remaining: number | null;
  limit: number | null;
  resetMs: number | null;
};

export type GitHubResult = {
  auth: { configured: boolean };
  rate: RateLimitInfo;
  repos: RepoSnapshot[];
  counts: {
    monitored: number;
    healthy: number;
    attention: number;
    running: number;
    unavailable: number;
  };
  checkedAtMs: number;
};

type Rate = { remaining: number | null; limit: number | null; reset: number | null };

function recordRate(headers: Headers, rate: Rate) {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining !== null) rate.remaining = Number(remaining);
  if (limit !== null) rate.limit = Number(limit);
  // Header value is a unix epoch in seconds; we store epoch ms.
  if (reset !== null) rate.reset = Number(reset) * 1000;
}

type Fetched<T> =
  | { ok: true; data: T }
  | { ok: false; error: GitHubError };

async function gh<T>(
  path: string,
  token: string | null,
  rate: Rate,
): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${GITHUB_BASE}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    recordRate(res.headers, rate);
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    if (res.status === 401) return { ok: false, error: "unauthorized" };
    if (res.status === 403) {
      // A 403 with quota exhausted is a rate limit, not a permission denial.
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        return { ok: false, error: "rate_limited" };
      }
      return { ok: false, error: "forbidden" };
    }
    if (res.status === 404) return { ok: false, error: "not_found" };
    return { ok: false, error: "api" };
  } catch (e) {
    const err = e as Error & { name?: string };
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, error: timedOut ? "timeout" : "network" };
  }
}

/** GitHub repo payload fields we rely on. */
type RepoPayload = {
  name: string;
  private: boolean;
  default_branch: string | null;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string | null;
  open_issues_count: number;
};

type CommitPayload = {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
};

type PullPayload = Array<{ number: number }>;
type ActionsPayload = {
  workflow_runs: Array<{
    id: number;
    name: string | null;
    status: string | null;
    conclusion: string | null;
    head_branch: string | null;
    updated_at: string | null;
  }>;
};

const toMs = (iso: string | null | undefined): number | null =>
  iso ? Date.parse(iso) || null : null;

/** Query one configured repository. Never throws — every failure degrades. */
async function snapshotRepo(
  cfg: MonitoredRepo,
  token: string | null,
  rate: Rate,
): Promise<RepoSnapshot> {
  const base: RepoSnapshot = {
    key: `${cfg.owner}/${cfg.repo}`,
    displayName: cfg.displayName,
    owner: cfg.owner,
    repo: cfg.repo,
    state: "unavailable",
    error: null,
    errorMessage: null,
    visibility: null,
    defaultBranch: null,
    stars: null,
    forks: null,
    pushedAtMs: null,
    commitSha: null,
    commitMessage: null,
    commitAuthor: null,
    commitDateMs: null,
    openIssues: null,
    openPrs: null,
    hasWorkflow: false,
    workflowName: null,
    workflowStatus: null,
    workflowConclusion: null,
    workflowBranch: null,
    workflowUpdatedAtMs: null,
    checkedAtMs: Date.now(),
  };

  if (!token) {
    return { ...base, error: "missing_token", errorMessage: ERROR_TEXT.missing_token };
  }

  // Repo is the source of truth. If it cannot be read (auth/404/etc.) the
  // other endpoints would fail the same way, so stop early and save quota.
  const repoRes = await gh<RepoPayload>(
    `/repos/${cfg.owner}/${cfg.repo}`,
    token,
    rate,
  );
  if (!repoRes.ok) {
    return {
      ...base,
      error: repoRes.error,
      errorMessage: ERROR_TEXT[repoRes.error],
    };
  }
  const repo = repoRes.data;

  // Independent secondary reads run concurrently; each is isolated so one
  // empty/disabled aspect (no PRs, no runs) never fails the whole snapshot.
  const [commitRes, pullsRes, actionsRes] = await Promise.allSettled([
    gh<CommitPayload[]>(`/repos/${cfg.owner}/${cfg.repo}/commits?per_page=1`, token, rate),
    gh<PullPayload>(`/repos/${cfg.owner}/${cfg.repo}/pulls?state=open&per_page=100`, token, rate),
    gh<ActionsPayload>(`/repos/${cfg.owner}/${cfg.repo}/actions/runs?per_page=1`, token, rate),
  ]);

  const commit =
    commitRes.status === "fulfilled" && commitRes.value.ok && commitRes.value.data[0]
      ? commitRes.value.data[0]
      : null;

  const openPrs =
    pullsRes.status === "fulfilled" && pullsRes.value.ok
      ? pullsRes.value.data.length
      : null;

  const actions =
    actionsRes.status === "fulfilled" && actionsRes.value.ok
      ? actionsRes.value.data.workflow_runs[0] ?? null
      : null;

  // GitHub's open_issues_count INCLUDES pull requests. Subtracting the open
  // PR count yields the true open-issue figure without double-counting. Only
  // reported when the PR count is known.
  const openIssues =
    openPrs !== null
      ? Math.max(0, repo.open_issues_count - openPrs)
      : null;

  // Deterministic status derived from the latest workflow run.
  let state: RepoState = "healthy";
  if (actions) {
    const status = actions.status ?? "";
    const conclusion = actions.conclusion ?? "";
    if (RUNNING_STATUSES.has(status)) {
      state = "running";
    } else if (UNSUCCESSFUL_CONCLUSIONS.has(conclusion)) {
      state = "attention";
    }
    // Completed with success (or a neutral conclusion) stays healthy.
  }

  return {
    ...base,
    state,
    visibility: repo.private ? "private" : "public",
    defaultBranch: repo.default_branch,
    stars: repo.stargazers_count || null,
    forks: repo.forks_count || null,
    pushedAtMs: toMs(repo.pushed_at),
    commitSha: commit ? commit.sha.slice(0, 7) : null,
    commitMessage: commit ? commit.commit.message : null,
    commitAuthor: commit
      ? (commit.author?.login ?? commit.commit.author?.name ?? null)
      : null,
    commitDateMs: commit ? toMs(commit.commit.author?.date) : null,
    openIssues,
    openPrs,
    hasWorkflow: !!actions,
    workflowName: actions?.name ?? null,
    workflowStatus: actions?.status ?? null,
    workflowConclusion: actions?.conclusion ?? null,
    workflowBranch: actions?.head_branch ?? null,
    workflowUpdatedAtMs: actions ? toMs(actions.updated_at) : null,
  };
}

async function collect(): Promise<GitHubResult> {
  const rate: Rate = { remaining: null, limit: null, reset: null };
  const token = process.env.GITHUB_TOKEN || null;
  const checkedAtMs = Date.now();

  const repos = await Promise.all(
    getEnabledRepos().map((cfg) => snapshotRepo(cfg, token, rate)),
  );

  const counts = { monitored: repos.length, healthy: 0, attention: 0, running: 0, unavailable: 0 };
  for (const r of repos) counts[r.state]++;

  return {
    auth: { configured: !!token },
    rate: { remaining: rate.remaining, limit: rate.limit, resetMs: rate.reset },
    repos,
    counts,
    checkedAtMs,
  };
}

// Single-flight + freshness guard so concurrent/near-simultaneous requests
// share one GitHub fetch instead of each triggering a duplicate quota spend.
let cache: { at: number; promise: Promise<GitHubResult> } | null = null;

export function getGitHubResult(): Promise<GitHubResult> {
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.promise;
  cache = { at: now, promise: collect() };
  return cache.promise;
}
