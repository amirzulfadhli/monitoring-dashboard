/**
 * Configured HTTP/HTTPS targets for website monitoring.
 *
 * V1 has no settings UI — edit this list to add or remove targets. Only sites
 * listed here are ever checked; the API never accepts user-supplied URLs.
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
