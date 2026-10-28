import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): cancel a campaign that hasn't finished sending
 * — the app's own cancel (cancelCampaign). A finished one is a 409.
 */
export const Route = createFileRoute("/api/v1/campaigns/$campaignId/cancel")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { cancelCampaignViaApi } = await import("@/lib/public-api-campaigns.server");
        return runV1Route(request, { step: "campaign_cancel" }, ({ supabase, caller }) =>
          cancelCampaignViaApi(supabase, caller, String(params.campaignId ?? "").trim()),
        );
      },
    },
  },
});
