import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 82: organizations.plan_period_ends_at — how long a paid plan's access
 * runs. Every successful plan_fee payment (settlePayment: webhook,
 * return-confirm, sweep, a plan-fee invoice's link) adds 30 days: from the
 * payment if the period is over or unset, from the current end if it is still
 * running. Once per payment: it runs only inside settlePayment after the
 * payment is marked paid, and settlePayment returns early for a payment that
 * is already paid (and claims it, so two deliveries can't both settle it) — a
 * replayed webhook never extends twice. Nothing is ever locked from here; the
 * date drives the in-app banner and Admin's Renewals list.
 */

export const PLAN_PERIOD_DAYS = 30;
const DAY_MS = 864e5;

/** The new end: 30 days from the later of the payment and the current end. Pure. */
export function nextPeriodEnd(currentEnd: string | null | undefined, paidAt: string): string {
  const paid = Date.parse(paidAt);
  const current = currentEnd ? Date.parse(currentEnd) : Number.NaN;
  const from = Number.isFinite(current) && current > paid ? current : paid;
  return new Date(from + PLAN_PERIOD_DAYS * DAY_MS).toISOString();
}

/** Never throws: the payment is settled whatever happens here. */
export async function extendPlanPeriod(
  supabase: SupabaseClient,
  input: { organizationId: string; paymentId: string; paidAt?: string },
): Promise<"extended" | "skipped"> {
  try {
    // Until the column exists (20261450 not applied) this read fails: nothing changes.
    const { data: org, error } = await supabase
      .from("organizations")
      .select("plan_period_ends_at")
      .eq("id", input.organizationId)
      .maybeSingle();
    if (error) {
      console.log(
        JSON.stringify({ scope: "plan_period", stage: "read_failed", error: error.message }),
      );
      return "skipped";
    }
    const end = nextPeriodEnd(
      (org as { plan_period_ends_at?: string | null } | null)?.plan_period_ends_at ?? null,
      input.paidAt ?? new Date().toISOString(),
    );
    const { error: writeError } = await supabase
      .from("organizations")
      .update({ plan_period_ends_at: end })
      .eq("id", input.organizationId);
    if (writeError) return "skipped";
    return "extended";
  } catch {
    return "skipped";
  }
}
