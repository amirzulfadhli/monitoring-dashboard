export type NavItem = {
  label: string;
  // Present only for routed pages. Items without href render inert (muted).
  href?: string;
};

// Planned dashboard sections. Only "Overview" and "Network" are routed for
// now; the rest are inert until their pages exist.
export const navSections: NavItem[] = [
  { label: "Overview", href: "/" },
  { label: "Network", href: "/network" },
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
