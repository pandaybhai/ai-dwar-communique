import { createFileRoute } from "@tanstack/react-router";

/**
 * Self-serve plan purchase. Deliberately NOT behind billingGate: a trial
 * workspace has the billing flag off until the plan-assign trigger turns it
 * on, and this is the door it walks through to get there.
 */
export const Route = createFileRoute("/api/billing/plan")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const { planPurchaseState } = await import("@/lib/plan-purchase.server");
        const state = await planPurchaseState(auth.supabase, {
          organizationId: auth.organizationId,
          userId: auth.userId,
        });
        return Response.json(state);
      },

      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const planKey = String(payload["plan_key"] ?? "").trim();
        if (!planKey) return jsonError("Choose a plan first.");

        const { startPlanPurchase } = await import("@/lib/plan-purchase.server");
        const result = await startPlanPurchase(auth.supabase, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          planKey,
          gstin: (payload["gstin"] as string | null) ?? null,
          billingWhatsapp: (payload["billing_whatsapp"] as string | null) ?? null,
        });
        if ("error" in result) return jsonError(result.error);
        return Response.json(result);
      },
    },
  },
});
