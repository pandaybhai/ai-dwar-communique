import type { SupabaseClient } from "@supabase/supabase-js";
import { applySegment, segmentExpressions } from "@/lib/segments.server";
import { graphFetch, graphErrorMessage } from "@/lib/whatsapp-api.server";
import { normalizePhone, toWaId } from "@/lib/phone";

export type AudienceContact = {
  id: string;
  name: string | null;
  phone: string;
  attributes: Record<string, unknown> | null;
};

export type AudienceSummary = {
  matched: number;
  eligible: number;
  excluded: number;
  sample: AudienceContact | null;
};

async function segmentFiltersFor(
  supabase: SupabaseClient,
  organizationId: string,
  segmentId: string | null,
): Promise<unknown | null> {
  if (!segmentId) return null;
  const { data } = await supabase
    .from("segments")
    .select("filters")
    .eq("id", segmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data?.filters ?? null) as unknown;
}

/** Counts the segment audience and how much of it is actually reachable. */
export async function audienceSummary(
  supabase: SupabaseClient,
  organizationId: string,
  segmentId: string | null,
): Promise<AudienceSummary> {
  const filters = await segmentFiltersFor(supabase, organizationId, segmentId);
  const { match, expressions } = filters
    ? await segmentExpressions(supabase, organizationId, filters)
    : { match: "all" as const, expressions: [] as string[] };

  const base = () =>
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq(
      "organization_id",
      organizationId,
    );

  const { count: matched } = await applySegment(base(), match, expressions);
  const { count: eligible } = await applySegment(
    base().eq("opt_in_status", "opted_in"),
    match,
    expressions,
  );

  const { data: sampleRows } = await applySegment(
    supabase
      .from("contacts")
      .select("id, name, phone, attributes")
      .eq("organization_id", organizationId)
      .eq("opt_in_status", "opted_in")
      .order("created_at", { ascending: false })
      .limit(1),
    match,
    expressions,
  );

  const m = matched ?? 0;
  const e = eligible ?? 0;
  return {
    matched: m,
    eligible: e,
    excluded: Math.max(0, m - e),
    sample: ((sampleRows as AudienceContact[]) ?? [])[0] ?? null,
  };
}

/** Full opted-in audience for a campaign launch. */
export async function resolveAudienceContacts(
  supabase: SupabaseClient,
  organizationId: string,
  segmentId: string | null,
  limit = 50000,
): Promise<AudienceContact[]> {
  const filters = await segmentFiltersFor(supabase, organizationId, segmentId);
  const { match, expressions } = filters
    ? await segmentExpressions(supabase, organizationId, filters)
    : { match: "all" as const, expressions: [] as string[] };

  const { data } = await applySegment(
    supabase
      .from("contacts")
      .select("id, name, phone, attributes")
      .eq("organization_id", organizationId)
      .eq("opt_in_status", "opted_in")
      .limit(limit),
    match,
    expressions,
  );
  return (data as AudienceContact[]) ?? [];
}

export type SenderContext = {
  accountId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
};

/**
 * A campaign sends from one chosen number (campaigns.whatsapp_account_id).
 * Only when nothing specifies one do we fall back to the workspace default —
 * which is exactly the old behaviour for a single-number workspace.
 */
export async function loadSenderContext(
  supabase: SupabaseClient,
  organizationId: string,
  whatsappAccountId?: string | null,
): Promise<SenderContext | null> {
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(supabase, organizationId, whatsappAccountId);
  if (!connection) return null;
  return {
    accountId: connection.accountId,
    wabaId: connection.wabaId,
    phoneNumberId: connection.phoneNumberId,
    accessToken: connection.accessToken,
  };
}

async function conversationFor(
  supabase: SupabaseClient,
  organizationId: string,
  accountId: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    // One thread per contact per number.
    .eq("whatsapp_account_id", accountId)
    .neq("status", "closed")
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created } = await supabase
    .from("conversations")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      whatsapp_account_id: accountId,
      status: "open",
    })
    .select("id")
    .single();
  return (created?.id as string) ?? null;
}

export type SendOutcome = { messageId: string | null; error: string | null };

/** Extra dimensions carried onto every per-message event and usage record. */
export type SendCampaignContext = {
  campaignId: string | null;
  /** Meta billing category of the template: marketing/utility/authentication/service. */
  category: string;
  /** Flow attribution, when the send came from the flow worker. */
  flowId?: string | null;
  flowStepId?: string | null;
  scheduledSendId?: string | null;
  /** Destination for a dynamic URL button, shortened at send time. */
  linkTarget?: string | null;
};


/**
 * Sends one campaign template message and records it in the inbox.
 *
 * Both outcomes leave a messages row behind: a rejected send is a real message
 * with status 'failed' and the provider's full error in error_detail, so a
 * campaign that fails at the Graph call is never invisible.
 */
