import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): POST creates and launches a campaign through
 * the app's own launch (createCampaignViaApi -> launchCampaign); GET lists
 * the workspace's campaigns, newest first. Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/campaigns/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { MAX_CAMPAIGN_REQUEST_BYTES, createCampaignViaApi } =
          await import("@/lib/public-api-campaigns.server");
        return runV1Route(
          request,
          { step: "campaign_create", body: { maxBytes: MAX_CAMPAIGN_REQUEST_BYTES } },
          ({ supabase, caller, body }) =>
            createCampaignViaApi(supabase, caller, body, {
              idempotencyHeader: request.headers.get("idempotency-key"),
            }),
        );
      },
      GET: async ({ request }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { listCampaignsViaApi } = await import("@/lib/public-api-campaigns.server");
        return runV1Route(request, { step: "campaign_list" }, ({ supabase, caller }) =>
          listCampaignsViaApi(supabase, caller, new URL(request.url).searchParams),
        );
      },
    },
  },
});
