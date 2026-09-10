/**
 * Alert rule evaluation (the deterministic layer only). These are pure
 * functions over plain observations — no collectors, no storage, no network.
 *
 * The tests assert the behaviour a regression would actually hurt: sustained
 * thresholds, the healthy/unhealthy split per source, and the "no budget
 * configured means no alert" guarantee for AI spend.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { alertConfig } from "../src/lib/alerts/config";
import { RULES, type RuleId, type RuleVerdict } from "../src/lib/alerts/model";
import {
  evaluateAi,
  evaluateGithub,
  evaluateSystem,
  evaluateWebsites,
  type SystemSample,
} from "../src/lib/alerts/rules";

const sysCfg = alertConfig.system;

function verdict(verdicts: RuleVerdict[], ruleId: RuleId): RuleVerdict {
  const found = verdicts.find((v) => v.ruleId === ruleId);
  assert.ok(found, `no verdict produced for rule ${ruleId}`);
  return found;
}

function sample(ts: number, cpuPct: number | null): SystemSample {
  return { ts, cpuPct, usedMem: null, availMem: null };
}

function memSample(ts: number, usedMem: number, availMem: number): SystemSample {
  return { ts, cpuPct: null, usedMem, availMem };
}

/* ------------------------------- system ------------------------------- */

test("high CPU alerts only when sustained", () => {
  // Oldest first, as persisted. Two consecutive warning-level samples fire.
  const sustainedWarn = evaluateSystem(
    [sample(1, 90), sample(2, 90)],
    sysCfg,
  );
  const cpuWarn = verdict(sustainedWarn, RULES.CPU_HIGH);
  assert.equal(cpuWarn.active, true);
  assert.equal(cpuWarn.severity, "warning");

  // Above the critical threshold the same condition escalates.
  const critical = verdict(
    evaluateSystem([sample(1, 97), sample(2, 97)], sysCfg),
    RULES.CPU_HIGH,
  );
  assert.equal(critical.active, true);
  assert.equal(critical.severity, "critical");
});

test("a brief CPU spike does not alert", () => {
  // Fewer samples than minSamples: sparse data never fires.
  const sparse = verdict(evaluateSystem([sample(1, 99)], sysCfg), RULES.CPU_HIGH);
  assert.equal(sparse.active, false);

  // One spike followed by a healthy reading is not a sustained condition.
  const recovered = verdict(
    evaluateSystem([sample(1, 99), sample(2, 10)], sysCfg),
    RULES.CPU_HIGH,
  );
  assert.equal(recovered.active, false);
});

test("high memory alerts on used/available ratio", () => {
  const warn = verdict(
    evaluateSystem(
      [memSample(1, 90, 10), memSample(2, 90, 10)],
      sysCfg,
    ),
    RULES.MEMORY_HIGH,
  );
  assert.equal(warn.active, true);
  assert.equal(warn.severity, "warning");

  const critical = verdict(
    evaluateSystem(
      [memSample(1, 96, 4), memSample(2, 96, 4)],
      sysCfg,
    ),
    RULES.MEMORY_HIGH,
  );
  assert.equal(critical.active, true);
  assert.equal(critical.severity, "critical");

  const healthy = verdict(
    evaluateSystem(
      [memSample(1, 20, 80), memSample(2, 20, 80)],
      sysCfg,
    ),
    RULES.MEMORY_HIGH,
  );
  assert.equal(healthy.active, false);
});

/* ------------------------------ websites ------------------------------ */

test("a down website alerts as down, not degraded", () => {
  const [down, degraded] = evaluateWebsites([
    { targetId: "a", name: "Alpha", state: "down", latencyMs: null },
  ]);

  assert.equal(verdict([down, degraded], RULES.WEBSITE_DOWN).active, true);
  assert.equal(verdict([down, degraded], RULES.WEBSITE_DEGRADED).active, false);
});

test("a degraded website alerts as degraded, not down", () => {
  const v = evaluateWebsites([
    { targetId: "b", name: "Beta", state: "degraded", latencyMs: 4200 },
  ]);

  assert.equal(verdict(v, RULES.WEBSITE_DEGRADED).active, true);
  assert.equal(verdict(v, RULES.WEBSITE_DOWN).active, false);
});

test("a healthy website produces no active verdict", () => {
  const v = evaluateWebsites([
    { targetId: "c", name: "Gamma", state: "healthy", latencyMs: 120 },
  ]);

  assert.equal(verdict(v, RULES.WEBSITE_DOWN).active, false);
  assert.equal(verdict(v, RULES.WEBSITE_DEGRADED).active, false);
});

/* ------------------------------- github ------------------------------- */

test("only a failed workflow alerts", () => {
  const states = ["healthy", "running", "unavailable", "attention"] as const;

  for (const state of states) {
    const [v] = evaluateGithub([{ key: "o/r", name: "R", state }]);
    assert.equal(
      verdict([v], RULES.WORKFLOW_FAILED).active,
      state === "attention",
      `state ${state} should ${state === "attention" ? "" : "not "}alert`,
    );
  }
});

/* --------------------------------- ai --------------------------------- */

test("AI budgets that are not configured never alert", () => {
  // alertConfig ships with both budgets null — DevPulse must never invent a
  // personal spending limit.
  const v = evaluateAi(
    { totalTokens: 10_000_000, costUsd: 500 },
    alertConfig.ai,
  );

  assert.equal(verdict(v, RULES.AI_TOKEN_BUDGET).active, false);
  assert.equal(verdict(v, RULES.AI_COST_BUDGET).active, false);
});

test("token budget alerts only when exceeded", () => {
  const cfg = { tokenBudget24h: 1_000_000, costBudget24hUsd: null };

  const over = verdict(
    evaluateAi({ totalTokens: 1_500_000, costUsd: null }, cfg),
    RULES.AI_TOKEN_BUDGET,
  );
  assert.equal(over.active, true);

  const under = verdict(
    evaluateAi({ totalTokens: 900_000, costUsd: null }, cfg),
    RULES.AI_TOKEN_BUDGET,
  );
  assert.equal(under.active, false);
});

test("cost budget alerts only when a cost can be estimated", () => {
  const cfg = { tokenBudget24h: null, costBudget24hUsd: 1 };

  const over = verdict(
    evaluateAi({ totalTokens: 0, costUsd: 2.5 }, cfg),
    RULES.AI_COST_BUDGET,
  );
  assert.equal(over.active, true);

  const under = verdict(
    evaluateAi({ totalTokens: 0, costUsd: 0.25 }, cfg),
    RULES.AI_COST_BUDGET,
  );
  assert.equal(under.active, false);

  // An unestimable cost stays silent rather than guessing.
  const unknown = verdict(
    evaluateAi({ totalTokens: 0, costUsd: null }, cfg),
    RULES.AI_COST_BUDGET,
  );
  assert.equal(unknown.active, false);
});
