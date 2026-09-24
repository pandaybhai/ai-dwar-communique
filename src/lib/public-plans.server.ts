/**
 * The public price list, shared by /api/public/plans and the server-rendered
 * marketing pages. Deliberately no rate cards — what we pay Meta is never public.
 */
export type PublicPlan = {
  key: string;
  name: string;
  tagline: string | null;
  currency: string;
  price_monthly: number | null;
  price_annual: number | null;
  limits: Record<string, number>;
  highlights: string[];
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function loadPublicPlans(): Promise<PublicPlan[]> {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const supabase = getServiceClient();
  const { data } = await supabase
    .from("plans")
    .select(
      "key, name, tagline, sort_order, plan_versions(price_monthly, price_annual, currency, limits, highlights, is_current)",
    )
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");

  const out: PublicPlan[] = [];
  for (const plan of (data ?? []) as Record<string, unknown>[]) {
    const version = ((plan["plan_versions"] ?? []) as Record<string, unknown>[]).find(
      (v) => v["is_current"] === true,
    );
    if (!version) continue;
    out.push({
      key: String(plan["key"]),
      name: String(plan["name"]),
      tagline: (plan["tagline"] as string | null) ?? null,
      currency: String(version["currency"] ?? "INR"),
      price_monthly: num(version["price_monthly"]),
      price_annual: num(version["price_annual"]),
      limits: (version["limits"] as Record<string, number>) ?? {},
      highlights: (version["highlights"] as string[]) ?? [],
    });
  }
  return out;
}
