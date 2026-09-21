import { generateBrief, getReport } from "@/lib/brief/service";

// The daily operational brief API.
//
// GET is read-only: it reflects the latest stored brief and can never reach a
// model, so loading or polling /brief costs nothing. POST is the only entry
// point that can generate one, it does so only when asked, and it makes at most
// one instrumented DeepSeek call per request — a brief already stored for the
// current period is returned as-is unless the request explicitly asks to
// regenerate. Nothing here runs a collector or reads anything outside DevPulse's
// own persisted evidence.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

const FAILURE_MESSAGES: Record<string, string> = {
  missing_key: "The brief could not be generated: DEEPSEEK_API_KEY is not configured.",
  deepseek_error:
    "The brief could not be generated: DeepSeek did not complete the request. The stored brief, if any, is unchanged.",
  invalid_output:
    "The brief was rejected: DeepSeek returned output that failed validation. Nothing unvalidated is stored or shown.",
};

export async function GET() {
  return Response.json(getReport(), NO_STORE);
}

/**
 * Read the one recognised field defensively. The body is not a prompt channel:
 * the only thing it can carry is an explicit regeneration request, and anything
 * else — a malformed body, an unknown field, a non-boolean — is simply ignored.
 */
async function readRegenerate(req: Request): Promise<boolean> {
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== "object" || body === null) return false;
    return (body as Record<string, unknown>).regenerate === true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const regenerate = await readRegenerate(req);
  const result = await generateBrief(regenerate);

  if (result.ok) {
    return Response.json(
      { ok: true, computed: result.computed, record: result.record, report: result.report },
      NO_STORE,
    );
  }

  return Response.json(
    {
      ok: false,
      reason: result.reason,
      message: FAILURE_MESSAGES[result.reason] ?? "The brief could not be generated.",
      report: result.report,
    },
    { status: result.reason === "missing_key" ? 503 : 502, ...NO_STORE },
  );
}
