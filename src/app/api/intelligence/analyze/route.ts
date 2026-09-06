import { analyze } from "@/lib/intelligence/service";

// The ONLY live-analysis entry point. The action is fixed: "analyze recent
// DevPulse evidence" for the last 24h. No prompt, question, or arbitrary text
// is accepted — the request body is deliberately ignored. A fresh cached
// analysis is returned without calling DeepSeek; otherwise exactly one
// (single-flighted) analysis runs. Missing API key and model/validation
// failures degrade to a clear error while preserving the last good analysis.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = await analyze();
  if (result.ok) {
    return Response.json(
      { ok: true, computed: result.computed, report: result.report },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    {
      ok: false,
      reason: result.reason,
      report: result.report,
      message:
        result.reason === "missing_key"
          ? "Intelligence is unavailable: DEEPSEEK_API_KEY is not configured."
          : result.reason === "deepseek_error"
            ? "Analysis failed: DeepSeek could not complete the request. The last good analysis, if any, is preserved."
            : "Analysis rejected: DeepSeek returned output that failed validation. Nothing malformed is shown.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
