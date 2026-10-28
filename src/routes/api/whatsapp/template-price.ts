import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 35: what one approved template costs to this conversation's contact,
 * shown in the inbox's template picker before sending (the client rate for
 * the template's category in the contact's country — what the debit charges).
 * Whoever can reply in the inbox may ask.
 */
export const Route = createFileRoute("/api/whatsapp/template-price")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(
          request,
          (payload["organization_id"] as string) ?? null,
        );
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "inbox.reply", "send messages");
        if (denied) return denied;
        const { supabase, organizationId } = auth;

        const conversationId = String(payload["conversation_id"] ?? "");
        const templateName = String(payload["template_name"] ?? "").trim();
        if (!conversationId || !templateName) return jsonError("Invalid request.");

        const { data: conv } = await supabase
          .from("conversations")
          .select("id, whatsapp_account_id, contacts(phone)")
          .eq("id", conversationId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        const conversation = conv as {
          whatsapp_account_id: string | null;
          contacts: { phone?: string | null } | null;
        } | null;
        const phone = conversation?.contacts?.phone ?? "";
        if (!conversation || !phone) return jsonError("Conversation not found.", 404);

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        const { connection } = await getWhatsAppConnection(
          supabase,
          organizationId,
          conversation.whatsapp_account_id,
        );
        if (!connection) return jsonError("This conversation's number isn't connected.", 400);
        const { data: tpl } = await supabase
          .from("message_templates")
          .select("category")
          .eq("organization_id", organizationId)
          .eq("waba_id", connection.wabaId)
          .eq("name", templateName)
          .limit(1)
          .maybeSingle();

        const { billingCategoryOf, quoteTemplateMessages } =
          await import("@/lib/message-price.server");
        const quote = await quoteTemplateMessages(
          supabase,
          organizationId,
          billingCategoryOf((tpl as { category?: string | null } | null)?.category),
          [phone],
        );
        return Response.json({
          enabled: quote.enabled,
          category: quote.category,
          rate: quote.perNumber[0]?.rate ?? 0,
          currency: quote.currency,
        });
      },
    },
  },
});
