import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/campaigns/control")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, logServerActivity } = await import(
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
        const { supabase, organizationId, userId } = auth;
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "campaigns.send", "control campaigns");
        if (denied) return denied;

        const campaignId = String(payload["campaign_id"] ?? "");
        const action = String(payload["action"] ?? "");
        if (!campaignId) return jsonError("Campaign not found.", 404);
        if (!["pause", "resume", "cancel", "approve"].includes(action)) {
          return jsonError("Unknown action.");
        }

        const { data: campaign } = await supabase
          .from("campaigns")
          .select("id, status, scheduled_at, held_amount, charged_amount")
          .eq("id", campaignId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!campaign) return jsonError("Campaign not found.", 404);

        const status = String(campaign.status);
        if (["completed", "cancelled", "failed"].includes(status)) {
          return jsonError("This campaign has already finished.");
        }

        if (action === "approve") {
          if (status !== "awaiting_approval") return jsonError("This campaign isn't waiting for approval.");
          const { requirePermission: requirePerm } = await import("@/lib/whatsapp-api.server");
          const notAllowed = await requirePerm(auth, "billing.manage", "approve campaign spend");
          if (notAllowed) return notAllowed;
          const future =
            campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now();
          await supabase
            .from("campaigns")
            .update({
              status: future ? "scheduled" : "sending",
              started_at: future ? null : new Date().toISOString(),
              approved_by: userId,
              approved_at: new Date().toISOString(),
            })
            .eq("id", campaignId);
        } else if (action === "pause") {
          if (status !== "sending" && status !== "scheduled") {
            return jsonError("Only a running or scheduled campaign can be paused.");
          }
          await supabase.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
        } else if (action === "resume") {
          if (status !== "paused") return jsonError("This campaign isn't paused.");
          const future =
            campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now();
          await supabase
            .from("campaigns")
            .update({ status: future ? "scheduled" : "sending" })
            .eq("id", campaignId);
        } else {
          await supabase
            .from("campaign_recipients")
            .update({ status: "skipped" })
            .eq("campaign_id", campaignId)
            .in("status", ["queued", "sending"]);
          await supabase
            .from("campaigns")
            .update({ status: "cancelled", completed_at: new Date().toISOString() })
            .eq("id", campaignId);

          // Whatever was reserved and not spent goes back to the wallet.
          const { settleCampaignSpend } = await import("@/lib/campaign-billing.server");
          await settleCampaignSpend(supabase, organizationId, campaignId);
        }

        await logServerActivity(supabase, organizationId, userId, `campaign_${action}d`, {
          campaign_id: campaignId,
        });

        return Response.json({ ok: true });

      },
    },
  },
});
