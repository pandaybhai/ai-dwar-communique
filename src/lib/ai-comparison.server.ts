/**
 * Trying two set-ups against real customer questions.
 *
 * Every answer here is a normal ai_runs row tagged with the comparison, so the
 * cost of testing counts honestly against the workspace's monthly limit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { playgroundAnswer, defaultAgentId } from "@/lib/ai-tasks.server";
import type { RunResult } from "@/lib/ai-run.server";

export type CompareConfig = {
  label?: string;
  /** A merchant-facing tier key, never a vendor or a model. */
  tier?: string;
  instructions?: string | null;
};

export type ComparePair = {
  question: string;
  a: SideResult;
  b: SideResult;
};

export type SideResult = {
  answer: string;
  answered: boolean;
  passedToYou: boolean;
  status: string;
  error: string | null;
  sources: RunResult["sources"];
  tools: string[];
  /** What the merchant pays for this answer. */
  billedAmount: number | null;
  costKnown: boolean;
  latencyMs: number;
  tier: string;
  brainName: string;
  runId: string | null;
};

export type CompareSummary = {
  answered: number;
  passed: number;
  /** Runs that never reached a model — a broken setup, not a weak answer. */
  didNotRun: number;
  totalBilled: number | null;
  costKnown: boolean;
  averageMs: number;
};

/** The workspace's own recent customer questions — the only realistic test. */
export async function recentCustomerQuestions(
  supabase: SupabaseClient,
  organizationId: string,
  limit = 20,
): Promise<string[]> {
  const { data } = await supabase
    .from("messages")
    .select("body, created_at")
    .eq("organization_id", organizationId)
    .eq("direction", "inbound")
    .not("body", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit * 4);

  const seen = new Set<string>();
  const questions: string[] = [];
  for (const row of (data ?? []) as Array<{ body: string | null }>) {
    const text = (row.body ?? "").trim();
    if (text.length < 8 || text.length > 300) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(text);
    if (questions.length >= limit) break;
  }
  return questions;
}

function toSide(run: RunResult): SideResult {
  return {
    answer: run.output,
    answered: run.status === "ok",
    passedToYou: run.status === "escalated",
    status: run.status,
    error: run.error ?? null,
    sources: run.sources,
    tools: run.toolCalls.map((t) => t.tool),
    billedAmount: run.billedAmount,
    costKnown: run.costKnown,
    latencyMs: run.latencyMs,
    tier: run.tier,
    brainName: run.brainName,
    runId: run.runId,
  };
}

function summarise(sides: SideResult[]): CompareSummary {
  const costKnown = sides.length > 0 && sides.every((s) => s.costKnown);
  return {
    answered: sides.filter((s) => s.answered).length,
    passed: sides.filter((s) => s.passedToYou).length,
    totalBilled: costKnown ? sides.reduce((sum, s) => sum + (s.billedAmount ?? 0), 0) : null,
    costKnown,
    averageMs: sides.length
      ? Math.round(sides.reduce((sum, s) => sum + s.latencyMs, 0) / sides.length)
      : 0,
  };
}

export async function runComparison(
  supabase: SupabaseClient,
  common: { organizationId: string; actorUserId: string | null; actingRole?: string | null },
  input: { questions: string[]; configA: unknown; configB: unknown },
): Promise<{
  comparisonId: string | null;
  pairs: ComparePair[];
  summaryA: CompareSummary;
  summaryB: CompareSummary;
}> {
  const configA = (input.configA ?? {}) as CompareConfig;
  const configB = (input.configB ?? {}) as CompareConfig;
  const questions =
    input.questions.length > 0
      ? input.questions.slice(0, 20)
      : await recentCustomerQuestions(supabase, common.organizationId, 20);

  const agentId = await defaultAgentId(supabase, common.organizationId);

  const { data: created } = await supabase
    .from("ai_comparisons")
    .insert({
      organization_id: common.organizationId,
      agent_id: agentId,
      questions,
      config_a: configA,
      config_b: configB,
      created_by: common.actorUserId,
      status: "running",
    })
    .select("id")
    .maybeSingle();
  const comparisonId = (created as { id?: string } | null)?.id ?? null;

  const pairs: ComparePair[] = [];
  for (const question of questions) {
    // Sequential on purpose: the gateway rate limit is shared by the workspace.
    const runA = await playgroundAnswer(
      supabase,
      common,
      question,
      configA.tier ?? null,
      configA.instructions ?? null,
      comparisonId,
    );
    const runB = await playgroundAnswer(
      supabase,
      common,
      question,
      configB.tier ?? null,
      configB.instructions ?? null,
      comparisonId,
    );
    pairs.push({ question, a: toSide(runA), b: toSide(runB) });
  }

  const summaryA = summarise(pairs.map((p) => p.a));
  const summaryB = summarise(pairs.map((p) => p.b));

  if (comparisonId) {
    await supabase
      .from("ai_comparisons")
      .update({
        results: pairs,
        summary: { a: summaryA, b: summaryB },
        status: "done",
        completed_at: new Date().toISOString(),
      })
      .eq("id", comparisonId);
  }

  return { comparisonId, pairs, summaryA, summaryB };
}
