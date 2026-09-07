import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";

/**
 * AI economics for the platform owner.
 *
 * Everything here is read-only: it reads what was stored on ai_runs at the time
 * the answer was produced (cost_amount, billed_amount, markup, model) and the
 * debit_ai rows that actually took money from a wallet. Nothing is recomputed —
 * if a price changed since, the history still shows what really happened.
 *
 * Margin is shown honestly: while an organization is inside its included
 * allowance nothing is billed, so the margin on those answers is negative.
 */

export type OrgAiEconomics = {
  answers: number;
  within_allowance: number;
  over_allowance: number;
  allowance: number;
  provider_cost: number;
  billed: number;
  margin: number;
  avg_cost_per_answer: number;
  everyday_pct: number;
  careful_pct: number;
};

export const emptyAiEconomics = (): OrgAiEconomics => ({
  answers: 0,
  within_allowance: 0,
  over_allowance: 0,
  allowance: 0,
  provider_cost: 0,
  billed: 0,
  margin: 0,
  avg_cost_per_answer: 0,
  everyday_pct: 0,
  careful_pct: 0,
});

/** The included AI answers per organization: hand-set override, else the plan. */
export async function aiAllowances(supabase: SupabaseClient): Promise<Map<string, number>> {
  const [{ data: settings }, { data: orgs }] = await Promise.all([
    supabase
      .from("organization_billing_settings")
      .select("organization_id, ai_answers_included_override"),
    supabase.from("organizations").select("id, plan_versions:plan_version_id(limits)"),
  ]);

  const allowances = new Map<string, number>();
  for (const org of (orgs ?? []) as Record<string, unknown>[]) {
    const limits = ((org["plan_versions"] as Record<string, unknown> | null)?.["limits"] ??
      {}) as Record<string, unknown>;
    allowances.set(String(org["id"]), Number(limits["ai_answers"] ?? 0));
  }
  for (const row of (settings ?? []) as Record<string, unknown>[]) {
    const override = row["ai_answers_included_override"];
    if (override === null || override === undefined) continue;
    allowances.set(String(row["organization_id"]), Number(override));
  }
  return allowances;
}

type Bucket = {
  answers: number;
  provider_cost: number;
  billed: number;
  everyday: number;
  careful: number;
};

const newBucket = (): Bucket => ({
  answers: 0,
  provider_cost: 0,
  billed: 0,
  everyday: 0,
  careful: 0,
});

function finish(bucket: Bucket, allowance: number): OrgAiEconomics {
  const unlimited = allowance === -1;
  const within = unlimited ? bucket.answers : Math.min(bucket.answers, Math.max(allowance, 0));
  const over = Math.max(bucket.answers - within, 0);
  const providerCost = round2(bucket.provider_cost);
  const billed = round2(bucket.billed);
  const tiered = bucket.everyday + bucket.careful;
  return {
    answers: bucket.answers,
    within_allowance: within,
    over_allowance: over,
    allowance,
    provider_cost: providerCost,
    billed,
    margin: round2(billed - providerCost),
    avg_cost_per_answer: bucket.answers > 0 ? round2(bucket.provider_cost / bucket.answers) : 0,
    everyday_pct: tiered > 0 ? Math.round((bucket.everyday / tiered) * 100) : 0,
    careful_pct: tiered > 0 ? Math.round((bucket.careful / tiered) * 100) : 0,
  };
}

