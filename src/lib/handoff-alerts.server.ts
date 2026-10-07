/**
 * Hand-off alerts (Batch 16 item 2).
 *
 * When a chat genuinely needs a person — the customer asked for one, or a
 * flow's Assign step ran — the workspace's staff are told: a WhatsApp from
 * the AiDwar platform number to a staff number (1–2 of them), else an email.
 * The Inbox shows the chat as "Waiting for you". One reminder goes after 30
 * minutes, inside business hours only. Nothing here ever hands the chat back
 * to Aiden: needs_human is only ever cleared by a person.
 *
 * Never to the business's own WhatsApp number: an alert sent from the
 * platform to the shop's own number lands in the very inbox it is about
 * (a workspace whose owner_phone is its own sending number). Saving such a number
 * is refused with a plain explanation, and every send checks again.
 *
 * Alerts are never customer reply text: they go to staff, not customers.
 *
 * Batch 21: free text from the platform number only arrives inside the 24-hour
 * window, so outside it the alert goes as the approved UTILITY template
 * staff_handoff_alert (STAFF_HANDOFF_TEMPLATE); until Meta approves it,
 * nothing changes (email as before).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { DEFAULT_BUSINESS_HOURS, isBusinessOpen, type BusinessHours } from "@/lib/flow-graph";

export const MAX_ALERT_PHONES = 2;
export const REMIND_AFTER_MS = 30 * 60_000;

export type HandoffAlertSettings = {
  phones: string[];
  email: string | null;
};

/** Same number, written either way: "+91 98000 00098", "09800000098", "919800000098". */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? "").replace(/\D/g, "");
  const y = String(b ?? "").replace(/\D/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}

/** The workspace's own WhatsApp business numbers. */
export async function businessNumbers(supabase: SupabaseClient, organizationId: string): Promise<string[]> {
  const { data } = await supabase
    .from("whatsapp_accounts")
    .select("display_phone_number")
    .eq("organization_id", organizationId);
  return ((data ?? []) as Array<{ display_phone_number?: string | null }>)
    .map((r) => String(r.display_phone_number ?? "").trim())
    .filter(Boolean);
}

/**
 * Check what the merchant typed. Errors are plain sentences for the screen.
 * Pure: the business numbers are passed in.
 */
export function validateAlertSettings(
  input: { phones?: unknown; email?: unknown },
  ownNumbers: string[],
): { ok: true; settings: HandoffAlertSettings } | { ok: false; error: string } {
  const raw = Array.isArray(input.phones) ? input.phones : [];
  const phones: string[] = [];
  for (const value of raw) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const phone = normalizePhone(text);
    if (phone.replace(/\D/g, "").length < 10)
      return { ok: false, error: `“${text}” doesn't look like a full WhatsApp number. Add it with the country code, like +91 98765 43210.` };
    const own = ownNumbers.find((n) => samePhone(n, phone));
    if (own)
      return {
        ok: false,
        error: `${text} is this business's own WhatsApp number. An alert sent there would land in the same inbox it's about, so nobody would see it. Add a staff member's personal WhatsApp number instead.`,
      };
    if (!phones.some((p) => samePhone(p, phone))) phones.push(phone);
  }
  if (phones.length > MAX_ALERT_PHONES)
    return { ok: false, error: `Add at most ${MAX_ALERT_PHONES} staff WhatsApp numbers.` };
  const emailText = String(input.email ?? "").trim();
  if (emailText && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailText))
    return { ok: false, error: `“${emailText}” doesn't look like an email address.` };
  return { ok: true, settings: { phones, email: emailText || null } };
}

