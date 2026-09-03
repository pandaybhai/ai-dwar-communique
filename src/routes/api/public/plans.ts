import { createFileRoute } from "@tanstack/react-router";

/**
 * The public price list. No auth, and deliberately no rate cards — what we pay
 * Meta is never part of a public response.
 */
export const Route = createFileRoute("/api/public/plans")({
  server: {
    handlers: {
      GET: async () => {
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

        const plans = ((data ?? []) as Record<string, unknown>[])
          .map((plan) => {
            const versions = ((plan["plan_versions"] ?? []) as Record<string, unknown>[]).filter(
              (v) => v["is_current"] === true,
            );
            const version = versions[0] ?? null;
            if (!version) return null;
            return {
              key: plan["key"],
              name: plan["name"],
              tagline: plan["tagline"] ?? null,
              currency: version["currency"] ?? "INR",
              price_monthly:
                version["price_monthly"] === null || version["price_monthly"] === undefined
                  ? null
                  : Number(version["price_monthly"]),
              price_annual:
                version["price_annual"] === null || version["price_annual"] === undefined
                  ? null
                  : Number(version["price_annual"]),
              limits: version["limits"] ?? {},
              highlights: version["highlights"] ?? [],
            };
          })
          .filter(Boolean);

        return Response.json(
          { plans },
          { headers: { "cache-control": "public, max-age=300" } },
        );
      },
    },
  },
});
