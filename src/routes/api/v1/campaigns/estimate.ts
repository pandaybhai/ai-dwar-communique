import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): who a campaign would reach and what it would
 * cost — the same audience and estimate a launch uses. Nothing is created.
 */
export const Route = createFileRoute("/api/v1/campaigns/estimate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { MAX_CAMPAIGN_REQUEST_BYTES, estimateCampaignViaApi } =
          await import("@/lib/public-api-campaigns.server");
        return runApiRoute(
          request,
          { step: "campaign_estimate", body: { maxBytes: MAX_CAMPAIGN_REQUEST_BYTES } },
          ({ supabase, caller, body }) => estimateCampaignViaApi(supabase, caller, body),
        );
      },
    },
  },
});
