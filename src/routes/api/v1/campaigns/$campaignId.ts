import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): one campaign with its counts
 * (sent / delivered / read / failed / replied). Another workspace's
 * campaign is a 404, as one that doesn't exist.
 */
export const Route = createFileRoute("/api/v1/campaigns/$campaignId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { getCampaignViaApi } = await import("@/lib/public-api-campaigns.server");
        return runV1Route(request, { step: "campaign_get" }, ({ supabase, caller }) =>
          getCampaignViaApi(supabase, caller, String(params.campaignId ?? "").trim()),
        );
      },
    },
  },
});
