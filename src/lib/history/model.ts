/**
 * Normalized timeline event model for the unified History page.
 *
 * Every persisted monitoring source is reduced into this single shape server-side
 * so components never know source-specific table layouts. Events are plain,
 * machine-readable records sized for later correlation (DeepSeek reasoning over
 * the evidence layer) while deliberately carrying NO sensitive content — never
 * prompts, completions, issue/PR bodies, or workflow logs.
 */

/** Which monitor produced an event. `network` is grouped with `system` in the UI. */
export type TimelineSource =
  | "system"
  | "network"
  | "website"
  | "api"
  | "github"
  | "ai"
  | "security"
  | "alert";

/** Optional importance signal; undefined means informational/normal. */
export type TimelineSeverity = "info" | "warning" | "critical";

export type TimelineMetadata = Record<
  string,
  string | number | boolean | null
>;

export type TimelineEvent = {
  /** Stable-ish key so the client can reconcile rows: source:type:subject:ts. */
  id: string;
  /** Epoch ms when the underlying persisted event happened. */
  ts: number;
  source: TimelineSource;
  /** Source-specific kind, e.g. website_state | workflow_changed | alert_active. */
  type: string;
  severity?: TimelineSeverity;
  /** Short human title. */
  title: string;
  /** Concise supporting text. */
  description: string;
  /** Machine-readable correlation fields only (see builders). Never sensitive. */
  metadata?: TimelineMetadata;
};

/** Ranges the timeline can span. */
export const HISTORY_RANGES = {
  "24H": 86_400_000,
  "7D": 604_800_000,
  "30D": 2_592_000_000,
} as const;

export type HistoryRangeKey = keyof typeof HISTORY_RANGES;

/** Source keys accepted by the API for filtering a request up front. */
export const HISTORY_SOURCES = [
  "all",
  "system",
  "website",
  "api",
  "github",
  "ai",
  "security",
  "alert",
] as const;
export type HistorySourceKey = (typeof HISTORY_SOURCES)[number];
