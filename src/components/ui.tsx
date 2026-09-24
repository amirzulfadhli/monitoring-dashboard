/**
 * Shared UI primitives and class tokens.
 *
 * This is deliberately small: it holds only the shapes that were already
 * repeated across pages (page headers, panels, stat tiles, status indicators,
 * empty states, form controls, table cells) so those pages stay consistent
 * without each one carrying its own copy.
 *
 * Presentation only — nothing here fetches, polls or derives monitoring state.
 */

/* ------------------------------------------------------------------ *
 * Status semantics
 *
 * Five tones cover every state DevPulse already renders. Tones are mapped to
 * colour in exactly one place, and a tone is never the only signal: every use
 * pairs the dot with a text label.
 * ------------------------------------------------------------------ */

export type Tone = "good" | "warn" | "critical" | "info" | "neutral";

/** Dot colours. `neutral` is for "nothing wrong reported / unknown". */
export const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-zinc-300 dark:bg-zinc-600",
};

/** Text colours for tone-coloured labels. */
export const toneText: Record<Tone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
  neutral: "text-zinc-400 dark:text-zinc-500",
};

/** Filled badge treatment, for a tone that needs to stand out from body text. */
export const toneBadge: Record<Tone, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  warn: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  critical:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  info: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
  neutral:
    "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400",
};

/** A small status dot. Always decorative — the label carries the meaning. */
/**
 * Severity is the one mapping shared by more than one page (alerts, timeline
 * events), so it lives here rather than being repeated per file.
 */
export const severityTone: Record<"info" | "warning" | "critical", Tone> = {
  info: "info",
  warning: "warn",
  critical: "critical",
};

export function StatusDot({ tone, className = "h-2 w-2" }: { tone: Tone; className?: string }) {
  return <span className={`shrink-0 rounded-full ${className} ${toneDot[tone]}`} aria-hidden="true" />;
}

/** Dot plus label, for status cells in tables and detail rows. */
export function StatusLabel({
  tone,
  children,
  className = "",
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-200 ${className}`}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

/** A bordered pill, for a status that stands on its own (not in a table cell). */
export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${toneBadge[tone]}`}
    >
      <StatusDot tone={tone} className="h-1.5 w-1.5" />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

/** Page padding + section rhythm. Every route uses one of these two. */
export const pageCls = "space-y-6 p-4 md:p-6";
/** Narrow reading measure, for the single-question and brief pages. */
export const narrowPageCls = "mx-auto max-w-3xl space-y-6 p-4 md:p-6";

export const pageTitleCls = "text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50";
export const pageSubtitleCls = "mt-0.5 text-sm text-zinc-500 dark:text-zinc-400";

/** Small uppercase eyebrow — stat labels, section labels, field labels. */
export const labelCls = "text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500";

/** Timestamps and other quiet machine values. */
export const metaCls = "font-mono text-xs text-zinc-400 dark:text-zinc-500";

/** Supporting paragraph under a table or section. */
export const footnoteCls = "text-xs text-zinc-400 dark:text-zinc-500";

/** Muted body text. */
export const mutedCls = "text-sm text-zinc-500 dark:text-zinc-400";

/** Page title block. `meta` is the right-aligned slot (e.g. a timestamp). */
export function PageHeader({
  title,
  description,
  meta,
}: {
  title: string;
  description?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className={pageTitleCls}>{title}</h1>
        {description ? <p className={pageSubtitleCls}>{description}</p> : null}
      </div>
      {meta}
    </div>
  );
}

/**
 * A bordered section with a titled header. `padded={false}` is for panels whose
 * body is a table or a divided list that manages its own padding.
 */
export function Panel({
  title,
  hint,
  action,
  padded = true,
  className = "",
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  padded?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black ${className}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h2>
        {hint ? <p className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</p> : null}
        {action}
      </div>
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Data display
 * ------------------------------------------------------------------ */

/**
 * A muted metric tile: uppercase label, mono value, optional tone dot and
 * footnote. The value is always rendered as text — never a gauge.
 */
export function StatTile({
  label,
  value,
  unit,
  tone,
  foot,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: Tone;
  foot?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black">
      <p className={labelCls}>{label}</p>
      <p className="mt-3 flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
        {tone ? <StatusDot tone={tone} /> : null}
        {value}
        {unit ? (
          <span className="text-sm font-normal text-zinc-400 dark:text-zinc-500">{unit}</span>
        ) : null}
      </p>
      {foot ? <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">{foot}</p> : null}
    </div>
  );
}

/**
 * One presentation for "nothing to show yet". The wording distinguishes the
 * three cases (loading / unavailable / genuinely empty) — the box does not.
 */
export function EmptyState({
  title,
  message,
}: {
  title?: string;
  message: React.ReactNode;
}) {
  return (
    <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 text-center dark:border-zinc-800 dark:bg-black">
      {title ? (
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      ) : null}
      <p className={`text-sm text-zinc-400 dark:text-zinc-500 ${title ? "mt-1" : ""}`}>{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tables
 *
 * Shared classes rather than a data-grid component: each table keeps its own
 * columns, empty state and overflow width.
 * ------------------------------------------------------------------ */

export const tableWrapCls =
  "overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black";
export const tableCls = "w-full text-left text-sm";
export const theadRowCls =
  "border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500";
export const thCls = "px-4 py-2.5 font-medium";
export const trCls = "border-b border-zinc-100 last:border-0 dark:border-zinc-900";
export const tdCls = "px-4 py-3";
/** Mono secondary value inside a cell (hosts, hashes, counts, latency). */
export const cellMonoCls = "font-mono text-xs text-zinc-500 dark:text-zinc-400";
/** Muted metadata cell (timestamps, secondary explanations). */
export const cellMutedCls = "text-xs text-zinc-400 dark:text-zinc-500";

/* ------------------------------------------------------------------ *
 * Form controls
 * ------------------------------------------------------------------ */

export const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-black dark:text-zinc-100";

/** Same treatment as an input, but sized to its own content in a toolbar row. */
export const selectCls =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-black dark:text-zinc-100";

const btnDisabled = "disabled:cursor-not-allowed disabled:opacity-50";

/** Secondary action. */
export const btnCls = `rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 ${btnDisabled} dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800/60`;

/** Primary action. */
export const btnPrimary = `rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 ${btnDisabled} dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;

/** Low-emphasis inline action, for table rows. */
export const btnQuiet = `rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 ${btnDisabled} dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200`;

/** Small bordered action, for table rows and list items. */
export const btnSmall = `rounded border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 ${btnDisabled} dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200`;

/**
 * Segmented filter tab (Alerts, History). The selected tab also carries
 * `aria-pressed`, so the state is not signalled by fill colour alone.
 */
export function tabCls(on: boolean) {
  return `rounded-md px-3 py-1.5 text-[13px] font-medium ${
    on
      ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
  }`;
}

/**
 * A labelled control. The label wraps the control, so the association is native
 * and needs no generated id.
 */
export function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className={`${labelCls} block pb-1`}>{label}</span>
      {children}
    </label>
  );
}