/** Which runs actually took money from a wallet — the only ones we billed for. */
async function billedRunIds(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("wallet_ledger")
    .select("reference_id")
    .eq("entry_type", "debit_ai")
    .eq("reference_type", "ai_run")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .limit(50_000);
  const ids = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = row["reference_id"];
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

const isCareful = (run: Record<string, unknown>) => String(run["tier"] ?? "") === "careful";

/** AI economics per organization for one window. */
export async function aiEconomicsByOrg(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string,
  allowances: Map<string, number>,
): Promise<Map<string, OrgAiEconomics>> {
  const [{ data: runs }, billed] = await Promise.all([
    supabase
      .from("ai_runs")
      .select("id, organization_id, cost_amount, billed_amount, tier, created_at")
      .eq("status", "ok")
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .limit(100_000),
    billedRunIds(supabase, fromIso, toIso),
  ]);

  const buckets = new Map<string, Bucket>();
  for (const run of (runs ?? []) as Record<string, unknown>[]) {
    const org = String(run["organization_id"]);
    const bucket = buckets.get(org) ?? newBucket();
    bucket.answers += 1;
    bucket.provider_cost += Number(run["cost_amount"] ?? 0);
    if (billed.has(String(run["id"]))) bucket.billed += Number(run["billed_amount"] ?? 0);
    if (isCareful(run)) bucket.careful += 1;
    else bucket.everyday += 1;
    buckets.set(org, bucket);
  }

  const out = new Map<string, OrgAiEconomics>();
  for (const [org, bucket] of buckets) {
    out.set(org, finish(bucket, allowances.get(org) ?? 0));
  }
  return out;
}

/** AI economics per organization, per calendar month, for a window. */
export async function aiEconomicsByOrgMonth(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string,
  allowances: Map<string, number>,
): Promise<Map<string, OrgAiEconomics>> {
  const [{ data: runs }, billed] = await Promise.all([
    supabase
      .from("ai_runs")
      .select("id, organization_id, cost_amount, billed_amount, tier, created_at")
      .eq("status", "ok")
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .limit(100_000),
    billedRunIds(supabase, fromIso, toIso),
  ]);

  const buckets = new Map<string, Bucket>();
  for (const run of (runs ?? []) as Record<string, unknown>[]) {
    const month = String(run["created_at"]).slice(0, 7);
    const key = `${String(run["organization_id"])}|${month}`;
    const bucket = buckets.get(key) ?? newBucket();
    bucket.answers += 1;
    bucket.provider_cost += Number(run["cost_amount"] ?? 0);
    if (billed.has(String(run["id"]))) bucket.billed += Number(run["billed_amount"] ?? 0);
    if (isCareful(run)) bucket.careful += 1;
    else bucket.everyday += 1;
    buckets.set(key, bucket);
  }

  const out = new Map<string, OrgAiEconomics>();
  for (const [key, bucket] of buckets) {
    const org = key.split("|")[0] ?? "";
    out.set(key, finish(bucket, allowances.get(org) ?? 0));
  }
  return out;
}

/** One AI answer, as it was priced when it happened, with the wallet debit beside it. */
export type AiRunDetailRow = {
  id: string;
  created_at: string;
  task: string | null;
  tier: string | null;
  model: string | null;
  status: string | null;
  cost_amount: number;
  billed_amount: number;
  markup_multiplier: number | null;
  conversation_id: string | null;
  billed: boolean;
  debit_amount: number | null;
};

/**
 * The underlying answers behind one workspace/month total: every ok run in the
 * window and the debit_ai wallet entry (if any) that charged for it.
 */
export async function aiRunDetail(
  supabase: SupabaseClient,
  input: { organizationId: string; fromIso: string; toIso: string },
): Promise<{ runs: AiRunDetailRow[]; totals: { answers: number; provider_cost: number; billed: number; margin: number } }> {
  const [{ data: runs }, { data: debits }] = await Promise.all([
    supabase
      .from("ai_runs")
      .select(
        "id, created_at, task, tier, model, status, cost_amount, billed_amount, markup_multiplier, conversation_id",
      )
      .eq("organization_id", input.organizationId)
      .eq("status", "ok")
      .gte("created_at", input.fromIso)
      .lt("created_at", input.toIso)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("wallet_ledger")
      .select("reference_id, amount")
      .eq("organization_id", input.organizationId)
      .eq("entry_type", "debit_ai")
      .eq("reference_type", "ai_run")
      .gte("created_at", input.fromIso)
      .lt("created_at", input.toIso)
      .limit(50_000),
  ]);

  const debitByRun = new Map<string, number>();
  for (const row of (debits ?? []) as Record<string, unknown>[]) {
    const id = row["reference_id"];
    if (typeof id !== "string") continue;
    debitByRun.set(id, (debitByRun.get(id) ?? 0) + Math.abs(Number(row["amount"] ?? 0)));
  }

  let providerCost = 0;
  let billedTotal = 0;
  const out: AiRunDetailRow[] = [];
  for (const run of (runs ?? []) as Record<string, unknown>[]) {
    const id = String(run["id"]);
    const debit = debitByRun.get(id) ?? null;
    const cost = Number(run["cost_amount"] ?? 0);
    providerCost += cost;
    if (debit !== null) billedTotal += Number(run["billed_amount"] ?? 0);
    out.push({
      id,
      created_at: String(run["created_at"]),
      task: (run["task"] as string) ?? null,
      tier: (run["tier"] as string) ?? null,
      model: (run["model"] as string) ?? null,
      status: (run["status"] as string) ?? null,
      cost_amount: round2(cost),
      billed_amount: round2(Number(run["billed_amount"] ?? 0)),
      markup_multiplier:
        run["markup_multiplier"] === null || run["markup_multiplier"] === undefined
          ? null
          : Number(run["markup_multiplier"]),
      conversation_id: (run["conversation_id"] as string) ?? null,
      billed: debit !== null,
      debit_amount: debit === null ? null : round2(debit),
    });
  }

  return {
    runs: out,
    totals: {
      answers: out.length,
      provider_cost: round2(providerCost),
      billed: round2(billedTotal),
      margin: round2(billedTotal - providerCost),
    },
  };
}
