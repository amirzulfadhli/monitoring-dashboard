/**
 * Overview layout model (Task 31).
 *
 * The Overview page is a fixed set of sections, not a widget canvas. This module
 * owns the one thing that is customizable about it: which of those sections are
 * shown, and in what order.
 *
 * It is deliberately pure — no DB, no React, no fetch. Persistence lives in
 * lib/settings (the existing `app_settings` key/value area), and rendering lives
 * in the Overview page, which maps a section id to a component through an
 * explicit switch. Nothing here is ever interpreted as a component name, a path,
 * a URL or code: a section id only ever indexes the registry below.
 *
 * Ordering is "move up / move down", not drag-and-drop: the stored value is an
 * explicit ordered list, so the layout is fully described by one array.
 */

/**
 * Registry of the sections that actually exist on the Overview, in the order
 * they render by default. This array *is* the default layout: adding an entry
 * here adds a section everywhere, with no schema migration.
 *
 * The page header (title, live status, freshness) is intentionally not in this
 * list — DevPulse always tells you what it is and whether it is up.
 */
export const DASHBOARD_SECTIONS = [
  {
    id: "metrics",
    label: "Live metrics",
    description: "Live CPU, memory and network rates, refreshed every few seconds.",
  },
  {
    id: "details",
    label: "System & network detail",
    description: "Host, OS, memory and interface rows from the latest sample.",
  },
  {
    id: "collectors",
    label: "Collector health",
    description: "Whether each background collector is running, stale or failing.",
  },
  {
    id: "projects",
    label: "Project summary",
    description: "Project count by health state. Appears only once a project exists.",
  },
  {
    id: "history",
    label: "Last 24 hours",
    description: "Averages and peaks from stored telemetry history.",
  },
  {
    id: "intelligence",
    label: "Intelligence brief",
    description: "The operational brief. Runs only when you ask it to.",
  },
] as const;

/** Stable ids — the only values a stored preference may contain. */
export type DashboardSectionId = (typeof DASHBOARD_SECTIONS)[number]["id"];

/** One customizable Overview section. */
export type DashboardSectionMeta = {
  id: DashboardSectionId;
  /** Control label in Settings. */
  label: string;
  /** One line explaining what the section shows. */
  description: string;
};

export const DASHBOARD_SECTION_IDS: readonly DashboardSectionId[] = DASHBOARD_SECTIONS.map(
  (s) => s.id,
);

/** One section's stored state. */
export type DashboardSection = {
  id: DashboardSectionId;
  visible: boolean;
};

/**
 * The persisted preference: an ordered list covering every registry section
 * exactly once. Array order is render order.
 */
export type DashboardLayout = {
  sections: DashboardSection[];
};

/** Whether a value is one of the known section ids. */
export function isDashboardSectionId(id: string): id is DashboardSectionId {
  return (DASHBOARD_SECTION_IDS as readonly string[]).includes(id);
}

/** Metadata for a section id, or undefined when it is not in the registry. */
export function dashboardSectionMeta(id: DashboardSectionId): DashboardSectionMeta | undefined {
  return DASHBOARD_SECTIONS.find((s) => s.id === id);
}

/** The default layout: registry order, every section shown. */
export function defaultDashboardLayout(): DashboardLayout {
  return { sections: DASHBOARD_SECTIONS.map((s) => ({ id: s.id, visible: true })) };
}

/** Read the `sections` array out of an unknown stored value. */
function sectionsOf(value: unknown): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const sections = (value as { sections?: unknown }).sections;
  return Array.isArray(sections) ? sections : null;
}

/**
 * Turn anything that came out of storage into a layout that is safe to render.
 *
 * Tolerant by design, because this is the untrusted-input path: the value may
 * have been hand-edited, written by an older release, or written by a release
 * that had a section this one does not. The rules are:
 *
 *   - a non-object value, a missing `sections` array, or nothing usable inside
 *     it falls back to the default layout (never an empty dashboard);
 *   - unknown ids are dropped, so no stored value can name a component;
 *   - duplicates keep their first entry;
 *   - a non-boolean `visible` is treated as shown;
 *   - a registry section missing from the stored list (added after the
 *     preference was saved) is appended, shown.
 */
