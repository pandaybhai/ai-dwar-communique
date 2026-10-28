import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/campaigns/launch")({
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
        const { supabase, organizationId, userId } = auth;
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "campaigns.send", "launch campaigns");
        if (denied) return denied;

        // Media the sender chose for this campaign: the header picture/clip/file
        // and one file per carousel card (only https links), coupons and the
        // offer end — the same rules the test send uses (Batch 35).
        const { sanitizeSendSettings } = await import("@/lib/campaigns");
        const scheduledAtRaw = (payload["scheduled_at"] as string | null) || null;

        // The launch itself is shared with the Public API (Batch 38).
        const { launchCampaign } = await import("@/lib/campaign-launch.server");
        const result = await launchCampaign(supabase, {
          organizationId,
          userId,
          name: String(payload["name"] ?? ""),
          templateName: String(payload["template_name"] ?? ""),
          whatsappAccountId: (payload["whatsapp_account_id"] as string | null) || null,
          segmentId: (payload["segment_id"] as string | null) || null,
          mappings: (payload["variable_mappings"] ?? {}) as import("@/lib/campaigns").VariableMappings,
          sendSettings: sanitizeSendSettings(payload["send_settings"]),
          scheduledAt: scheduledAtRaw ? new Date(scheduledAtRaw) : null,
        });
        if (!result.ok) {
          if (result.estimate) {
            return Response.json({ error: result.error, estimate: result.estimate }, { status: result.status });
          }
          return jsonError(result.error, result.status);
        }

        return Response.json({
          campaign_id: result.campaignId,
          status: result.status,
          total_recipients: result.totalRecipients,
          needs_approval: result.needsApproval,
          estimated_cost: result.estimatedCost,
        });
      },
    },
  },
});
