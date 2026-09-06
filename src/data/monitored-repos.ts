/**
 * Initial GitHub repositories for health monitoring.
 *
 * This list is now SEED DATA ONLY: on first run the settings layer migrates it
 * into the persisted `monitored_repositories` table (see src/lib/settings/storage.ts),
 * which is then the single source of truth for what gets queried. Editing this
 * file no longer changes monitoring once settings have been seeded — use the
 * /settings UI instead. It remains the fallback set when the settings DB is
 * unavailable.
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
