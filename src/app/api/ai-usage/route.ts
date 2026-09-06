import { readAiUsage, DAY_MS } from "@/lib/monitoring/ai-storage";
import { ingestClaudeCodeUsage } from "@/lib/monitoring/claude-code-transcript";

// Server-only aggregate over persisted usage; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Supported dashboard windows, in ms. Defaults to 24H. */
const WINDOWS: Record<string, number> = {
  "24H": DAY_MS,
  "7D": 7 * DAY_MS,
  "30D": 30 * DAY_MS,
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get("window") ?? "24H";
    const rangeMs = WINDOWS[raw.toUpperCase()] ?? WINDOWS["24H"];

    // Best-effort, throttled, read-only ingestion of this project's Claude Code
    // transcripts. Never a hard dependency: if it fails or is unavailable the
    // page still renders direct DeepSeek usage and reports ingestion status.
    const ingest = ingestClaudeCodeUsage();

    const summary = readAiUsage(rangeMs);
    return Response.json(
      { ...summary, claudeCodeIngest: ingest },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "ai_usage_unavailable" }, { status: 503 });
  }
}
