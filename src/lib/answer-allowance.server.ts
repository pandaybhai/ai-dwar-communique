import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 80: on a plan whose workspace pays Meta itself (Basic, the
 * 'meta_direct_billing' flag) there is no wallet to charge AI answers past
 * the plan's allowance. Once this IST month's customer answers reach it,
 * Aiden hands new chats to the shared inbox (the workspace's hand-over line,
 * "Waiting for you" and the staff alert) until the month turns.
 *
 * Counts come from ai_usage_months, which the ai_runs trigger keeps (only
 * customer answers count, ai_run_is_customer_answer). A missing row, a
 * failed read or no allowance = not reached: a read problem never silences
 * Aiden.
 */
export async function answerAllowanceReached(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<{ reached: boolean; used: number; allowance: number | null }> {
  try {
    const { istMonthKey } = await import("@/lib/billing-ai-economics.server");
    const monthDate = `${istMonthKey(now)}-01`;
    const { data, error } = await supabase
      .from("ai_usage_months")
      .select("answers, allowance")
      .eq("organization_id", organizationId)
      .eq("month", monthDate)
      .maybeSingle();
    if (error || !data) return { reached: false, used: 0, allowance: null };
    const used = Number((data as Record<string, unknown>)["answers"] ?? 0);
    const allowance = Number((data as Record<string, unknown>)["allowance"] ?? Number.NaN);
    if (!Number.isFinite(allowance) || allowance < 0)
      return { reached: false, used, allowance: null };
    return { reached: used >= allowance, used, allowance };
  } catch {
    return { reached: false, used: 0, allowance: null };
  }
}
