/**
 * Intelligence orchestration: turns a bounded slice of DevPulse evidence into a
 * grounded operational brief via the existing instrumented DeepSeek wrapper.
 *
 * Cost controls live here:
 *  - Evidence is capped (~50) and prioritized before anything is sent.
 *  - Output is capped (MAX_OUTPUT_TOKENS).
 *  - A completed analysis is cached for CACHE_TTL_MS; requests inside that
 *    window reuse it without another model call.
 *  - A single-flight guard collapses concurrent duplicate analyses into one.
 *  - Analysis only ever runs here — nothing triggers it automatically on page
 *    load, polling, telemetry update, or alert evaluation. The API exposes a
 *    single fixed action with no prompt passthrough.
 *
 * Every live call flows through callDeepSeek, so model/tokens/latency/cost keep
 * appearing in AI Usage. On any model/validation failure the previous good
 * analysis is preserved and no malformed output is persisted or shown.
 */

import { callDeepSeek, DEEPSEEK_PROVIDER } from "../monitoring/deepseek";
import { estimatedCostUsd } from "../monitoring/ai-pricing";
import { buildTimeline } from "../history";
import {
  ANALYSIS_WINDOW_HOURS,
  CACHE_TTL_MS,
  MAX_EVIDENCE_EVENTS,
  MAX_OUTPUT_TOKENS,
  type EvidenceEventInput,
  type IntelligenceAnalysis,
} from "./model";
import { selectEvidence } from "./select";
import { validateAnalysis } from "./validate";
import {
  persistAnalysis,
  readLatest,
  type PersistedAnalysis,
} from "./storage";

const RANGE = "24H" as const; // V1 window is fixed to the last 24 hours.

const SYSTEM_PROMPT = `You are DevPulse's operational intelligence analyst. You analyze ONLY the supplied structured DevPulse monitoring evidence covering the last 24 hours, and you return a concise operational brief.

Hard rules:
- Base every conclusion only on the supplied evidence. Never invent causes, missing monitoring data, workflow details, or security incidents that the evidence does not support.
- Distinguish correlation from causation. Do not present an observed correlation as a proven cause.
- If the evidence is insufficient to judge, say so clearly and keep the overall status "normal" rather than guessing.
- Every finding MUST cite at least one evidenceEventId from the supplied evidence. A finding with no supporting event id is forbidden.
- Do not request or emit chain-of-thought. Return only conclusions and evidence references.

Respond with a single JSON object and nothing else (no markdown fences, no prose) matching exactly this shape:
{"status":"normal"|"attention"|"critical","summary":"<1-3 concise sentences>","findings":[{"severity":"info"|"warning"|"critical","title":"<short>","explanation":"<why, tied to evidence>","evidenceEventIds":["<event id from the evidence>"]}],"recommendations":["<short actionable suggestion>"]}

Constraints:
- findings: 0 to ${5} items.
- recommendations: 0 to ${5} items.
- Keep the summary brief. Prefer a few high-value findings over exhaustive lists.`;

/** Compact, model-facing serialization of one evidence event (no metadata). */
function toPromptEvent(e: EvidenceEventInput) {
  return {
    id: e.id,
    at: new Date(e.ts).toISOString(),
    source: e.source,
    type: e.type,
    ...(e.severity ? { severity: e.severity } : {}),
    title: e.title,
    description: e.description,
  };
}

