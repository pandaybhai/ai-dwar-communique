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

        // Starting or restarting spend needs an unlocked workspace; pausing
        // and cancelling stay open so a locked workspace can still stop work.
        if (action === "resume" || action === "approve") {
          const { data: orgRow } = await supabase
            .from("organizations")
            .select("plan_status")
            .eq("id", organizationId)
            .maybeSingle();
          const planStatus = (orgRow as { plan_status?: string | null } | null)?.plan_status ?? null;
          if (planStatus === "locked" || planStatus === "paused") {
            return jsonError("This workspace is locked — choose a plan to continue.", 402);
          }
        }

        const { data: campaign } = await supabase
          .from("campaigns")
          .select("id, status, scheduled_at, held_amount, charged_amount, estimated_cost")
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
          const { data: moved, error: moveError } = await supabase
            .from("campaigns")
            .update({
              status: future ? "scheduled" : "sending",
              started_at: future ? null : new Date().toISOString(),
              approved_by: userId,
              approved_at: new Date().toISOString(),
            })
            .eq("id", campaignId)
            .eq("status", "awaiting_approval")
            .select("id");
          if (moveError) return jsonError("We couldn't update this campaign. Please try again.", 500);
          if (!moved?.length) return jsonError("This campaign changed meanwhile. Refresh and try again.");
        } else if (action === "pause") {
          if (status !== "sending" && status !== "scheduled") {
            return jsonError("Only a running or scheduled campaign can be paused.");
          }
          // Conditional on the status just read: a campaign that completed
          // meanwhile is never flipped back.
          const { data: moved, error: moveError } = await supabase
            .from("campaigns")
            .update({ status: "paused" })
            .eq("id", campaignId)
            .in("status", ["sending", "scheduled"])
            .select("id");
          if (moveError) return jsonError("We couldn't update this campaign. Please try again.", 500);
          if (!moved?.length) return jsonError("This campaign has already finished.");
        } else if (action === "resume") {
          if (status !== "paused") return jsonError("This campaign isn't paused.");
          // Not reserved yet (paused before it started, e.g. for credits): the
          // worker would only pause it again, so say so now (Batch 26a).
          const estimate = Number(campaign.estimated_cost ?? 0);
          if (estimate > 0 && Number(campaign.held_amount ?? 0) <= 0) {
            const { billingEnabled, creditsCover } = await import("@/lib/billing.server");
            if (await billingEnabled(supabase, organizationId)) {
              const cover = await creditsCover(supabase, organizationId, estimate);
              if (!cover.covers) {
                return jsonError(
                  `This campaign needs about ${estimate.toFixed(2)} in credits and ${Math.max(0, cover.available).toFixed(2)} is available. Add credits, then resume.`,
                  402,
                );
              }
            }
          }
          const future =
            campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now();
          const { data: moved, error: moveError } = await supabase
            .from("campaigns")
            .update({ status: future ? "scheduled" : "sending" })
            .eq("id", campaignId)
            .eq("status", "paused")
            .select("id");
          if (moveError) return jsonError("We couldn't update this campaign. Please try again.", 500);
          if (!moved?.length) return jsonError("This campaign isn't paused.");
          // Best effort: a database without the column still resumes.
          await supabase
            .from("campaigns")
            .update({ pause_reason: null })
            .eq("id", campaignId)
            .then(
              () => null,
              () => null,
            );
        } else {
          // Shared with the Public API's cancel (Batch 38).
          const { cancelCampaign } = await import("@/lib/campaign-launch.server");
          const cancelled = await cancelCampaign(supabase, organizationId, campaignId);
          if (!cancelled.ok) return jsonError(cancelled.error, cancelled.finished ? 400 : 500);
        }

        await logServerActivity(supabase, organizationId, userId, `campaign_${action}d`, {
          campaign_id: campaignId,
        });

        return Response.json({ ok: true });

      },
    },
  },
});