export function normalizeDashboardLayout(value: unknown): DashboardLayout {
  const raw = sectionsOf(value);
  if (!raw) return defaultDashboardLayout();

  const seen = new Set<DashboardSectionId>();
  const sections: DashboardSection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, visible } = entry as { id?: unknown; visible?: unknown };
    if (typeof id !== "string" || !isDashboardSectionId(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    sections.push({ id, visible: visible !== false });
  }

  // Nothing storeable survived: treat the preference as absent rather than
  // rendering an empty Overview. (A deliberate "hide everything" is a complete
  // list whose entries are all `visible: false`, which is preserved below.)
  if (sections.length === 0) return defaultDashboardLayout();

  for (const meta of DASHBOARD_SECTIONS) {
    if (!seen.has(meta.id)) sections.push({ id: meta.id, visible: true });
  }

  return { sections };
}

/**
 * Strict check for a layout arriving over the API, whose error is shown to the
 * user. Unlike {@link normalizeDashboardLayout} this rejects rather than
 * repairs, so what gets persisted is always a complete, well-formed layout.
 */
export function validateDashboardLayout(value: unknown): string | null {
  const raw = sectionsOf(value);
  if (!raw) return "Layout must be an object with a 'sections' array.";

  const seen = new Set<DashboardSectionId>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return "Every section must be an object.";
    const { id, visible } = entry as { id?: unknown; visible?: unknown };
    if (typeof id !== "string" || !isDashboardSectionId(id)) {
      return "Unknown section id.";
    }
    if (typeof visible !== "boolean") return "Section visibility must be true or false.";
    if (seen.has(id)) return "Duplicate section id.";
    seen.add(id);
  }
  if (seen.size !== DASHBOARD_SECTION_IDS.length) {
    return "Layout must list every section exactly once.";
  }
  return null;
}

/** Whether a section would be rendered. Unknown ids are never visible. */
export function isSectionVisible(layout: DashboardLayout, id: DashboardSectionId): boolean {
  return layout.sections.some((s) => s.id === id && s.visible);
}

/** The ids to render, in order. Only known, shown sections appear. */
export function visibleSectionIds(layout: DashboardLayout): DashboardSectionId[] {
  return layout.sections.filter((s) => s.visible).map((s) => s.id);
}

/** Show or hide one section. Unknown ids leave the layout untouched. */
export function setSectionVisible(
  layout: DashboardLayout,
  id: DashboardSectionId,
  visible: boolean,
): DashboardLayout {
  if (!layout.sections.some((s) => s.id === id)) return layout;
  return {
    sections: layout.sections.map((s) => (s.id === id ? { id: s.id, visible } : s)),
  };
}

/**
 * The entry a move would swap with, or -1 when there is none.
 *
 * Only shown sections have a place on screen, so a move steps over hidden
 * entries: swapping past one would be a click with no visible effect.
 */
function neighbourIndex(
  layout: DashboardLayout,
  id: DashboardSectionId,
  direction: -1 | 1,
): number {
  const from = layout.sections.findIndex((s) => s.id === id);
  if (from < 0) return -1;
  for (let i = from + direction; i >= 0 && i < layout.sections.length; i += direction) {
    if (layout.sections[i].visible) return i;
  }
  return -1;
}

/** Whether "move up" (-1) or "move down" (1) would change anything. */
export function canMoveSection(
  layout: DashboardLayout,
  id: DashboardSectionId,
  direction: -1 | 1,
): boolean {
  return neighbourIndex(layout, id, direction) >= 0;
}

/** Swap a section with its nearest shown neighbour, in the given direction. */
export function moveSection(
  layout: DashboardLayout,
  id: DashboardSectionId,
  direction: -1 | 1,
): DashboardLayout {
  const from = layout.sections.findIndex((s) => s.id === id);
  const to = neighbourIndex(layout, id, direction);
  if (from < 0 || to < 0) return layout;

  const sections = [...layout.sections];
  [sections[from], sections[to]] = [sections[to], sections[from]];
  return { sections };
}
