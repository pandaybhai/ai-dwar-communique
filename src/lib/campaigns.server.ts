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
  phoneNumberId: string;
  accessToken: string;
};

export async function loadSenderContext(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SenderContext | null> {
  const { data: account } = await supabase
    .from("whatsapp_accounts")
    .select("id, phone_number_id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!account) return null;

  const { data: cred } = await supabase
    .from("whatsapp_credentials")
    .select("access_token")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!cred?.access_token) return null;

  return {
    accountId: account.id as string,
    phoneNumberId: account.phone_number_id as string,
    accessToken: cred.access_token as string,
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

/** Sends one campaign template message and records it in the inbox. */
export async function sendCampaignTemplate(
  supabase: SupabaseClient,
  organizationId: string,
  sender: SenderContext,
  recipient: { contactId: string | null; phone: string; variables: Record<string, string> },
  template: { name: string; language: string; variableOrder: number[] },
): Promise<SendOutcome> {
  const to = toWaId(recipient.phone);
  if (!to || to.length < 8) return { messageId: null, error: "Invalid phone number." };

  const parameters = template.variableOrder.map((n) => ({
    type: "text",
    text: recipient.variables[String(n)] ?? "",
  }));

  const result = await graphFetch(`${sender.phoneNumberId}/messages`, sender.accessToken, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(parameters.length ? { components: [{ type: "body", parameters }] } : {}),
      },
    },
  });

  if (!result.ok) return { messageId: null, error: graphErrorMessage(result.body).slice(0, 300) };

  const metaMessageId =
    ((result.body["messages"] as Array<Record<string, unknown>> | undefined)?.[0]?.["id"] as
      | string
      | undefined) ?? null;

  let contactId = recipient.contactId;
  if (!contactId) {
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
    })
    .select("id")
    .single();

  if (conversationId) {
    await supabase.from("conversations").update({ last_message_at: nowIso }).eq("id", conversationId);
  }

  return { messageId: (message?.id as string) ?? null, error: null };
}
