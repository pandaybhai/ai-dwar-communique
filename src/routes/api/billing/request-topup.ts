import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/billing/request-topup")({
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

        const { billingGate, billingError } = await import("@/lib/billing-route.server");
        const gate = await billingGate(auth.supabase, auth.organizationId);
        if (gate) return gate;

        const amountRaw = payload["amount"];
        const amount =
          amountRaw === null || amountRaw === undefined || amountRaw === ""
            ? null
            : Number(amountRaw);
        if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
          return jsonError("Enter an amount greater than zero.");
        }

        try {
          const { requestTopup } = await import("@/lib/billing.server");
          await requestTopup(auth.supabase, {
            organizationId: auth.organizationId,
            userId: auth.userId,
            amount,
            note: ((payload["note"] as string | null) ?? "").toString().slice(0, 500) || null,
          });
          return Response.json({ ok: true });
        } catch (error) {
          return billingError(error);
        }
      },
    },
  },
});
