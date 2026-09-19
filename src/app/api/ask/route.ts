import { ask } from "@/lib/ask/service";

// The ONLY Ask DevPulse entry point, and the only place in the app that accepts
// free text. The question is validated, bounded and treated as untrusted data;
// it selects evidence deterministically, and at most one instrumented DeepSeek
// call is made per submitted question. There is deliberately no GET: nothing can
// reach a model by loading or polling a page. Nothing here runs a collector or
// touches anything outside DevPulse's own persisted evidence.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

const QUESTION_ERRORS: Record<string, string> = {
  not_string: "A question must be a string.",
  empty: "Enter a question.",
  too_long: "That question is too long. Keep it under 400 characters.",
  control_chars: "That question contains characters that are not allowed.",
};

/** Read the JSON body defensively — a malformed body is just a missing question. */
async function readQuestion(req: Request): Promise<unknown> {
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== "object" || body === null) return undefined;
    return (body as Record<string, unknown>).question;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  const question = await readQuestion(req);
  const result = await ask(question);

  if (result.ok) {
    return Response.json(
      {
        ok: true,
        answer: result.answer,
        insufficientEvidence: result.insufficientEvidence,
        evidence: result.evidence,
        citedEvidenceIds: result.citedEvidenceIds,
        windowHours: result.windowHours,
        generatedAt: result.generatedAt,
        model: result.model,
        usage: result.usage,
      },
      NO_STORE,
    );
  }

  if (result.reason === "invalid_question") {
    return Response.json(
      {
        ok: false,
        reason: result.reason,
        message: QUESTION_ERRORS[result.error] ?? "That question cannot be accepted.",
      },
      { status: 400, ...NO_STORE },
    );
  }

  const status = result.reason === "missing_key" ? 503 : 502;
  const message =
    result.reason === "missing_key"
      ? "Ask DevPulse is unavailable: DEEPSEEK_API_KEY is not configured."
      : result.reason === "deepseek_error"
        ? "The answer could not be generated: DeepSeek did not complete the request. Nothing was changed and no answer is shown."
        : "The answer was rejected: DeepSeek returned output that failed validation. Nothing unvalidated is shown.";
  return Response.json({ ok: false, reason: result.reason, message }, {
    status,
    ...NO_STORE,
  });
}
