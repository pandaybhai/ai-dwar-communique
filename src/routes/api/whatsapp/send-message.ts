import { createFileRoute } from "@tanstack/react-router";

const DAY_MS = 24 * 60 * 60 * 1000;

export const Route = createFileRoute("/api/whatsapp/send-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          requireOrgMember,
          isResponse,
          jsonError,
          graphFetch,
          graphErrorMessage,
          logServerActivity,
          normalizePhone,
          toWaId,
        } = await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const { supabase, organizationId, userId } = auth;

        // Replying is an inbox permission, not a role — agents hold it by preset.
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "inbox.reply", "reply to conversations");
        if (denied) return denied;

        const messageType = String(payload["message_type"] ?? "text");
        const conversationId = (payload["conversation_id"] as string) ?? null;
        const rawPhone = String(payload["phone"] ?? "").trim();
        const body = String(payload["body"] ?? "").trim();
        const templateName = String(payload["template_name"] ?? "").trim();
        const templateLanguage = String(payload["template_language"] ?? "en_US").trim();
        const templateComponents = Array.isArray(payload["template_components"])
          ? (payload["template_components"] as Array<Record<string, unknown>>)
          : [];

        if (messageType !== "text" && messageType !== "template") {
          return jsonError("Unsupported message type.");
        }
        if (messageType === "text" && !body) return jsonError("Message text is required.");
        if (messageType === "template" && !templateName) {
          return jsonError("Template name is required.");
        }

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");

        // Which number we send from: the conversation's number first (a reply
        // always leaves on the number the customer wrote to), then an explicit
        // pick, and only then the workspace default.
        type Conv = {
          id: string;
          contact_id: string | null;
          whatsapp_account_id: string | null;
          last_customer_message_at: string | null;
        };
        let conversation: Conv | null = null;

        if (conversationId) {
          const { data: conv } = await supabase
            .from("conversations")
            .select("id, contact_id, whatsapp_account_id, last_customer_message_at")
            .eq("id", conversationId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (!conv) return jsonError("Conversation not found.", 404);
          conversation = conv as Conv;
        }

        const requestedAccountId =
          conversation?.whatsapp_account_id ??
          ((payload["whatsapp_account_id"] as string | undefined) || null);

        const { connection, error: connectionError } = await getWhatsAppConnection(
          supabase,
          organizationId,
          requestedAccountId,
        );
        if (!connection) return jsonError(connectionError ?? "No connected number.", 400);

        // Resolve the recipient from the conversation's contact when we have one.
        let toPhone = toWaId(rawPhone);
        if (conversation?.contact_id) {
          const { data: contact } = await supabase
            .from("contacts")
            .select("phone, wa_id")
            .eq("id", conversation.contact_id)
            .maybeSingle();
          toPhone = toWaId(contact?.wa_id || contact?.phone || toPhone);
        }

        if (!toPhone || toPhone.length < 8) {
          return jsonError("A valid recipient phone number in E.164 format is required.");
        }

        // Contact upsert when sending to a raw number.
        let contactId = conversation?.contact_id ?? null;
        if (!contactId) {
          const phoneE164 = normalizePhone(toPhone);
          const { data: contact } = await supabase
            .from("contacts")
            .upsert(
              { organization_id: organizationId, phone: phoneE164, wa_id: toPhone },
              { onConflict: "organization_id,phone" },
            )
            .select("id")
            .single();
          contactId = contact?.id ?? null;
        }

        if (!conversation && contactId) {
          const { data: existing } = await supabase
            .from("conversations")
            .select("id, contact_id, whatsapp_account_id, last_customer_message_at")
            .eq("organization_id", organizationId)
            .eq("contact_id", contactId)
            // One thread per contact per number: the same customer writing to
            // sales and to support is two conversations, one contact.
            .eq("whatsapp_account_id", connection.accountId)
            .neq("status", "closed")
            .order("last_message_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existing) {
            conversation = existing as Conv;
          } else {
            const { data: created } = await supabase
              .from("conversations")
              .insert({
                organization_id: organizationId,
                contact_id: contactId,
                whatsapp_account_id: connection.accountId,
                status: "open",
              })
              .select("id, contact_id, whatsapp_account_id, last_customer_message_at")
              .single();
            conversation = (created ?? null) as Conv | null;
          }
        }

        // 24-hour customer service window — enforced server-side.
        if (messageType === "text") {
          const last = conversation?.last_customer_message_at
            ? new Date(conversation.last_customer_message_at).getTime()
            : 0;
          if (!last || Date.now() - last > DAY_MS) {
            return jsonError(
              "This contact hasn't messaged you in the last 24 hours, so free-form text isn't allowed. Send an approved template instead.",
              422,
            );
          }
        }

        const graphBody =
          messageType === "template"
            ? {
                messaging_product: "whatsapp",
                to: toPhone,
                type: "template",
                template: {
                  name: templateName,
                  language: { code: templateLanguage },
                  ...(templateComponents.length ? { components: templateComponents } : {}),
                },
              }
            : {
                messaging_product: "whatsapp",
                to: toPhone,
                type: "text",
                text: { body },
              };

        const result = await graphFetch(`${connection.phoneNumberId}/messages`, connection.accessToken, {
          method: "POST",
          body: graphBody,
        });

        if (!result.ok) {
          console.error(
            JSON.stringify({
              at: "send_message_rejected",
              organization_id: organizationId,
              user_id: userId,
              conversation_id: conversation?.id ?? null,
              message_type: messageType,
              status: result.status,
              provider_error: result.body["error"] ?? null,
            }),
          );
          return Response.json(
            { error: graphErrorMessage(result.body), provider_response: result.body },
            { status: 400 },
          );
        }


        const metaMessageId =
          ((result.body["messages"] as Array<Record<string, unknown>> | undefined)?.[0]?.[
            "id"
          ] as string) ?? null;

        const nowIso = new Date().toISOString();
        const { data: message } = await supabase
          .from("messages")
          .insert({
            organization_id: organizationId,
            conversation_id: conversation?.id ?? null,
            meta_message_id: metaMessageId,
            direction: "outbound",
            type: messageType,
            body: messageType === "text" ? body : null,
            template_name: messageType === "template" ? templateName : null,
            status: "pending",
            status_updated_at: nowIso,
            sent_by: userId,
          })
          .select("id, status, created_at")
          .single();

        if (conversation?.id) {
          await supabase
            .from("conversations")
            .update({ last_message_at: nowIso })
            .eq("id", conversation.id);
        }

        // Capture + metering. Meta bills on template category, so a text reply
        // inside the service window meters as "service" and a template meters
        // as whatever category Meta approved it under.
        const { emitEvent, recordUsage } = await import("@/lib/events.server");
        const { meterForMessageCategory } = await import("@/lib/events");
        let category = "service";
        if (messageType === "template") {
          const { data: tpl } = await supabase
            .from("message_templates")
            .select("category")
            .eq("organization_id", organizationId)
            .eq("waba_id", connection.wabaId)
            .eq("name", templateName)
            .maybeSingle();
          category = String((tpl as { category?: string } | null)?.category ?? "utility");
        }
        emitEvent(supabase, "message.sent", {
          organizationId,
          whatsappAccountId: connection.accountId,
          actorUserId: userId,
          entityType: "message",
          entityId: message?.id ?? null,
          properties: {
            message_type: messageType,
            template_name: messageType === "template" ? templateName : null,
            waba_id: connection.wabaId,
            category,
          },
        });
        recordUsage(supabase, meterForMessageCategory(category), {
          organizationId,
          quantity: 1,
          metadata: {
            whatsapp_account_id: connection.accountId,
            message_id: message?.id ?? null,
            message_type: messageType,
          },
        });

        await logServerActivity(supabase, organizationId, userId, "message_sent", {
          message_type: messageType,
          whatsapp_account_id: connection.accountId,
          ...(messageType === "template" ? { template_name: templateName } : {}),
        });

        return Response.json({
          message_id: message?.id ?? null,
          meta_message_id: metaMessageId,
          conversation_id: conversation?.id ?? null,
          whatsapp_account_id: connection.accountId,
          provider_response: result.body,
        });
      },
    },
  },
});