/** The saved settings (a failed read means none). */
export async function loadAlertSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<HandoffAlertSettings & { hours: BusinessHours; timezone: string }> {
  const { data, error } = await supabase
    .from("organization_ai_settings")
    .select("handoff_alert_phones, handoff_alert_email, handoff_alert_hours")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const row = (error ? null : data) as {
    handoff_alert_phones?: string[] | null;
    handoff_alert_email?: string | null;
    handoff_alert_hours?: BusinessHours | null;
  } | null;
  let timezone = "Asia/Kolkata";
  try {
    const { loadSendSettings } = await import("@/lib/flows.server");
    timezone = (await loadSendSettings(supabase, organizationId)).timezone || timezone;
  } catch {
    // the default zone is fine for a reminder
  }
  return {
    phones: (row?.handoff_alert_phones ?? []).filter(Boolean),
    email: row?.handoff_alert_email ?? null,
    hours: row?.handoff_alert_hours ?? DEFAULT_BUSINESS_HOURS,
    timezone,
  };
}

/** The AiDwar platform number's open chat with this staff phone, or null (no chat / window closed). */
async function platformChannelFor(supabase: SupabaseClient, phone: string) {
  const { onboardingChannelFor } = await import("@/lib/owner-replies.server");
  const channel = await onboardingChannelFor(supabase, phone);
  if (!channel) return null;
  const { data } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", channel.conversationId)
    .maybeSingle();
  const { isServiceWindowOpen } = await import("@/lib/service-window");
  return isServiceWindowOpen(data as { last_customer_message_at?: string | null } | null) ? channel : null;
}

export type AlertOutcome = {
  whatsapp: string[];
  email: string | null;
  refused: string[];
  skipped?: string;
  /** Of `whatsapp`, the numbers reached with the staff_handoff_alert template (outside the 24-hour window). */
  templated?: string[];
  /** Why the email fallback didn't go (e.g. email_not_configured, or Resend's error text). */
  email_error?: string;
};

/**
 * Batch 21: the staff alert as an approved UTILITY template, for a staff
 * number outside WhatsApp's 24-hour window with the platform number (free
 * text only arrives inside it). Same shape as the platform's notice
 * templates (billing-notify BILLING_TEMPLATES): Meta rejects a body that
 * starts or ends with a variable, so it is wrapped in words. Never customer
 * reply text: it goes to staff.
 */
export const STAFF_HANDOFF_TEMPLATE = {
  name: "staff_handoff_alert",
  body: "AiDwar alert for {{1}}: {{2}} is waiting for a person in the Inbox because {{3}}. Open the Inbox here: {{4}} — Aiden has stepped back on this chat until your team replies.",
  examples: ["Sharma Textiles", "Asha (+91 98765 43210)", "a customer asked to talk to a person", "https://aidwar.in/app/inbox"],
};
export const INBOX_LINK = "https://aidwar.in/app/inbox";

