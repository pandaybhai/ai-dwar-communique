import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/billing/summary")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;

        const { billingGate, billingError } = await import("@/lib/billing-route.server");
        const gate = await billingGate(auth.supabase, auth.organizationId);
        if (gate) return gate;

        try {
          const { getClientBillingSummary } = await import("@/lib/billing.server");
          const summary = await getClientBillingSummary(auth.supabase, auth.organizationId, {
            userId: auth.userId,
          });
          return Response.json(summary);
        } catch (error) {
          return billingError(error);
        }
      },
    },
  },
});
