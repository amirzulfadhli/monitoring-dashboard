/**
 * Provider/model cost table, isolated in one module so both the rates and the
 * formula are reviewable in a single place.
 *
 * ESTIMATED: these are static public list prices and are NOT authoritative. A
 * rate can change at any time, so every figure below is a best-effort estimate
 * for display only — never a bill. Unknown providers/models, or models without
 * an entry, yield null (no cost) rather than guessing. Nothing here calls out
 * to fetch live pricing.
 */

const PER_M = 1_000_000;

/**
 * DeepSeek V4-Flash list rates (USD per 1M tokens). Applies to the model ids
 * DeepSeek reports for its flash lineage, including the legacy
 * `deepseek-chat` / `deepseek-reasoner` aliases. Last reviewed against public
 * DeepSeek pricing docs mid-2026; treat as stale-prone.
 */
const DEEPSEEK_FLASH = {
  inCacheMissUsd: 0.14, // per 1M input tokens, no cache hit
  inCacheHitUsd: 0.028, // per 1M input tokens served from the prompt cache
  outUsd: 0.28, // per 1M output tokens
};

const DEEPSEEK_FLASH_IDS = new Set([
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-flash",
]);

/**
 * Best-effort cost for one request, in USD. Cache-hit input is billed at the
 * discounted rate; the rest of the input is billed at the miss rate. Returns
 * null when the provider/model has no configured rate — callers should then
 * show no cost rather than a fabricated one.
 */
export function estimatedCostUsd(params: {
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
}): number | null {
  const { provider, model } = params;
  if (!model || provider !== "deepseek" || !DEEPSEEK_FLASH_IDS.has(model)) {
    return null;
  }
  const input = params.inputTokens ?? 0;
  const cached = Math.min(input, params.cachedTokens ?? 0);
  const nonCached = Math.max(0, input - cached);
  const output = params.outputTokens ?? 0;
  const totalUsd =
    nonCached * DEEPSEEK_FLASH.inCacheMissUsd +
    cached * DEEPSEEK_FLASH.inCacheHitUsd +
    output * DEEPSEEK_FLASH.outUsd;
  return totalUsd / PER_M;
}
