import { createFileRoute } from "@tanstack/react-router";

/** What this campaign will cost, and whether the workspace can afford it. */
export const Route = createFileRoute("/api/campaigns/estimate")({
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

        const recipients = Number(payload["recipients"] ?? 0);
        if (!Number.isFinite(recipients) || recipients < 0) {
          return jsonError("We couldn't work out how many people this goes to.");
        }

        const category = String(payload["category"] ?? "marketing");
        try {
          const { estimateCampaignCost } = await import("@/lib/billing.server");
          const estimate = await estimateCampaignCost(auth.supabase, {
            organizationId: auth.organizationId,
            recipients: Math.floor(recipients),
            category: (["marketing", "utility", "authentication", "service"].includes(category)
              ? category
              : "marketing") as "marketing" | "utility" | "authentication" | "service",
            whatsappAccountId: (payload["whatsapp_account_id"] as string | null) ?? null,
            actorId: auth.userId,
          });
          return Response.json(estimate);
        } catch (error) {
          const { billingError } = await import("@/lib/billing-route.server");
          return billingError(error);
        }
      },
    },
  },
});
