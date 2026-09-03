import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";
import type { InvoiceLineInput } from "@/lib/invoices.server";

/**
 * The usage statement printed on a plan-fee invoice.
 *
 * These lines carry no money — messaging is paid from prepaid credits, not
 * from the plan fee. They exist so the merchant can see, on the same page as
 * the charge, exactly what the month looked like.
 */
export async function buildStatementLines(
  supabase: SupabaseClient,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
): Promise<InvoiceLineInput[]> {
  const lines: InvoiceLineInput[] = [];

  const { data: messages } = await supabase
    .from("messages")
    .select("pricing_category, flow_id, campaign_id")
    .eq("organization_id", organizationId)
    .eq("direction", "outbound")
    .eq("billable", true)
    .gte("created_at", periodStart)
    .lt("created_at", periodEnd)
    .limit(50000);

  const rows = (messages ?? []) as Record<string, unknown>[];
  const byCategory = new Map<string, number>();
  let automation = 0;
  for (const row of rows) {
    const category = String(row["pricing_category"] ?? "unknown");
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    if (row["flow_id"]) automation += 1;
  }

  for (const [category, count] of [...byCategory.entries()].sort()) {
    lines.push({
      line_type: "messaging",
      description: `${category.charAt(0).toUpperCase()}${category.slice(1)} messages sent: ${count} (paid from credits)`,
      unit_price: 0,
      informational: true,
      metadata: { category, count },
    });
  }
  if (automation > 0) {
    lines.push({
      line_type: "automation",
      description: `Automation sends: ${automation} (paid from credits)`,
      unit_price: 0,
      informational: true,
      metadata: { count: automation },
    });
  }

  const [{ count: aiUsed }, { data: settings }, { data: org }] = await Promise.all([
    supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
    supabase
      .from("organization_billing_settings")
      .select("ai_answers_included_override")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("organizations")
      .select("plan_versions:plan_version_id(limits)")
      .eq("id", organizationId)
      .maybeSingle(),
  ]);

  const planLimits = ((org?.["plan_versions"] as unknown as Record<string, unknown>)?.["limits"] ??
    {}) as Record<string, number>;
  const allowance =
    (settings?.["ai_answers_included_override"] as number | null) ??
    Number(planLimits["ai_answers"] ?? 0);

  lines.push({
    line_type: "ai",
    description: `AI answers used: ${aiUsed ?? 0}${allowance === -1 ? " (unlimited)" : ` of ${allowance}`}`,
    unit_price: 0,
    informational: true,
    metadata: { used: aiUsed ?? 0, allowance },
  });

  return lines;
}

/** What the month earned against what it cost — printed on the plan invoice. */
export async function planFeeRoiSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ attributed_revenue: number; total_cost: number }> {
  const [{ data: revenue }, { data: ledger }] = await Promise.all([
    supabase
      .from("revenue_attributions")
      .select("order_total")
      .eq("organization_id", organizationId)
      .gte("attributed_at", periodStart)
      .lt("attributed_at", periodEnd)
      .limit(20000),
    supabase
      .from("wallet_ledger")
      .select("amount, entry_type")
      .eq("organization_id", organizationId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd)
      .limit(20000),
  ]);

  const attributed = ((revenue ?? []) as Record<string, unknown>[]).reduce(
    (sum, row) => sum + Number(row["order_total"] ?? 0),
    0,
  );
  const spent = ((ledger ?? []) as Record<string, unknown>[])
    .filter((row) => Number(row["amount"] ?? 0) < 0)
    .reduce((sum, row) => sum + Math.abs(Number(row["amount"] ?? 0)), 0);

  return { attributed_revenue: round2(attributed), total_cost: round2(spent) };
}