/** Build the fixed system + user messages for one analysis run. */
function buildMessages(evidence: EvidenceEventInput[], now: number) {
  const payload = {
    window: `last ${ANALYSIS_WINDOW_HOURS} hours`,
    analyzedAt: new Date(now).toISOString(),
    eventCount: evidence.length,
    events: evidence.map(toPromptEvent),
  };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** Metadata surfaced with a report (from the wrapper's measured usage). */
export type UsageMeta = {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

/** State surfaced to the browser. `analysis` is null until one has run. */
export type IntelligenceReport = {
  available: boolean; // DEEPSEEK_API_KEY present -> analysis is possible now
  windowHours: number;
  lastAnalyzedAt: number | null; // epoch ms
  fresh: boolean; // last analysis is within the cache window
  analysis: IntelligenceAnalysis | null;
  model: string | null;
  usage: UsageMeta | null;
  evidenceCount: number;
};

const keyAvailable = () => !!process.env.DEEPSEEK_API_KEY;

function usageFrom(
  result: {
    model: string;
    usage: { inputTokens: number | null; outputTokens: number | null };
  },
): UsageMeta {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    estimatedCostUsd: estimatedCostUsd({
      provider: DEEPSEEK_PROVIDER,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: null,
    }),
  };
}

function buildReport(p: PersistedAnalysis | null): IntelligenceReport {
  const now = Date.now();
  const fresh = p != null && now - p.ts < CACHE_TTL_MS;
  return {
    available: keyAvailable(),
    windowHours: ANALYSIS_WINDOW_HOURS,
    lastAnalyzedAt: p?.ts ?? null,
    fresh,
    analysis: p?.analysis ?? null,
    model: p?.model ?? null,
    usage: p?.usage ?? null,
    evidenceCount: p?.evidenceCount ?? 0,
  };
}

/** Read-only state for GET: reflects the latest persisted analysis, never runs a model call. */
export function getState(): IntelligenceReport {
  return buildReport(readLatest());
}

export type AnalyzeResult =
  | { ok: true; computed: boolean; report: IntelligenceReport }
  | {
      ok: false;
      reason: "missing_key" | "deepseek_error" | "invalid_output";
      report: IntelligenceReport;
    };

/** Single-flight guard: at most one live analysis is in progress at a time. */
let inflight: Promise<AnalyzeResult> | null = null;

/** A locally-synthesized, evidence-empty analysis (no model call). */
function insufficientEvidenceResult(): AnalyzeResult {
  const now = Date.now();
  const analysis: IntelligenceAnalysis = {
    status: "normal",
    summary:
      "Insufficient evidence in the last 24 hours to analyze — no monitoring events were recorded.",
    findings: [],
    recommendations: [],
  };
  persistAnalysis({
    ts: now,
    windowHours: ANALYSIS_WINDOW_HOURS,
    analysis,
    evidenceEventIds: [],
    evidenceCount: 0,
    model: null,
    usage: null,
  });
  return { ok: true, computed: true, report: buildReport(readLatest()) };
}

async function computeFresh(): Promise<AnalyzeResult> {
  const now = Date.now();

  if (!keyAvailable()) {
    return { ok: false, reason: "missing_key", report: buildReport(readLatest()) };
  }

  // Gather + bound the evidence from the unified History timeline.
  const timeline = buildTimeline(RANGE);
  const evidence = selectEvidence(timeline, MAX_EVIDENCE_EVENTS);
  const evidenceIds = evidence.map((e) => e.id);

  // No events at all -> there is genuinely nothing to reason over. Persist an
  // honest "insufficient evidence" result instead of paying for a hollow call.
  if (evidence.length === 0) {
    return insufficientEvidenceResult();
  }

  const messages = buildMessages(evidence, now);
  const result = await callDeepSeek({
    messages,
    maxTokens: MAX_OUTPUT_TOKENS,
    // Model left unset -> the wrapper's default lower-cost model is used.
  });

  if (!result.ok || result.content == null) {
    return { ok: false, reason: "deepseek_error", report: buildReport(readLatest()) };
  }

  const validated = validateAnalysis(result.content, evidenceIds);
  if (!validated.ok) {
    // Never surface/persist malformed model output.
    return { ok: false, reason: "invalid_output", report: buildReport(readLatest()) };
  }

  const usage = usageFrom(result);
  persistAnalysis({
    ts: Date.now(),
    windowHours: ANALYSIS_WINDOW_HOURS,
    analysis: validated.analysis,
    evidenceEventIds: evidenceIds,
    evidenceCount: evidence.length,
    model: result.model,
    usage,
  });
  return { ok: true, computed: true, report: buildReport(readLatest()) };
}

/**
 * Run (or reuse) an analysis. Returns the cached analysis when one is fresh —
 * no model call. Otherwise runs exactly one (single-flighted) analysis. Never
 * throws. Analysis is only triggered by an explicit user action reaching this
 * function; there is no automatic cadence.
 */
export async function analyze(): Promise<AnalyzeResult> {
  const latest = readLatest();
  if (latest && Date.now() - latest.ts < CACHE_TTL_MS) {
    // Fresh cache hit — reuse it, no model call.
    return { ok: true, computed: false, report: buildReport(latest) };
  }
  if (inflight) return inflight; // collapse a concurrent duplicate into the running one.
  inflight = computeFresh().finally(() => {
    inflight = null;
  });
  return inflight;
}
