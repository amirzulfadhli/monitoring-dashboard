/**
 * Initial HTTP/HTTPS targets for website monitoring.
 *
 * This list is now SEED DATA ONLY: on first run the settings layer migrates it
 * into the persisted `monitored_websites` table (see src/lib/settings/storage.ts),
 * which is then the single source of truth for what gets checked. Editing this
 * file no longer changes monitoring once settings have been seeded — use the
 * /settings UI instead. It remains the fallback set when the settings DB is
 * unavailable.
 */
export type MonitoredSite = {
  id: string;
  name: string;
  url: string;
  /** HTTP status that counts as Healthy. Defaults to 200 when omitted. */
  expectedStatus?: number;
};

export const monitoredSites: MonitoredSite[] = [
  // TODO: replace the placeholder below with real targets, e.g.
  // { id: "prod-api", name: "Production API", url: "https://api.mycompany.com", expectedStatus: 200 },
  // { id: "dashboard", name: "Dashboard", url: "https://app.mycompany.com" },
  { id: "example-com", name: "Example (placeholder)", url: "https://example.com" },
];
