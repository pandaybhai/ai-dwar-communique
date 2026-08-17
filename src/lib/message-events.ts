/**
 * The single shape every outbound message event carries.
 *
 * message.sent / message.delivered / message.read / message.failed are emitted
 * from three different places (manual inbox send, campaign sender, webhook
 * status callback). They previously each built their own property bag, which is
 * how three of them ended up shipping `properties: {}`. Every emit site now
 * builds its dimensions here, so a missing field is impossible by construction.
 */
export type OutboundMessageDimensionInput = {
  messageId: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  wabaId?: string | null;
  whatsappAccountId?: string | null;
  templateName?: string | null;
  messageType?: string | null;
  /** Meta billing category: marketing / utility / authentication / service. */
  billingCategory?: string | null;
  campaignId?: string | null;
  flowId?: string | null;
  flowStepId?: string | null;
  scheduledSendId?: string | null;
  errorCode?: string | null;
};

/**
 * Marketing vs transactional. Only marketing sends can earn revenue
 * attribution — an order confirmation cannot have caused the order it confirms.
 */
export function messageClassFor(
  category: string | null | undefined,
): "marketing" | "transactional" {
  return String(category ?? "").toLowerCase() === "marketing" ? "marketing" : "transactional";
}

export function outboundMessageDimensions(
  input: OutboundMessageDimensionInput,
): Record<string, unknown> {
  const billingCategory = String(input.billingCategory ?? "service").toLowerCase();
  const props: Record<string, unknown> = {
    message_id: input.messageId ?? null,
    conversation_id: input.conversationId ?? null,
    contact_id: input.contactId ?? null,
    whatsapp_account_id: input.whatsappAccountId ?? null,
    waba_id: input.wabaId ?? null,
    template_name: input.templateName ?? null,
    message_type: input.messageType ?? null,
    billing_category: billingCategory,
    message_class: messageClassFor(billingCategory),
    campaign_id: input.campaignId ?? null,
    flow_id: input.flowId ?? null,
    flow_step_id: input.flowStepId ?? null,
    scheduled_send_id: input.scheduledSendId ?? null,
  };
  if (input.errorCode !== undefined) props["error_code"] = input.errorCode ?? null;
  return props;
}
