export type NavItem = {
  label: string;
  // Present only for routed pages. Items without href render inert (muted).
  href?: string;
};

// Dashboard sections. Items without an href are inert until their page exists.
export const navSections: NavItem[] = [
  { label: "Overview", href: "/" },
  { label: "Network", href: "/network" },
  { label: "APIs", href: "/apis" },
  { label: "AI Usage", href: "/ai-usage" },
  { label: "Websites", href: "/websites" },
  { label: "GitHub", href: "/github" },
  { label: "Projects", href: "/projects" },
  { label: "Servers" },
  { label: "Database" },
  { label: "Devices", href: "/devices" },
  { label: "Storage", href: "/storage" },
  { label: "Security", href: "/security" },
  { label: "Alerts", href: "/alerts" },
  { label: "Notifications", href: "/notifications" },
  { label: "History", href: "/history" },
  { label: "Daily Brief", href: "/brief" },
  { label: "Ask DevPulse", href: "/ask" },
  { label: "Settings", href: "/settings" },
];
