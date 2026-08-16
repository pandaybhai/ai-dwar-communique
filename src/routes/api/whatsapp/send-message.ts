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

        // Account + credentials (service-role only).
        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("id, phone_number_id")
          .eq("organization_id", organizationId)
          .eq("status", "active")
          .order("connected_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!account) {
          return jsonError("Connect a WhatsApp number before sending messages.", 400);
        }

        const { data: cred } = await supabase
          .from("whatsapp_credentials")
          .select("access_token")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!cred?.access_token) {
          return jsonError("Your WhatsApp credentials are missing. Reconnect the number.", 400);
        }

        // Resolve conversation + contact.
        type Conv = {
          id: string;
          contact_id: string | null;
          last_customer_message_at: string | null;
        };
        let conversation: Conv | null = null;
        let toPhone = toWaId(rawPhone);

        if (conversationId) {
          const { data: conv } = await supabase
            .from("conversations")
            .select("id, contact_id, last_customer_message_at")
            .eq("id", conversationId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (!conv) return jsonError("Conversation not found.", 404);
          conversation = conv as Conv;
          if (conv.contact_id) {
            const { data: contact } = await supabase
              .from("contacts")
              .select("phone, wa_id")
              .eq("id", conv.contact_id)
              .maybeSingle();
            toPhone = toWaId(contact?.wa_id || contact?.phone || toPhone);
          }
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
            .select("id, contact_id, last_customer_message_at")
            .eq("organization_id", organizationId)
            .eq("contact_id", contactId)
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
                whatsapp_account_id: account.id,
                status: "open",
              })
              .select("id, contact_id, last_customer_message_at")
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

        const result = await graphFetch(`${account.phone_number_id}/messages`, cred.access_token, {
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

        await logServerActivity(supabase, organizationId, userId, "message_sent", {
          message_type: messageType,
          ...(messageType === "template" ? { template_name: templateName } : {}),
        });

        return Response.json({
          message_id: message?.id ?? null,
          meta_message_id: metaMessageId,
          conversation_id: conversation?.id ?? null,
          provider_response: result.body,
        });
      },
    },
  },
});
