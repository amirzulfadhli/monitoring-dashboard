/**
 * Orchestration for "Explain this alert".
 *
 * Loads one alert by fingerprint, builds a bounded evidence window, serves a
 * cached explanation for the same unchanged occurrence when fresh, and otherwise
 * runs exactly one (single-flighted) instrumented DeepSeek call through
 * callDeepSeek — so every explanation keeps appearing in AI Usage. On model or
 * validation failure the last good explanation for that alert is preserved and
 * nothing malformed is persisted or shown.
 *
 * Cost controls: explanations never auto-run (only an explicit user click hits
 * this), are cached per occurrence for ~20 min, are single-flighted, and send
 * only a small prioritized window (~<=20 events) with a concise output cap.
 */

import { callDeepSeek, DEEPSEEK_PROVIDER } from "../../monitoring/deepseek";
import { estimatedCostUsd } from "../../monitoring/ai-pricing";
import { readAlerts } from "../storage";
import type { AlertRecord } from "../model";
import { buildExplainEvidence } from "./evidence";
import { validateExplain } from "./validate";
import {
  EXPLAIN_CACHE_TTL_MS,
  EXPLAIN_MAX_OUTPUT_TOKENS,
  EXPLAIN_VERSION_BUCKET_MS,
  type AlertExplanation,
} from "./model";
import {
  persistExplain,
  readExplain,
  type StoredExplanation,
} from "./storage";

/** DeepSeek provider-reported model + measured usage, kept to what is useful. */
export type ExplainUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

const SYSTEM_PROMPT = `You are DevPulse's alert analyst. Given ONE DevPulse alert and a small window of nearby structured monitoring evidence, produce a concise, grounded explanation of that alert.

The evidence window is centered on the alert's first occurrence. Only events inside this window are supplied.

Hard rules:
- Explain using ONLY the supplied evidence. Never invent missing events, unobserved causes, or reasons.
- Distinguish correlation from causation. Do not present a nearby but unrelated event as the cause.
- Do NOT claim a compromise, breach, or security incident unless the evidence directly shows it.
- If the evidence is insufficient to name a cause, set "likelyCause" to null, use "low" or "medium" confidence, and say so in the summary.
- Every item in "evidence" MUST reference an "eventId" from the supplied evidence events. Do not cite anything not supplied.
- Set "confidence" honestly relative to how strongly the supplied evidence supports the explanation. Do not imply certainty beyond the evidence.
- Never expose chain-of-thought; return conclusions only.

Respond with a single JSON object and nothing else (no markdown fences, no prose), matching exactly:
{"summary":"<1-3 sentences>","likelyCause":"<string or null>","confidence":"low"|"medium"|"high","evidence":[{"eventId":"<an eventId from the supplied evidence>","relevance":"<why this event matters>"}],"checks":["<short action to verify>"]}

Constraints:
- "evidence": 0 to 5 items.
- "checks": 0 to 5 items.
- Keep the summary and likelyCause concise.`;

/** Compact model-facing form of one evidence event (no metadata). */
function toPromptEvent(e: { id: string; ts: number; source: string; type: string; severity?: string | null; title: string; description: string }) {
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

function buildMessages(
  a: AlertRecord,
  window: { start: number; end: number; center: number },
  evidence: ReturnType<typeof buildExplainEvidence>["events"],
  now: number,
) {
  const payload = {
    alert: {
      fingerprint: a.fingerprint,
      source: a.source,
      severity: a.severity,
      title: a.title,
      message: a.message,
      status: a.status,
      firstSeenAt: new Date(a.firstSeenAt).toISOString(),
      lastSeenAt: new Date(a.lastSeenAt).toISOString(),
    },
    window: {
      start: new Date(window.start).toISOString(),
      end: new Date(window.end).toISOString(),
      generatedAt: new Date(now).toISOString(),
    },
    eventCount: evidence.length,
    events: evidence.map(toPromptEvent),
  };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

function usageFrom(result: {
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}): ExplainUsage {
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

/** Occurrence/version key: recompute when severity/status or the last-seen
 * 10-minute bucket changes materially. lastSeenAt advances as the engine
 * re-evaluates a sustained alert, so it is coarse-bucketed here. */
export function versionKeyOf(a: AlertRecord): string {
  const bucket = Math.floor(a.lastSeenAt / EXPLAIN_VERSION_BUCKET_MS);
  return `${a.fingerprint}|${a.severity}|${a.status}|${bucket}`;
}

function findAlert(fingerprint: string): AlertRecord | null {
  return readAlerts("all").find((x) => x.fingerprint === fingerprint) ?? null;
}

export type ExplainResult =
  | { ok: true; cached: boolean; stored: StoredExplanation }
  | {
      ok: false;
      reason: "missing_key" | "deepseek_error" | "invalid_output";
      previous: StoredExplanation | null;
    };

/** Single-flight per fingerprint so concurrent clicks collapse to one call. */
const inflight = new Map<string, Promise<ExplainResult>>();

function keyAvailable() {
  return !!process.env.DEEPSEEK_API_KEY;
}

function toStored(p: {
  fingerprint: string;
  versionKey: string;
  createdAt: number;
  explanation: AlertExplanation;
  evidenceEventIds: string[];
  model: string | null;
  usage: ExplainUsage | null;
}): StoredExplanation {
  return { ...p, usage: p.usage };
}

async function computeFresh(
  a: AlertRecord,
  versionKey: string,
): Promise<ExplainResult> {
  if (!keyAvailable()) {
    return { ok: false, reason: "missing_key", previous: readExplain(a.fingerprint) };
  }

  const now = Date.now();
  const { events, window } = buildExplainEvidence(a, now);
  const evidenceEventIds = events.map((e) => e.id);

  const messages = buildMessages(a, window, events, now);
  const result = await callDeepSeek({
    messages,
    maxTokens: EXPLAIN_MAX_OUTPUT_TOKENS,
    // Model left unset -> the wrapper's default lower-cost model is used.
  });

  if (!result.ok || result.content == null) {
    return { ok: false, reason: "deepseek_error", previous: readExplain(a.fingerprint) };
  }

  const validated = validateExplain(result.content, evidenceEventIds);
  if (!validated.ok) {
    return { ok: false, reason: "invalid_output", previous: readExplain(a.fingerprint) };
  }

  const stored = toStored({
    fingerprint: a.fingerprint,
    versionKey,
    createdAt: Date.now(),
    explanation: validated.explanation,
    evidenceEventIds,
    model: result.model,
    usage: usageFrom(result),
  });
  persistExplain(stored);
  return { ok: true, cached: false, stored };
}

/**
 * Explain one alert. Returns null when the alert does not exist (route -> 404).
 * Serves a fresh cached explanation for the same occurrence (no model call),
 * otherwise runs one single-flighted analysis. Never throws.
 */
export async function explainAlert(
  fingerprint: string,
): Promise<ExplainResult | null> {
  const a = findAlert(fingerprint);
  if (!a) return null;

  const versionKey = versionKeyOf(a);
  const existing = readExplain(fingerprint);
  if (
    existing &&
    existing.versionKey === versionKey &&
    Date.now() - existing.createdAt < EXPLAIN_CACHE_TTL_MS
  ) {
    return { ok: true, cached: true, stored: existing };
  }

  if (inflight.has(fingerprint)) return inflight.get(fingerprint)!;
  const job = computeFresh(a, versionKey).finally(() => {
    inflight.delete(fingerprint);
  });
  inflight.set(fingerprint, job);
  return job;
}
