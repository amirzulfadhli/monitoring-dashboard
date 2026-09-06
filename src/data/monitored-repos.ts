/**
 * Configured GitHub repositories for health monitoring.
 *
 * V1 has no settings UI — edit this list to add or remove repositories. Only
 * repositories listed here are ever queried; the GitHub API never accepts
 * user-supplied owner/repo names from the browser. Configuration is isolated
 * from the monitoring logic so more repositories can be added later without
 * touching it.
 */
export type MonitoredRepo = {
  owner: string;
  repo: string;
  /** Human label shown in the UI. */
  displayName: string;
};

export const monitoredRepos: MonitoredRepo[] = [
  { owner: "amirzulfadhli", repo: "devpulse", displayName: "DevPulse" },
];
