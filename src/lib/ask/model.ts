/**
 * Ask DevPulse — a grounded, read-only question/answer surface over the
 * monitoring evidence DevPulse has *already* stored.
 *
 * This is not an agent. One submitted question produces at most one bounded
 * DeepSeek call whose input is a small, deterministically selected slice of
 * normalized DevPulse evidence, and whose output is a small validated object
 * citing only evidence ids DevPulse supplied. The model never receives a
 * database handle, a filesystem path, a command, a collector, a URL to call or
 * any tool — those simply do not exist on this code path.
 *
 * Every bound that keeps a question cheap lives here: question length, the
 * evidence window, the evidence count, per-item and total evidence text, the
 * output cap and the answer length.
 */

/** Hard cap on the submitted question (after trimming). */
export const ASK_MAX_QUESTION_LEN = 400;

/** Hard cap on the returned answer text. */
export const ASK_MAX_ANSWER_LEN = 1200;

/** Output cap for the single answer generation. */
export const ASK_MAX_OUTPUT_TOKENS = 600;

/** Maximum evidence items handed to the model. */
export const ASK_MAX_EVIDENCE = 24;

/** Maximum evidence items any single source may contribute (keeps one noisy
 *  source from crowding out everything else). */
export const ASK_MAX_PER_SOURCE = 6;

/** Maximum evidence ids the model may cite back. */
export const ASK_MAX_CITATIONS = 12;

/** Per-item text caps, so one long description cannot inflate the prompt. */
export const ASK_MAX_TITLE_LEN = 160;
export const ASK_MAX_DETAIL_LEN = 320;

/** Total evidence text budget across all items. */
export const ASK_MAX_EVIDENCE_CHARS = 6000;

/** Bounded windows a question may reach back over. Nothing longer is available. */
export const ASK_WINDOW_HOURS = { "24H": 24, "7D": 168, "30D": 720 } as const;
export type AskWindowKey = keyof typeof ASK_WINDOW_HOURS;

/** The window used when a question names no time range. */
export const ASK_DEFAULT_WINDOW: AskWindowKey = "24H";

/** Maximum active alerts / recently resolved alerts / projects / notifications
 *  considered as evidence candidates before ranking. */
export const ASK_MAX_ACTIVE_ALERTS = 15;
export const ASK_MAX_RESOLVED_ALERTS = 10;
export const ASK_MAX_PROJECTS = 8;
export const ASK_MAX_NOTIFICATIONS = 5;

/** Which monitoring domain a question is asking about. Determines which
 *  normalized readers contribute evidence. An empty topic set means the question
 *  named no domain, and the evidence layer falls back to the unified History
 *  timeline plus current alerts. */
export const ASK_TOPICS = [
  "alerts",
  "websites",
  "apis",
  "github",
  "ai",
  "security",
  "devices",
  "storage",
  "system",
  "projects",
] as const;
export type AskSourceTopic = (typeof ASK_TOPICS)[number];

/** Where one evidence item came from. Rendered as a chip in the UI. */
export type AskEvidenceKind =
  | "alert"
  | "event"
  | "project"
  | "ai_usage"
  | "notification";

/** One bounded, model-facing evidence item. `id` is request-local (E1, E2, …)
 *  and is the only way the model may refer back to anything. */
export type AskEvidence = {
  id: string;
  kind: AskEvidenceKind;
  /** Timeline source, or the layer that produced it (alert/project/…). */
  source: string;
  /** Epoch ms, or null for state that has no single timestamp. */
  ts: number | null;
  title: string;
  detail: string;
};

/** The validated question plus everything the evidence layer derives from it. */
export type AskQuery = {
  /** Trimmed, whitespace-normalized question. Still untrusted data. */
  question: string;
  /** Matched domains; empty means "no domain named". */
  topics: AskSourceTopic[];
  window: AskWindowKey;
  windowHours: number;
  /** True when the question asks about alerts that have since cleared. */
  includeResolved: boolean;
};

/** The validated model answer. `evidenceIds` are always a subset of the ids
 *  DevPulse supplied — unknown ids are dropped before this is built. */
export type AskAnswer = {
  answer: string;
  evidenceIds: string[];
  insufficientEvidence: boolean;
};
