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
  { label: "APIs", href: "/apis" },
  { label: "AI Usage", href: "/ai-usage" },
  { label: "Websites", href: "/websites" },
  { label: "GitHub", href: "/github" },
  { label: "Projects" },
  { label: "Servers" },
  { label: "Database" },
  { label: "Devices", href: "/devices" },
  { label: "Security", href: "/security" },
  { label: "Alerts", href: "/alerts" },
  { label: "History", href: "/history" },
  { label: "Settings", href: "/settings" },
];
