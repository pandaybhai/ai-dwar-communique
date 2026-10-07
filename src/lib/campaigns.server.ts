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

/**
 * A segment id that names no segment in this workspace (deleted, or never
 * ours). Sending to everyone must be an explicit choice (no segment id), so
 * this stops the estimate and the launch instead of widening the audience.
 */
export class SegmentNotFoundError extends Error {
  constructor() {
    super("That audience segment no longer exists. Pick another segment, or choose all contacts.");
    this.name = "SegmentNotFoundError";
  }
}

export function isSegmentNotFound(value: unknown): value is SegmentNotFoundError {
  return value instanceof SegmentNotFoundError;
}

async function segmentFiltersFor(
  supabase: SupabaseClient,
  organizationId: string,
  segmentId: string | null,
): Promise<unknown | null> {
  if (!segmentId) return null;
  const { data, error } = await supabase
    .from("segments")
    .select("id, filters")
    .eq("id", segmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  // A failed read is not "no segment": never fall back to everyone.
  if (error) throw new Error(`segment lookup failed: ${error.message}`);
  if (!data) throw new SegmentNotFoundError();
  return (data.filters ?? null) as unknown;
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

  // The Data API returns at most 1000 rows per read: page through.
  const out: AudienceContact[] = [];
  for (let from = 0; from < limit; from += 1000) {
    const { data } = await applySegment(
      supabase
        .from("contacts")
        .select("id, name, phone, attributes")
        .eq("organization_id", organizationId)
        .eq("opt_in_status", "opted_in")
        .order("id")
        .range(from, Math.min(from + 999, limit - 1)),
      match,
      expressions,
    );
    const rows = (data as AudienceContact[]) ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
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

export async function conversationFor(
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
  /** Coupon code for a copy-code button. One code serves every such button. */
  couponCode?: string | null;
  /** When a limited-time offer's countdown runs out. */
  offerExpiresAt?: string | null;
  /**
   * The picture, video or document for a media header, when the send supplies
   * its own. Templates authored in AiDwar remember the file they were built
   * with; ones synced from Meta don't, so the caller must pass one.
   */
  headerMediaUrl?: string | null;
  /** The map pin for a location header. */
  headerLocation?: { latitude: string; longitude: string; name?: string; address?: string } | null;

  /**
   * Per-card values for a carousel, in card order. A product carousel in a cart
   * reminder fills one entry per product; anything left out falls back to the
   * picture and link stored on the template itself.
   */
  cards?: Array<{
    mediaUrl?: string | null;
    values?: Record<string, string>;
    linkTarget?: string | null;
    couponCode?: string | null;
  }>;
};


export type TemplateRequest =
  | {
      ok: true;
      /** The components sent to Meta (body/header/buttons plus "open a form" tokens). */
      components: Array<Record<string, unknown>>;
      /** The template's own components as filled, for the inbox header picture. */
      payloadComponents: Array<Record<string, unknown>> | undefined;
    }
  | { ok: false; friendly: string; detail: string; code: string };

/**
 * Fills a template's components for one recipient: body/header values, link
 * buttons (one short link each), coupon codes, carousel cards and "open a
 * form" tokens. Shared by sendCampaignTemplate (flows, one message at a time)
 * and the campaign dispatcher (many at a time), so both build byte-identical
 * requests. Never writes anything itself: short links and form lookups go
 * through the callbacks.
 */
export async function buildTemplateRequest(args: {
  template: {
    name: string;
    variableOrder: number[];
    components?: import("@/lib/templates").TemplateComponent[] | null;
  };
  variables: Record<string, string>;
  context: SendCampaignContext;
  mintLink: (target: string) => Promise<{ token: string | null; error: string | null }>;
  /** The newest wa_forms row for a Meta flow id, or null. */
  formIdFor: (metaFlowId: string) => Promise<string | null>;
}): Promise<TemplateRequest> {
  const { template, variables, context, mintLink, formIdFor } = args;
  const buildFailure = (friendly: string, detail: string, code: string): TemplateRequest => ({
    ok: false,
    friendly,
    detail,
    code,
  });

  // What the template itself declares — body, header and dynamic link buttons.
  const { templateVariableSpec, buildTemplatePayloadComponents } = await import("@/lib/templates");
  const { emptyVariableSpec } = await import("@/lib/templates");
  const spec = template.components
    ? templateVariableSpec(template.components)
    : emptyVariableSpec(template.variableOrder);

  // Every dynamic link — on the message or on a carousel card — gets its own
  // short link (mintLink), so a click can be attributed to this send and card.
  const buttonTokens: Record<number, string> = {};
  if (spec.urlButtons.length > 0) {
    if (!context.linkTarget) {
      return buildFailure(
        "This message can't be sent: its button links somewhere we don't have a destination for.",
        JSON.stringify({ message: "missing_link_target", template: template.name }),
        "missing_link_target",
      );
    }
    for (const button of spec.urlButtons) {
      const { token, error } = await mintLink(context.linkTarget);
      if (!token) {
        return buildFailure(
          "This message can't be sent: we couldn't prepare its link.",
          JSON.stringify({ message: "short_link_failed", error }),
          "short_link_failed",
        );
      }
      buttonTokens[button.index] = token;
    }
  }

  // Copy-code buttons carry a coupon; one code covers every copy-code button
  // on the message, which is how Meta models it too.
  const couponCodes: Record<number, string> = {};
  for (const index of spec.copyCodeButtons) {
    if (context.couponCode?.trim()) couponCodes[index] = context.couponCode.trim();
  }

  // Carousel cards: per-card picture, per-card text, per-card link.
  const cardValues: import("@/lib/templates").CardValues[] = [];
  for (const card of spec.cards) {
    const supplied = context.cards?.[card.index] ?? {};
    const entry: import("@/lib/templates").CardValues = {};
    const mediaUrl = supplied.mediaUrl ?? card.mediaUrl;
    if (mediaUrl) entry.media = { link: mediaUrl };
    entry.values = supplied.values ?? variables;

    if (card.urlButtons.length > 0) {
      const target = supplied.linkTarget ?? context.linkTarget ?? null;
      if (!target) {
        return buildFailure(
          `This message can't be sent: card ${card.index + 1}'s button links somewhere we don't have a destination for.`,
          JSON.stringify({ message: "missing_link_target", card: card.index, template: template.name }),
          "missing_link_target",
        );
      }
      const tokens: Record<number, string> = {};
      for (const button of card.urlButtons) {
        const { token, error } = await mintLink(target);
        if (!token) {
          return buildFailure(
            `This message can't be sent: we couldn't prepare the link on card ${card.index + 1}.`,
            JSON.stringify({ message: "short_link_failed", card: card.index, error }),
            "short_link_failed",
          );
        }
        tokens[button.index] = token;
      }
      entry.buttonTokens = tokens;
    }

    const code = supplied.couponCode ?? context.couponCode ?? null;
    if (card.copyCodeButtons.length > 0 && code?.trim()) {
      entry.couponCodes = Object.fromEntries(
        card.copyCodeButtons.map((i) => [i, code.trim()]),
      );
    }
    cardValues.push(entry);
  }

  const offerExpirationMs = context.offerExpiresAt
    ? new Date(context.offerExpiresAt).getTime()
    : undefined;

  const payload = buildTemplatePayloadComponents({
    spec,
    values: variables,
    headerValues: variables,
    buttonTokens,
    couponCodes,
    ...(context.headerMediaUrl ? { headerMedia: { link: context.headerMediaUrl } } : {}),
    ...(context.headerLocation ? { headerLocation: context.headerLocation } : {}),
    ...(cardValues.length ? { cards: cardValues } : {}),
    ...(offerExpirationMs ? { offerExpirationMs } : {}),
  });

  if (payload.error) {
    return buildFailure(
      payload.error,
      JSON.stringify({ message: "template_parameters_missing", detail: payload.error }),
      "template_parameters_missing",
    );
  }

  // "Open a form" buttons carry a flow_token so the answers match back to our form.
  const flowButtonComponents: Array<Record<string, unknown>> = [];
  let flowFormId: string | null = null;
  {
    const buttonsComp = (template.components ?? []).find(
      (c) => String((c as { type?: string }).type ?? "").toUpperCase() === "BUTTONS",
    ) as { buttons?: Array<{ type?: string; flow_id?: string | number }> } | undefined;
    const buttons = buttonsComp?.buttons ?? [];
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i]!;
      if (String(b.type ?? "").toUpperCase() !== "FLOW") continue;
      const metaFlowId = b.flow_id != null ? String(b.flow_id) : "";
      if (metaFlowId && !flowFormId) {
        flowFormId = await formIdFor(metaFlowId);
      }
      const token = flowFormId
        ? `f:${flowFormId}:${crypto.randomUUID().slice(0, 8)}`
        : `t:${crypto.randomUUID().slice(0, 12)}`;
      flowButtonComponents.push({
        type: "button",
        sub_type: "flow",
        index: String(i),
        parameters: [{ type: "action", action: { flow_token: token } }],
      });
    }
  }
  const sendComponents = [...(payload.components ?? []), ...flowButtonComponents];
  return {
    ok: true,
    components: sendComponents,
    payloadComponents: payload.components as Array<Record<string, unknown>> | undefined,
  };
}

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

  // Every dynamic link — on the message or on a carousel card — gets its own
  // short link, so a click can be attributed to this send and this card.
  const { createShortLink } = await import("@/lib/short-links.server");
  const built = await buildTemplateRequest({
    template,
    variables: recipient.variables,
    context,
    mintLink: async (target) =>
      await createShortLink(supabase, {
        organizationId,
        targetUrl: target,
        scheduledSendId: context.scheduledSendId ?? null,
        campaignId: context.campaignId ?? null,
        contactId,
      }),
    formIdFor: async (metaFlowId) => {
      const { data: form } = await supabase
        .from("wa_forms")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("meta_flow_id", metaFlowId)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (form as { id: string } | null)?.id ?? null;
    },
  });
  if (!built.ok) return recordFailure(built.friendly, built.detail, built.code);
  const sendComponents = built.components;
  const { headerMediaFromComponents } = await import("@/lib/templates");

  const result = await graphFetch(`${sender.phoneNumberId}/messages`, sender.accessToken, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(sendComponents.length ? { components: sendComponents } : {}),
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
  const headerMedia = headerMediaFromComponents(built.payloadComponents as never);

  const sentRow = {
    organization_id: organizationId,
    conversation_id: conversationId,
    meta_message_id: metaMessageId,
    direction: "outbound",
    type: "template",
    template_name: template.name,
    ...(headerMedia
      ? { media_url: headerMedia.url, media_mime: headerMedia.kind }
      : {}),
    // The values it was sent with, so the inbox shows "Hi Priya", not "Hi {{1}}".
    ...(Object.keys(recipient.variables).length
      ? { metadata: { template_params: recipient.variables } }
      : {}),
    status: "pending",
    status_updated_at: nowIso,
    ...attribution,
  };
  // Meta accepted it, so it is sent whatever happens here; but without its
  // row the delivered status (and so the price) has nothing to land on. One
  // more try, then a loud log with the Meta id so the row can be put back.
  let { data: message, error: rowError } = await supabase
    .from("messages")
    .insert(sentRow)
    .select("id")
    .single();
  if (rowError) {
    ({ data: message, error: rowError } = await supabase
      .from("messages")
      .insert(sentRow)
      .select("id")
      .single());
    // Already there: the first try was written but its answer was lost.
    if (rowError && (rowError as { code?: string }).code === "23505" && metaMessageId) {
      ({ data: message, error: rowError } = await supabase
        .from("messages")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("meta_message_id", metaMessageId)
        .maybeSingle());
    }
  }
  if (rowError) {
    console.error(
      JSON.stringify({
        scope: "message_row_failed",
        organization_id: organizationId,
        meta_message_id: metaMessageId,
        campaign_id: context.campaignId ?? null,
        flow_id: context.flowId ?? null,
        error: rowError.message,
      }),
    );
  }

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

