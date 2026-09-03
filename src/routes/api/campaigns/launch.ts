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
        const accountIdRaw = (payload["whatsapp_account_id"] as string | null) || null;
        const mappings = (payload["variable_mappings"] ?? {}) as Record<
          string,
          { source: "name" | "phone" | "attribute" | "static"; key?: string; value?: string }
        >;

        // Media the sender chose for this campaign: the header picture/clip/file
        // and one file per carousel card. Only https links are kept.
        const rawSettings = (payload["send_settings"] ?? {}) as Record<string, unknown>;
        const httpsOrNull = (v: unknown): string | null => {
          const s = typeof v === "string" ? v.trim() : "";
          return s.startsWith("https://") ? s : null;
        };
        const sendSettings: Record<string, unknown> = {};
        const headerMedia = httpsOrNull(rawSettings["header_media_url"]);
        if (headerMedia) sendSettings["header_media_url"] = headerMedia;
        const cardsRaw = Array.isArray(rawSettings["cards"]) ? rawSettings["cards"] : [];
        const cards = cardsRaw.map((c) =>
          httpsOrNull((c as Record<string, unknown> | null)?.["media_url"]),
        );
        if (cards.some(Boolean)) sendSettings["cards"] = cards.map((media_url) => ({ media_url }));

        // Offer details: the coupon a copy-code button copies, and when a
        // limited-time offer's countdown runs out.
        const coupon =
          typeof rawSettings["coupon_code"] === "string"
            ? (rawSettings["coupon_code"] as string).trim().slice(0, 15)
            : "";
        if (coupon) sendSettings["coupon_code"] = coupon;
        const expiresRaw =
          typeof rawSettings["offer_expires_at"] === "string"
            ? (rawSettings["offer_expires_at"] as string)
            : "";
        if (expiresRaw && !Number.isNaN(new Date(expiresRaw).getTime())) {
          sendSettings["offer_expires_at"] = new Date(expiresRaw).toISOString();
        }

        if (!name) return jsonError("Give your campaign a name.");
        if (!templateName) return jsonError("Pick an approved template.");

        // A campaign sends from exactly one number; its WABA decides which
        // template library is valid.
        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        const { connection, error: connectionError } = await getWhatsAppConnection(
          supabase,
          organizationId,
          accountIdRaw,
        );
        if (!connection) {
          return jsonError(connectionError ?? "Connect a number before launching a campaign.");
        }

        const { data: template } = await supabase
          .from("message_templates")
          .select("name, language, components, status")
          .eq("organization_id", organizationId)
          .eq("waba_id", connection.wabaId)
          .eq("name", templateName)
          .eq("status", "APPROVED")
          .limit(1)
          .maybeSingle();
        if (!template) {
          return jsonError(
            "That template isn't approved on the number you picked. Choose another template or another number.",
          );
        }

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
            whatsapp_account_id: connection.accountId,
            template_name: template.name,
            template_language: template.language,
            variable_mappings: mappings,
            send_settings: sendSettings,
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

        const { emitEvent, recordUsage } = await import("@/lib/events.server");
        await emitEvent(supabase, "campaign.launched", {
          organizationId,
          actorUserId: userId,
          whatsappAccountId: connection.accountId,
          entityType: "campaign",
          entityId: campaign.id as string,
          properties: {
            campaign_id: campaign.id as string,
            template_name: templateName ?? null,
            segment_id: segmentId ?? null,
            waba_id: connection.wabaId,
            recipient_count: rows.length,
          },
        });
        await recordUsage(supabase, "campaign_messages", {
          organizationId,
          quantity: rows.length,
          metadata: {
            campaign_id: campaign.id as string,
            whatsapp_account_id: connection.accountId,
            stage: "queued",
          },
        });

        await logServerActivity(supabase, organizationId, userId, "campaign_launched", {
          name,
          recipient_count: rows.length,
          whatsapp_account_id: connection.accountId,
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
