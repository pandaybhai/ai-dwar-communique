import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The one daily money job: plan fees, the overdue ladder, and a backfill for
 * any invoice that was prepared but never issued. Both /api/internal/
 * billing-monthly and its older alias /api/internal/plan-billing run this,
 * so whichever one is scheduled does exactly the same work.
 */
export async function runMonthlyBilling(supabase: SupabaseClient) {
  const { runPlanBilling } = await import("@/lib/plan-billing.server");
  const { runDunning } = await import("@/lib/dunning.server");
  const { issuePendingInvoices } = await import("@/lib/invoices.server");

  const billing = await runPlanBilling(supabase);
  const dunning = await runDunning(supabase);
  const backfill = await issuePendingInvoices(supabase);
  return { billing, dunning, backfill };
}
