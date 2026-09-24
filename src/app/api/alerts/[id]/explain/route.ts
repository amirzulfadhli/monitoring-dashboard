import { explainAlert } from "@/lib/alerts/explain/service";
import type { StoredExplanation } from "@/lib/alerts/explain/storage";

// The ONLY explanation entry point. It names an existing alert (by fingerprint)
// and the action is fixed: explain that alert from nearby persisted evidence.
// No prompt, question, or arbitrary text is accepted — the request body is
// deliberately ignored. A fresh cached explanation returns without calling
// DeepSeek; otherwise exactly one (single-flighted) run happens. Missing key and
// model/validation failures degrade cleanly while preserving the last good
// explanation; an unknown alert returns 404.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function wire(stored: StoredExplanation) {
  return {
    fingerprint: stored.fingerprint,
    versionKey: stored.versionKey,
    createdAt: stored.createdAt,
    evidenceCount: stored.evidenceEventIds.length,
    explanation: stored.explanation,
    model: stored.model,
    usage: stored.usage,
  };
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Next.js has already percent-decoded the route parameter. Decoding it again
  // would corrupt any id containing a literal '%' and throw URIError on a
  // malformed one, so the value is used exactly as delivered.
  const { id: fingerprint } = await params;

  const result = await explainAlert(fingerprint);
  if (result === null) {
    return Response.json(
      { ok: false, reason: "not_found", message: "Alert not found." },
      { status: 404 },
    );
  }

  if (result.ok) {
    return Response.json(
      { ok: true, cached: result.cached, ...wire(result.stored) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const previous = result.previous ? wire(result.previous) : null;
  const message =
    result.reason === "missing_key"
      ? "Explain is unavailable: DEEPSEEK_API_KEY is not configured."
      : result.reason === "deepseek_error"
        ? "Explanation failed: DeepSeek could not complete the request. The last good explanation, if any, is preserved."
        : "Explanation rejected: DeepSeek returned output that failed validation. Nothing malformed is shown.";
  return Response.json(
    { ok: false, reason: result.reason, message, previous },
    { headers: { "Cache-Control": "no-store" } },
  );
}
