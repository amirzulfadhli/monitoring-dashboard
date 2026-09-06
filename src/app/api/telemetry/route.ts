import { collectTelemetry } from "@/lib/telemetry";

// Server-only collector; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await collectTelemetry();
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "telemetry_unavailable" },
      { status: 503 },
    );
  }
}
