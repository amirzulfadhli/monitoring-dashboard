export type NavItem = {
  label: string;
  active?: boolean;
};

// Placeholder sections for the planned dashboard. Only "Overview" is routed
// for now; the rest are inert and render muted until their pages exist.
export const navSections: NavItem[] = [
  { label: "Overview", active: true },
  { label: "Network" },
  { label: "APIs" },
  { label: "AI Usage" },
  { label: "Websites" },
  { label: "GitHub" },
  { label: "Projects" },
  { label: "Servers" },
  { label: "Database" },
  { label: "Devices" },
  { label: "Security" },
  { label: "Alerts" },
  { label: "History" },
  { label: "Settings" },
];

export type Kpi = {
  id: string;
  label: string;
  value: string;
  unit?: string;
  delta: string;
  deltaDirection: "up" | "down" | "flat";
  status?: { tone: "good" | "warn" | "critical"; label: string };
};

export const overviewKpis: Kpi[] = [
  {
    id: "services",
    label: "Services online",
    value: "23",
    unit: "/ 24",
    delta: "1 new since yesterday",
    deltaDirection: "up",
    status: { tone: "good", label: "Healthy" },
  },
  {
    id: "alerts",
    label: "Active alerts",
    value: "0",
    delta: "No issues",
    deltaDirection: "flat",
    status: { tone: "good", label: "All clear" },
  },
  {
    id: "api-error",
    label: "API error rate",
    value: "0.12",
    unit: "%",
    delta: "down 0.04% vs 24h ago",
    deltaDirection: "down",
  },
  {
    id: "ai-tokens",
    label: "AI tokens today",
    value: "1.24",
    unit: "M",
    delta: "up 18% vs yesterday",
    deltaDirection: "up",
    status: { tone: "warn", label: "Trending up" },
  },
];
