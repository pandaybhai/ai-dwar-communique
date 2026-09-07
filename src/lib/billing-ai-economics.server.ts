import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, round4 } from "@/lib/billing";

/**
 * AI economics for the platform owner.
 *
 * The month totals are read from ai_usage_months, which the database trigger
 * freezes as each answer happens: the allowance that applied at the time, how
 * many answers went past it, what the provider charged and what we billed.
 * Nothing here recomputes an allowance from today's settings — if a plan
 * changed since, history still shows what really happened.
 *
 * Months are Asia/Kolkata months, the same boundary the trigger uses.
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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The YYYY-MM an instant falls in, read in Asia/Kolkata. */
export function istMonthKey(iso: string | Date): string {
  const at = typeof iso === "string" ? new Date(iso) : iso;
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** The current YYYY-MM in Asia/Kolkata. */
export const currentIstMonth = (): string => istMonthKey(new Date());

/**
 * The instants that bound an Asia/Kolkata month: midnight IST on the 1st of
 * that month, and midnight IST on the 1st of the next one.
 */
export function istMonthWindow(month: string): { fromIso: string; toIso: string; monthDate: string } {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(year, mon - 1, 1) - IST_OFFSET_MS);
  const to = new Date(Date.UTC(year, mon, 1) - IST_OFFSET_MS);
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    monthDate: `${month}-01`,
  };
}

/** Which model handled each answer — the only thing still counted from ai_runs. */
async function tierMix(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string,
): Promise<Map<string, { everyday: number; careful: number }>> {
  const { data } = await supabase
    .from("ai_runs")
    .select("organization_id, tier, created_at")
    .eq("status", "ok")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .limit(100_000);

  const mix = new Map<string, { everyday: number; careful: number }>();
  for (const run of (data ?? []) as Record<string, unknown>[]) {
    const key = `${String(run["organization_id"])}|${istMonthKey(String(run["created_at"]))}`;
    const bucket = mix.get(key) ?? { everyday: 0, careful: 0 };
    if (String(run["tier"] ?? "") === "careful") bucket.careful += 1;
    else bucket.everyday += 1;
    mix.set(key, bucket);
  }
  return mix;
}

function toEconomics(
  row: Record<string, unknown>,
  mix: { everyday: number; careful: number } | undefined,
): OrgAiEconomics {
  const answers = Number(row["answers"] ?? 0);
  const over = Number(row["over_answers"] ?? 0);
  const providerCost = round4(Number(row["provider_cost"] ?? 0));
  const billed = round4(Number(row["billed_amount"] ?? 0));
  const tiered = (mix?.everyday ?? 0) + (mix?.careful ?? 0);
  return {
    answers,
    within_allowance: Math.max(answers - over, 0),
    over_allowance: over,
    allowance: Number(row["allowance"] ?? 0),
    provider_cost: providerCost,
    billed,
    margin: round4(billed - providerCost),
    avg_cost_per_answer: answers > 0 ? round4(providerCost / answers) : 0,
    everyday_pct: tiered > 0 ? Math.round(((mix?.everyday ?? 0) / tiered) * 100) : 0,
    careful_pct: tiered > 0 ? Math.round(((mix?.careful ?? 0) / tiered) * 100) : 0,
  };
}

/**
 * Frozen AI economics per organization and Asia/Kolkata month, keyed
 * `organizationId|YYYY-MM`, for an inclusive range of months.
 */
export async function aiUsageByOrgMonth(
  supabase: SupabaseClient,
  monthFrom: string,
  monthTo: string,
): Promise<Map<string, OrgAiEconomics>> {
  const start = istMonthWindow(monthFrom);
  const end = istMonthWindow(monthTo);
  const [{ data: usage }, mix] = await Promise.all([
    supabase
      .from("ai_usage_months")
      .select("organization_id, month, allowance, answers, over_answers, billed_amount, provider_cost")
      .gte("month", start.monthDate)
      .lte("month", end.monthDate)
      .limit(20_000),
    tierMix(supabase, start.fromIso, end.toIso),
  ]);

  const out = new Map<string, OrgAiEconomics>();
  for (const row of (usage ?? []) as Record<string, unknown>[]) {
    const month = String(row["month"]).slice(0, 7);
    const key = `${String(row["organization_id"])}|${month}`;
    out.set(key, toEconomics(row, mix.get(key)));
  }
  return out;
}

/** Frozen AI economics per organization for one Asia/Kolkata month. */
export async function aiUsageByOrg(
  supabase: SupabaseClient,
  month: string,
): Promise<Map<string, OrgAiEconomics>> {
  const byMonth = await aiUsageByOrgMonth(supabase, month, month);
  const out = new Map<string, OrgAiEconomics>();
  for (const [key, value] of byMonth) {
    const [org = "", key_month = ""] = key.split("|");
    if (key_month === month) out.set(org, value);
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