export async function sendCampaignTemplate(
  supabase: SupabaseClient,
  organizationId: string,
  sender: SenderContext,
  recipient: { contactId: string | null; phone: string; variables: Record<string, string> },
  template: {
    name: string;
    language: string;
    variableOrder: number[];
    /** The template's stored components, so link buttons can be filled generically. */
    components?: import("@/lib/templates").TemplateComponent[] | null;
  },
  context: SendCampaignContext = { campaignId: null, category: "marketing" },
): Promise<SendOutcome> {
  const { emitEvent, recordUsage } = await import("@/lib/events.server");
  const { meterForMessageCategory } = await import("@/lib/events");
  const { providerErrorDetail, providerErrorCode } = await import("@/lib/whatsapp-api.server");

  const to = toWaId(recipient.phone);

  let contactId = recipient.contactId;
  if (!contactId && to && to.length >= 8) {
    const { data: contact } = await supabase
      .from("contacts")
      .upsert(
        { organization_id: organizationId, phone: normalizePhone(to), wa_id: to },
        { onConflict: "organization_id,phone" },
      )
      .select("id")
      .single();
    contactId = (contact?.id as string) ?? null;
  }

  const conversationId = await conversationFor(
    supabase,
    organizationId,
    sender.accountId,
    contactId,
  );

  // Every per-message event carries the same dimensions, so sent/delivered/read
  // can be filtered by campaign, template, number and billing bucket alike.
  const { outboundMessageDimensions } = await import("@/lib/message-events");

  /** Attribution written onto every messages row this sender creates. */
  const attribution = {
    campaign_id: context.campaignId ?? null,
    flow_id: context.flowId ?? null,
    flow_step_id: context.flowStepId ?? null,
    scheduled_send_id: context.scheduledSendId ?? null,
  };

  const dimensions = (messageId: string | null, errorCode?: string | null) =>
    outboundMessageDimensions({
      messageId,
      conversationId,
      contactId,
      wabaId: sender.wabaId,
      whatsappAccountId: sender.accountId,
      templateName: template.name,
      messageType: "template",
      billingCategory: context.category,
      campaignId: context.campaignId,
      flowId: context.flowId ?? null,
      flowStepId: context.flowStepId ?? null,
      scheduledSendId: context.scheduledSendId ?? null,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });

  /** Writes the failed message row + event, so no rejection goes unrecorded. */
  const recordFailure = async (friendly: string, detail: string, errorCode: string | null) => {

    const nowIso = new Date().toISOString();
    const { data: failedRow } = await supabase
      .from("messages")
      .insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        direction: "outbound",
        type: "template",
        template_name: template.name,
        status: "failed",
        status_updated_at: nowIso,
        error_detail: detail,
        ...attribution,
      })
      .select("id")
      .single();

    await emitEvent(supabase, "message.failed", {
      organizationId,
      whatsappAccountId: sender.accountId,
      entityType: "message",
      entityId: (failedRow?.id as string) ?? null,
      properties: dimensions((failedRow?.id as string) ?? null, errorCode),
    });


    return { messageId: (failedRow?.id as string) ?? null, error: friendly.slice(0, 300) };
  };

  if (!to || to.length < 8) {
    return recordFailure(
      "Invalid phone number.",
      JSON.stringify({ message: "invalid_phone_number", phone: recipient.phone }),
      "invalid_phone_number",
    );
  }

  // What the template itself declares — body, header and dynamic link buttons.
  const { templateVariableSpec, buildTemplatePayloadComponents } = await import("@/lib/templates");
  const spec = template.components
    ? templateVariableSpec(template.components)
    : { header: [], body: template.variableOrder, urlButtons: [] };

  // A URL button with a variable needs a short link minted for this send.
  const buttonTokens: Record<number, string> = {};
  if (spec.urlButtons.length > 0) {
    if (!context.linkTarget) {
      return recordFailure(
        "This message can't be sent: its button links somewhere we don't have a destination for.",
        JSON.stringify({ message: "missing_link_target", template: template.name }),
        "missing_link_target",
      );
    }
    const { createShortLink } = await import("@/lib/short-links.server");
    for (const button of spec.urlButtons) {
      const { token, error } = await createShortLink(supabase, {
        organizationId,
        targetUrl: context.linkTarget,
        scheduledSendId: context.scheduledSendId ?? null,
        campaignId: context.campaignId ?? null,
        contactId,
      });
      if (!token) {
        return recordFailure(
          "This message can't be sent: we couldn't prepare its link.",
          JSON.stringify({ message: "short_link_failed", error }),
          "short_link_failed",
        );
      }
      buttonTokens[button.index] = token;
    }
  }

  const payload = buildTemplatePayloadComponents({
    spec,
    values: recipient.variables,
    headerValues: recipient.variables,
    buttonTokens,
  });
  if (payload.error) {
    return recordFailure(
      payload.error,
      JSON.stringify({ message: "template_parameters_missing", detail: payload.error }),
      "template_parameters_missing",
    );
  }

  const result = await graphFetch(`${sender.phoneNumberId}/messages`, sender.accessToken, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(payload.components && payload.components.length
          ? { components: payload.components }
          : {}),
      },
    },
  });


  if (!result.ok) {
    return recordFailure(
      graphErrorMessage(result.body),
      providerErrorDetail(result.body),
      providerErrorCode(result.body),
    );
  }

  const metaMessageId =
    ((result.body["messages"] as Array<Record<string, unknown>> | undefined)?.[0]?.["id"] as
      | string
      | undefined) ?? null;

  const nowIso = new Date().toISOString();

  const { data: message } = await supabase
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "template",
      template_name: template.name,
      status: "pending",
      status_updated_at: nowIso,
      ...attribution,
    })
    .select("id")
    .single();

  if (conversationId) {
    await supabase.from("conversations").update({ last_message_at: nowIso }).eq("id", conversationId);
  }

  const messageId = (message?.id as string) ?? null;

  await emitEvent(supabase, "message.sent", {
    organizationId,
    whatsappAccountId: sender.accountId,
    entityType: "message",
    entityId: messageId,
    properties: dimensions(messageId),
  });
  // Meta bills per template category, so the meter is recorded on the same path.
  await recordUsage(supabase, meterForMessageCategory(context.category), {
    organizationId,
    quantity: 1,
    metadata: {
      whatsapp_account_id: sender.accountId,
      waba_id: sender.wabaId,
      campaign_id: context.campaignId,
      flow_id: context.flowId ?? null,
      flow_step_id: context.flowStepId ?? null,
      template_name: template.name,
      message_id: messageId,
      message_type: "template",
    },
  });


  return { messageId, error: null };
}

