import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/billing/purchase")({
  server: {
    handlers: {
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

        const { billingGate, billingError, requireActivePlan } = await import(
          "@/lib/billing-route.server"
        );
        const gate = await billingGate(auth.supabase, auth.organizationId);
        if (gate) return gate;

        const planGate = await requireActivePlan(auth.supabase, auth.organizationId);
        if (planGate) return planGate;

        const packId = String(payload["pack_id"] ?? "").trim();
        if (!packId) return jsonError("Choose a credit pack first.");

        try {
          const { createCreditPurchase } = await import("@/lib/billing.server");
          const result = await createCreditPurchase(auth.supabase, {
            organizationId: auth.organizationId,
            userId: auth.userId,
            packId,
            couponCode: (payload["coupon_code"] as string | null) ?? null,
            origin: new URL(request.url).origin,
          });
          if ("error" in result) return jsonError(result.error);
          // Batch 70: InitiateCheckout (server copy now, the browser fires `meta`).
          // The checkout's answer never depends on it.
          let meta: import("@/lib/meta-events").BrowserMetaEvent | null = null;
          try {
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const { metaCheckoutStarted } = await import("@/lib/meta-capi.server");
            meta = await metaCheckoutStarted(getServiceClient(), {
              paymentId: result.payment_id,
              userId: auth.userId,
              request,
            });
          } catch {
            meta = null;
          }
          return Response.json({ ...result, meta });
        } catch (error) {
          return billingError(error);
        }
      },
    },
  },
});
