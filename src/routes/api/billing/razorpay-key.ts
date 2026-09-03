import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/billing/razorpay-key")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;

        const { billingGate } = await import("@/lib/billing-route.server");
        const gate = await billingGate(auth.supabase, auth.organizationId);
        if (gate) return gate;

        // Only the public key id ever leaves the server.
        const { razorpayKeyId } = await import("@/lib/razorpay.server");
        const keyId = await razorpayKeyId(auth.supabase);
        return Response.json({ key_id: keyId, configured: Boolean(keyId) });
      },
    },
  },
});
