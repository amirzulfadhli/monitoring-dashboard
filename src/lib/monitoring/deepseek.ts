import { persistAiUsage, type AiUsageRow } from "./ai-storage";
import { estimatedCostUsd } from "./ai-pricing";

/**
 * Small reusable, server-side wrapper around the DeepSeek Chat Completions API.
 * Every DevPulse-originated DeepSeek request should go through here so usage is
 * captured in one place.
 *
 * Only metadata is persisted — timestamp, model, token counts, latency, status.
 * Prompts, completions, request bodies and the API key are never persisted or
 * logged. The API key is read exclusively from DEEPSEEK_API_KEY; when it is
 * absent the wrapper degrades gracefully (returns an error, makes no network
 * call) and records nothing.
 */

const DEEPSEEK_BASE = "https://api.deepseek.com";
const HTTP_TIMEOUT_MS = 60_000;

export const DEEPSEEK_PROVIDER = "deepseek";

/** Max output cap for callers that leave it to the wrapper. */
export const DEFAULT_MAX_TOKENS = 1024;

export type DeepSeekMessage = { role: string; content: string };

export type DeepSeekRequest = {
  model?: string; // default deepseek-chat
  messages: DeepSeekMessage[];
  maxTokens?: number;
};

export type DeepSeekError =
  | "missing_key" // DEEPSEEK_API_KEY not configured — nothing attempted
  | "bad_request" // DeepSeek rejected the payload (4xx, other than auth)
  | "unauthorized" // key present but rejected
  | "server" // DeepSeek 5xx
  | "network"
  | "timeout"
  | "parse"; // response was not the expected JSON

export type DeepSeekCallResult = {
  ok: boolean;
  /** Provider-reported model id (never the requested alias). */
  model: string;
  /** Assistant text — returned for the caller, never persisted. */
  content: string | null;
  error: DeepSeekError | null;
  httpStatus: number | null;
  latencyMs: number | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    totalTokens: number | null;
  };
  requestId: string | null;
};

/** Chat-completion response fields we rely on. Everything else is ignored. */
type CompletionPayload = {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
};

/** Map an HTTP status to a coarse, safe classification — no raw bodies. */
function classifyStatus(status: number): DeepSeekError {
  if (status === 401 || status === 403) return "unauthorized";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Convert a partial payload into a safely-typed usage snapshot. */
function readUsage(payload: CompletionPayload) {
  const u = payload.usage;
  if (!u) {
    return {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
    };
  }
  const cached = u.prompt_cache_hit_tokens ?? null;
  return {
    inputTokens: u.prompt_tokens ?? null,
    outputTokens: u.completion_tokens ?? null,
    cachedTokens: cached,
    totalTokens: u.total_tokens ?? null,
  };
}

/**
 * Make one instrumented DeepSeek chat-completion request. Resolves without
 * throwing. When the API key is missing it fails fast with `missing_key` and
 * nothing is persisted.
 */
export async function callDeepSeek(
  req: DeepSeekRequest,
): Promise<DeepSeekCallResult> {
  const started = Date.now();
  const key = process.env.DEEPSEEK_API_KEY || null;
  if (!key) {
    return {
      ok: false,
      model: req.model || "deepseek-chat",
      content: null,
      error: "missing_key",
      httpStatus: null,
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
      },
      requestId: null,
    };
  }

  const requestedModel = req.model || "deepseek-chat";
  let res: Response;
  try {
    res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: req.messages,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error & { name?: string };
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const error: DeepSeekError = timedOut ? "timeout" : "network";
    return persistAndReturn({
      ok: false,
      model: requestedModel,
      content: null,
      error,
      httpStatus: null,
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
      },
      requestId: null,
    });
  }

  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return persistAndReturn({
      ok: false,
      model: requestedModel,
      content: null,
      error: classifyStatus(res.status),
      httpStatus: res.status,
      latencyMs,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
      },
      requestId: null,
    });
  }

  // Parse the body defensively — a malformed payload records a parse failure.
  let payload: CompletionPayload;
  try {
    payload = (await res.json()) as CompletionPayload;
  } catch {
    return persistAndReturn({
      ok: false,
      model: requestedModel,
      content: null,
      error: "parse",
      httpStatus: res.status,
      latencyMs,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
      },
      requestId: null,
    });
  }

  const usage = readUsage(payload);
  return persistAndReturn({
    ok: true,
    model: payload.model || requestedModel,
    content: payload.choices?.[0]?.message?.content ?? null,
    error: null,
    httpStatus: res.status,
    latencyMs,
    usage,
    requestId: payload.id ?? null,
  });
}

/** Build a persistence row and write it. Never throws. */
function persistAndReturn(result: DeepSeekCallResult): DeepSeekCallResult {
  const total =
    result.usage.totalTokens ??
    (result.usage.inputTokens != null && result.usage.outputTokens != null
      ? result.usage.inputTokens + result.usage.outputTokens
      : null);
  // Cost is only meaningful for completed calls; failures with no usage store null.
  const cost = result.ok
    ? estimatedCostUsd({
        provider: DEEPSEEK_PROVIDER,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedTokens: result.usage.cachedTokens,
      })
    : null;
  const row: AiUsageRow = {
    ts: Date.now(),
    provider: DEEPSEEK_PROVIDER,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedTokens: result.usage.cachedTokens,
    totalTokens: total,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    success: result.ok,
    errorType: result.error,
    requestId: result.requestId,
    estimatedCostUsd: cost,
  };
  try {
    persistAiUsage(row);
  } catch {
    // A persistence failure must never break a live call.
  }
  return result;
}
