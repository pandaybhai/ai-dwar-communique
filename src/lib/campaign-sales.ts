import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sales linked to a campaign: the orders revenue attribution (last touch,
 * revenue_attributions) put on it, the same rows Receipts and Analytics
 * count. Summed here from one read; a campaign with more rows than PostgREST
 * returns at once, or with orders in more than one currency, has no single
 * true total. Shared by the campaign screen (loadCampaignSales) and AiDwar
 * MCP's get_campaign_sales (Batch 54), so both show exactly the same figure.
 */

export type CampaignSales = { orders: number; revenue: number; currency: string };

export const SALES_ROW_CAP = 1000;

export type CampaignSalesRead =
  | { kind: "sales"; sales: CampaignSales }
  | { kind: "none" }
  | { kind: "too_many"; orders: number }
  | { kind: "mixed_currencies"; orders: number; currencies: string[] }
  | { kind: "error" };

export async function readCampaignSales(
  db: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<CampaignSalesRead> {
  const {
    data,
    count: total,
    error,
  } = await db
    .from("revenue_attributions")
    .select("order_total, currency", { count: "exact" })
    .eq("organization_id", organizationId)
    .eq("source_type", "campaign")
    .eq("source_id", campaignId)
    .range(0, SALES_ROW_CAP - 1);
  if (error) return { kind: "error" };
  const rows = (data ?? []) as Array<{
    order_total: number | string | null;
    currency: string | null;
  }>;
  if (rows.length === 0) return { kind: "none" };
  if ((total ?? rows.length) > rows.length) return { kind: "too_many", orders: total ?? rows.length };
  const currencies = new Set(rows.map((r) => r.currency || "INR"));
  if (currencies.size > 1) return { kind: "mixed_currencies", orders: rows.length, currencies: [...currencies] };
  return {
    kind: "sales",
    sales: {
      orders: rows.length,
      revenue: rows.reduce((s, r) => s + Number(r.order_total ?? 0), 0),
      currency: [...currencies][0] ?? "INR",
    },
  };
}
