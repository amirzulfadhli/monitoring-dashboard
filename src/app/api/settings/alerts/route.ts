import { readAlertSettings, saveAlertSettings } from "@/lib/settings/service";
import type { AiAlertSettings, SystemAlertSettings } from "@/lib/settings/types";
import { bad, ok, readJson } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function parseSystem(v: unknown): SystemAlertSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const cpuWarnPct = num(s.cpuWarnPct);
  const cpuCritPct = num(s.cpuCritPct);
  const memWarnPct = num(s.memWarnPct);
  const memCritPct = num(s.memCritPct);
  if (cpuWarnPct === undefined || cpuCritPct === undefined || memWarnPct === undefined || memCritPct === undefined) {
    return undefined;
  }
  return { cpuWarnPct, cpuCritPct, memWarnPct, memCritPct };
}

function parseAi(v: unknown): AiAlertSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Record<string, unknown>;
  const toBudget = (x: unknown): number | undefined | null =>
    x === null || x === undefined ? null : num(x);
  const tokenBudget24h = toBudget(a.tokenBudget24h);
  const costBudget24hUsd = toBudget(a.costBudget24hUsd);
  if (tokenBudget24h === undefined || costBudget24hUsd === undefined) return undefined;
  return { tokenBudget24h, costBudget24hUsd };
}

/** PUT /api/settings/alerts — persist CPU/memory thresholds and AI budgets. */
export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return bad("Invalid request body.");

  const system = parseSystem(body.system);
  const ai = parseAi(body.ai);
  if (!system && !ai) {
    return bad("Provide a valid 'system' and/or 'ai' section.");
  }

  const result = saveAlertSettings({
    ...(system ? { system } : {}),
    ...(ai ? { ai } : {}),
  });
  if (!result.ok) return bad(result.error);
  return ok(readAlertSettings());
}