/** A template variable: one line, no tabs or runs of spaces (Meta refuses them), capped. */
function templateParam(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** The four values for STAFF_HANDOFF_TEMPLATE: workspace, customer, short reason, inbox link. */
export function staffAlertParams(args: { business: string; customer: string; why: string; reminder?: boolean }): string[] {
  return [
    templateParam(args.business, 60),
    templateParam(args.customer, 60),
    templateParam(`${args.reminder ? "(reminder, still waiting) " : ""}${args.why}`, 120),
    INBOX_LINK,
  ];
}

/**
 * Sends STAFF_HANDOFF_TEMPLATE from the platform number once it is approved
 * on the platform workspace; false (nothing sent) while it is missing or not
 * approved, or the platform number isn't connected. Resolved once per alert.
 */
function platformTemplateSender(supabase: SupabaseClient) {
  let ready: Promise<{ send: (phone: string, params: string[]) => Promise<boolean> } | null> | null = null;
  const resolve = async () => {
    const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
    const platformOrgId = await resolvePlatformOrg(supabase);
    if (!platformOrgId) return null;
    const { data: rows } = await supabase
      .from("message_templates")
      .select("name, language, components, status")
      .eq("organization_id", platformOrgId)
      .eq("name", STAFF_HANDOFF_TEMPLATE.name);
    const template = ((rows ?? []) as Array<{ name: string; language: string; components: unknown; status: string | null }>).find(
      (t) => String(t.status ?? "").toUpperCase() === "APPROVED",
    );
    if (!template) return null;
    const { data: setting } = await supabase.from("platform_settings").select("onboarding_whatsapp_account_id").maybeSingle();
    const accountId = (setting as { onboarding_whatsapp_account_id?: string | null } | null)?.onboarding_whatsapp_account_id ?? null;
    if (!accountId) return null;
    const { loadSenderContext, sendCampaignTemplate } = await import("@/lib/campaigns.server");
    const sender = await loadSenderContext(supabase, platformOrgId, accountId);
    if (!sender) return null;
    return {
      send: async (phone: string, params: string[]) => {
        const outcome = await sendCampaignTemplate(
          supabase,
          platformOrgId,
          sender,
          { contactId: null, phone, variables: Object.fromEntries(params.map((v, i) => [String(i + 1), v])) },
          {
            name: template.name,
            language: template.language,
            variableOrder: params.map((_, i) => i + 1),
            components: (template.components ?? null) as import("@/lib/templates").TemplateComponent[] | null,
          },
          { campaignId: null, category: "utility" },
        );
        return Boolean(outcome.messageId && !outcome.error);
      },
    };
  };
  return async (phone: string, params: string[]) => {
    ready ??= resolve().catch(() => null);
    const r = await ready;
    return r ? r.send(phone, params) : false;
  };
}

const REASON_TEXT: Record<string, string> = {
  asked_for_person: "a customer asked to talk to a person",
  flow_assign: "a flow handed a chat to you",
  flow: "a flow asked for a person",
  merchant_rule: "a chat matched one of your hand-over rules",
  sensitive_topic: "a customer raised something sensitive",
};

/**
 * Tell the staff. Never throws; never the business's own number. Returns
 * who was told, for the log and the conversation row.
 */
export async function sendHandoffAlert(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    reason: string;
    question?: string | null;
    reminder?: boolean;
  },
  deps: {
    sendWhatsApp?: (channel: NonNullable<Awaited<ReturnType<typeof platformChannelFor>>>, body: string) => Promise<boolean>;
    sendEmail?: (to: string, subject: string, body: string) => Promise<boolean | { ok: boolean; error?: string }>;
    channelFor?: (phone: string) => Promise<unknown>;
    /** Outside the 24-hour window: STAFF_HANDOFF_TEMPLATE with these four values (Batch 21). */
    sendTemplate?: (phone: string, params: string[]) => Promise<boolean>;
  } = {},
): Promise<AlertOutcome> {
  const outcome: AlertOutcome = { whatsapp: [], email: null, refused: [] };
  try {
    const [settings, own, names, contact] = await Promise.all([
      loadAlertSettings(supabase, args.organizationId),
      businessNumbers(supabase, args.organizationId),
      supabase.from("organizations").select("name").eq("id", args.organizationId).maybeSingle(),
      supabase.from("conversations").select("contacts(name, phone)").eq("id", args.conversationId).maybeSingle(),
    ]);
    let targets = settings.phones;
    if (targets.length === 0) {
      // Nothing configured: the owner's own phone, unless it is the business number.
      const { ownerPhoneFor } = await import("@/lib/owner-replies.server");
      const owner = await ownerPhoneFor(supabase, args.organizationId);
      targets = owner ? [owner] : [];
    }
    const safe: string[] = [];
    for (const phone of targets) {
      if (own.some((n) => samePhone(n, phone))) outcome.refused.push(phone);
      else safe.push(phone);
    }

    const business = String((names.data as { name?: string | null } | null)?.name ?? "").trim() || "your business";
    const who = (contact.data as { contacts?: { name?: string | null; phone?: string | null } | null } | null)?.contacts;
    const customer = String(who?.name ?? "").trim() || String(who?.phone ?? "").trim() || "A customer";
    const why = REASON_TEXT[args.reason] ?? "a chat needs a person";
    const asked = args.question ? ` They wrote: “${String(args.question).slice(0, 200)}”.` : "";
    const body =
      `${args.reminder ? "Reminder — still waiting: " : ""}[${business}] ${customer} is waiting for you in the AiDwar Inbox: ${why}.${asked} ` +
      "Aiden has stepped back on this chat until someone from your team replies.";

    const channelFor = deps.channelFor ?? ((p: string) => platformChannelFor(supabase, p));
    const sendWhatsApp =
      deps.sendWhatsApp ??
      (async (channel, text) => {
        const { sendServiceText } = await import("@/lib/service-text.server");
        return (await sendServiceText(supabase, { ...channel, body: text })).ok;
      });
    const sendTemplate = deps.sendTemplate ?? platformTemplateSender(supabase);
    for (const phone of safe) {
      const channel = (await channelFor(phone)) as NonNullable<Awaited<ReturnType<typeof platformChannelFor>>> | null;
      if (channel) {
        // Inside the 24-hour window: free text, as before.
        if (await sendWhatsApp(channel, body)) outcome.whatsapp.push(phone);
        continue;
      }
      // Outside it (or never messaged the platform number): the approved template.
      if (await sendTemplate(phone, staffAlertParams({ business, customer, why, reminder: Boolean(args.reminder) }))) {
        outcome.whatsapp.push(phone);
        (outcome.templated ??= []).push(phone);
      }
    }
    if (outcome.whatsapp.length === 0 && settings.email) {
      const send =
        deps.sendEmail ??
        (async (to: string, subject: string, text: string) => {
          const { sendEmail } = await import("@/lib/email.server");
          return sendEmail({ to, subject, body: text });
        });
      const mailed = await send(settings.email, `${customer} is waiting for you`, body);
      if (mailed === true || (typeof mailed === "object" && mailed.ok)) outcome.email = settings.email;
      else outcome.email_error = (typeof mailed === "object" && mailed.error) || "email_failed";
    }
    if (outcome.whatsapp.length === 0 && !outcome.email)
      outcome.skipped = safe.length === 0 && !settings.email ? "no_staff_contact" : "not_delivered";

    await supabase
      .from("conversations")
      .update(args.reminder ? { handoff_reminded_at: new Date().toISOString() } : { handoff_alert_at: new Date().toISOString() })
      .eq("id", args.conversationId);
    console.log("[handoff-alert]", JSON.stringify({ conversation_id: args.conversationId, reason: args.reason, reminder: Boolean(args.reminder), ...outcome, whatsapp: outcome.whatsapp.length, templated: outcome.templated?.length ?? 0 }));
  } catch (error) {
    console.warn("[handoff-alert] failed", error instanceof Error ? error.message : String(error));
    outcome.skipped = "error";
  }
  return outcome;
}

/**
 * One reminder per hand-off, 30 minutes after the alert, only inside the
 * workspace's business hours. Called from the flow worker's minute tick.
 * Never clears needs_human.
 */
export async function remindWaitingHandoffs(
  supabase: SupabaseClient,
  now: Date = new Date(),
  deps: Parameters<typeof sendHandoffAlert>[2] = {},
): Promise<number> {
  const before = new Date(now.getTime() - REMIND_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, organization_id, needs_human_reason, needs_human_question")
    .eq("needs_human", true)
    .is("assigned_to", null)
    .is("handoff_reminded_at", null)
    .lte("handoff_alert_at", before)
    .limit(50);
  if (error) return 0;
  let sent = 0;
  for (const row of (data ?? []) as Array<{ id: string; organization_id: string; needs_human_reason: string | null; needs_human_question: string | null }>) {
    const settings = await loadAlertSettings(supabase, row.organization_id);
    if (!isBusinessOpen(settings.hours, now, settings.timezone)) continue;
    await sendHandoffAlert(
      supabase,
      { organizationId: row.organization_id, conversationId: row.id, reason: row.needs_human_reason ?? "", question: row.needs_human_question, reminder: true },
      deps,
    );
    sent += 1;
  }
  return sent;
}
