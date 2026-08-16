import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/campaigns/launch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, logServerActivity } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { resolveAudienceContacts } = await import("@/lib/campaigns.server");
        const { extractVariables, templateBodyText } = await import("@/lib/templates");
        const { resolveAllVariables } = await import("@/lib/campaigns");
        const { normalizePhone } = await import("@/lib/phone");

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

        const name = String(payload["name"] ?? "").trim();
        const templateName = String(payload["template_name"] ?? "").trim();
        const segmentId = (payload["segment_id"] as string | null) || null;
        const scheduledAtRaw = (payload["scheduled_at"] as string | null) || null;
        const mappings = (payload["variable_mappings"] ?? {}) as Record<
          string,
          { source: "name" | "phone" | "attribute" | "static"; key?: string; value?: string }
        >;

        if (!name) return jsonError("Give your campaign a name.");
        if (!templateName) return jsonError("Pick an approved template.");

        const { data: template } = await supabase
          .from("message_templates")
          .select("name, language, components, status")
          .eq("organization_id", organizationId)
          .eq("name", templateName)
          .eq("status", "APPROVED")
          .limit(1)
          .maybeSingle();
        if (!template) return jsonError("That template isn't approved for sending.");

        const variableOrder = extractVariables(
          templateBodyText(template.components as never),
        );

        const contacts = await resolveAudienceContacts(supabase, organizationId, segmentId);
        if (contacts.length === 0) {
          return jsonError(
            "No opted-in contacts match this audience yet, so there's nobody to send to.",
          );
        }

        const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;
        const isFuture = Boolean(scheduledAt && scheduledAt.getTime() > Date.now() + 30_000);
        const nowIso = new Date().toISOString();

        const { data: campaign, error: campaignErr } = await supabase
          .from("campaigns")
          .insert({
            organization_id: organizationId,
            name,
            template_name: template.name,
            template_language: template.language,
            variable_mappings: mappings,
            segment_id: segmentId,
            status: isFuture ? "scheduled" : "sending",
            scheduled_at: scheduledAt ? scheduledAt.toISOString() : null,
            started_at: isFuture ? null : nowIso,
            total_recipients: contacts.length,
            created_by: userId,
          })
          .select("id, status")
          .single();

        if (campaignErr || !campaign) {
          return jsonError("We couldn't create this campaign. Please try again.", 500);
        }

        const rows = contacts.map((c) => ({
          campaign_id: campaign.id as string,
          organization_id: organizationId,
          contact_id: c.id,
          phone: normalizePhone(c.phone),
          resolved_variables: resolveAllVariables(variableOrder, mappings, c),
        }));

        for (let i = 0; i < rows.length; i += 500) {
          const { error: insErr } = await supabase
            .from("campaign_recipients")
            .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,contact_id" });
          if (insErr) {
            await supabase
              .from("campaigns")
              .update({ status: "failed" })
              .eq("id", campaign.id as string);
            return jsonError("We couldn't build the recipient list. Please try again.", 500);
          }
        }

        await logServerActivity(supabase, organizationId, userId, "campaign_launched", {
          name,
          recipient_count: rows.length,
        });

        return Response.json({
          campaign_id: campaign.id,
          status: campaign.status,
          total_recipients: rows.length,
        });
      },
    },
  },
});
