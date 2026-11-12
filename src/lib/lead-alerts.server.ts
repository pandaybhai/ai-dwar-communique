import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PUBLIC_URL } from "@/lib/app-url";
import { BUSINESS_TYPES } from "@/lib/leads";
import { normalizePhone, typedPhone } from "@/lib/phone";
import { LEAD_ALERT_TEMPLATE_NAME } from "@/lib/platform-notice-templates";
import { customersLabel, sellsLabel } from "@/lib/start-qualify";

/**
 * Batch 76: a WhatsApp alert to the sales numbers for every new lead.
 *
 * Run by the minute worker (/api/internal/knowledge-worker, next to the
 * Batch 75 reminder). A /start lead is alerted once its two questions are
 * answered or 3 minutes after it was created, whichever is first; a /demo lead
 * (its answers come with the form) on the next tick. One alert per lead per
 * number, from AiDwar's own number:
 *  - a free text when that number messaged AiDwar's number in the last 24 h
 *    (open window — free);
 *  - otherwise the approved utility template aidwar_new_lead_alert, within the
 *    number's daily business-initiated limit.
 * While the template isn't APPROVED, a lead that needs it waits (logged,
 * tried again next minute) and nothing partial goes out. demo_leads.alerted_at
 * is claimed first, so overlapping ticks never alert twice. Honeypot, fake and
 * repeated (10-minute duplicate) submissions never create a lead row, so they
 * are never alerted.
 */

export const ALERT_WAIT_MS = 3 * 60 * 1000;
const ALERT_WITHIN_MS = 24 * 60 * 60 * 1000;
const MAX_NUMBERS = 5;

type LeadRow = {
  id: string;
  name: string | null;
  phone: string;
  source: string;
  created_at: string;
  business_type: string | null;
  qualification: { sells?: string; customers?: string; answered_at?: string } | null;
};

export type AlertOutcome = {
  alerted: number;
  skipped:
    | null
    | "template_missing"
    | `template_${string}`
    | "daily_limit"
    | "no_platform_org"
    | "no_onboarding_number";
};

/* ------------------------------------------------------- alert numbers --- */

/** The numbers that get an alert for every new lead (E.164), from platform_settings. */
export async function readLeadAlertNumbers(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase
    .from("platform_settings")
    .select("lead_alert_numbers")
    .maybeSingle();
  const raw = (data as { lead_alert_numbers?: unknown } | null)?.lead_alert_numbers;
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((n) => normalizePhone(String(n ?? ""))).filter(Boolean))];
}

/**
 * Super admin only (the route checks): replaces the alert numbers. Each is
 * read with Batch 66's rule (+91 by default); at most 5; recorded in the
 * activity log.
 */
export async function saveLeadAlertNumbers(
  supabase: SupabaseClient,
  input: unknown,
  actorId: string,
): Promise<{ ok: true; numbers: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(input)) return { ok: false, error: "Send a list of numbers." };
  const numbers: string[] = [];
  for (const raw of input) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const t = typedPhone(text, "91");
    if ("error" in t) return { ok: false, error: `${text}: ${t.error}` };
    if (!numbers.includes(t.phone)) numbers.push(t.phone);
  }
  if (numbers.length > MAX_NUMBERS) return { ok: false, error: `At most ${MAX_NUMBERS} numbers.` };
  const { data: row } = await supabase.from("platform_settings").select("id").maybeSingle();
  const id = (row as { id?: unknown } | null)?.id;
  if (id === undefined || id === null)
    return { ok: false, error: "Platform settings are missing." };
  const { error } = await supabase
    .from("platform_settings")
    .update({ lead_alert_numbers: numbers })
    .eq("id", id as string);
  if (error) return { ok: false, error: "We couldn't save that. Please try again." };
  try {
    const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
    const { logServerActivity } = await import("@/lib/whatsapp-api.server");
    const org = await resolvePlatformOrg(supabase);
    if (org) {
      await logServerActivity(supabase, org, actorId, "lead_alert_numbers_changed", {
        count: numbers.length,
      });
    }
  } catch {
    // the change is saved; the log line is best effort
  }
  return { ok: true, numbers };
}

/* ------------------------------------------------------------- the alert --- */

/** {{1}} name, {{2}} number, {{3}} sells, {{4}} customers, {{5}} source — "—" when unanswered. */
export function alertVariables(lead: LeadRow): Record<string, string> {
  const dash = "—";
  const sells =
    sellsLabel(lead.qualification?.sells) ??
    (lead.source === "landing"
      ? (BUSINESS_TYPES.find((b) => b.value === lead.business_type)?.label ?? null)
      : null);
  return {
    "1": (lead.name ?? "").trim() || dash,
    "2": lead.phone,
    "3": sells ?? dash,
    "4": customersLabel(lead.qualification?.customers) ?? dash,
    "5":
      lead.source === "landing_start"
        ? "/start"
        : lead.source === "landing"
          ? "/demo"
          : lead.source,
  };
}

export function leadAdminUrl(leadId: string): string {
  return `${APP_PUBLIC_URL}/admin/leads?lead=${encodeURIComponent(leadId)}`;
}

/** The same words as the template, for a free text inside the 24-hour window. */
export function alertText(lead: LeadRow): string {
  const v = alertVariables(lead);
  return `New AiDwar lead: ${v["1"]} (${v["2"]}). Sells: ${v["3"]}. Customers: ${v["4"]}. Source: ${v["5"]}.\nOpen lead: ${leadAdminUrl(lead.id)}`;
}

function readyToAlert(lead: LeadRow, now: number): boolean {
  if (lead.source !== "landing_start") return true; // /demo: answers come with the form
  if (lead.qualification?.answered_at) return true;
  return Date.parse(lead.created_at) <= now - ALERT_WAIT_MS;
}

type Channel = {
  organizationId: string;
  phoneNumberId: string;
  accessToken: string;
  conversationId: string;
  to: string;
};

/** AiDwar's chat with this number, when its 24-hour window is open (free text allowed). */
async function openWindowChannel(
  supabase: SupabaseClient,
  number: string,
  now: number,
): Promise<Channel | null> {
  const { onboardingChannelFor } = await import("@/lib/owner-replies.server");
  const channel = await onboardingChannelFor(supabase, number);
  if (!channel) return null;
  const { data } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", channel.conversationId)
    .maybeSingle();
  const { isServiceWindowOpen } = await import("@/lib/service-window");
  return isServiceWindowOpen(data as { last_customer_message_at?: string | null } | null, now)
    ? channel
    : null;
}

export async function runLeadAlerts(
  supabase: SupabaseClient,
  opts: { now?: number; limit?: number } = {},
): Promise<AlertOutcome> {
  const now = opts.now ?? Date.now();
  const numbers = await readLeadAlertNumbers(supabase);
  if (numbers.length === 0) return { alerted: 0, skipped: null };

  const { data: rows } = await supabase
    .from("demo_leads")
    .select("id, name, phone, source, created_at, business_type, qualification")
    .in("source", ["landing_start", "landing"])
    .eq("is_test", false)
    .is("alerted_at", null)
    .gte("created_at", new Date(now - ALERT_WITHIN_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 20);
  const leads = ((rows ?? []) as LeadRow[]).filter((l) => readyToAlert(l, now));
  if (leads.length === 0) return { alerted: 0, skipped: null };

  const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
  const platformOrgId = await resolvePlatformOrg(supabase);
  if (!platformOrgId) return log({ alerted: 0, skipped: "no_platform_org" });
  const { data: setting } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId =
    (setting as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!accountId) return log({ alerted: 0, skipped: "no_onboarding_number" });

  // Which numbers can get a free text right now (open window), and which need the template.
  const windows = new Map<string, Channel | null>();
  for (const n of numbers) windows.set(n, await openWindowChannel(supabase, n, now));
  const needTemplate = numbers.filter((n) => !windows.get(n));

  let template: { name: string; language: string; components: unknown } | null = null;
  let templateSkip: AlertOutcome["skipped"] = null;
  let budget = { limit: Infinity, used: 0 };
  let sender: unknown = null;
  if (needTemplate.length > 0) {
    const { data: t } = await supabase
      .from("message_templates")
      .select("name, language, components, status")
      .eq("organization_id", platformOrgId)
      .eq("name", LEAD_ALERT_TEMPLATE_NAME)
      .maybeSingle();
    const stored = t as {
      name: string;
      language: string;
      components: unknown;
      status: string | null;
    } | null;
    if (!stored) templateSkip = "template_missing";
    else if (String(stored.status ?? "").toUpperCase() !== "APPROVED") {
      templateSkip = `template_${String(stored.status ?? "unknown").toLowerCase()}`;
    } else {
      template = stored;
      const { platformTemplateBudget } = await import("@/lib/start-reminders.server");
      budget = await platformTemplateBudget(supabase, platformOrgId, accountId, now);
      const { loadSenderContext } = await import("@/lib/campaigns.server");
      sender = await loadSenderContext(supabase, platformOrgId, accountId);
      if (!sender) {
        template = null;
        templateSkip = "template_missing";
      }
    }
  }
  // Nothing partial: a lead whose alert needs the template waits for it.
  if (needTemplate.length > 0 && !template) return log({ alerted: 0, skipped: templateSkip });

  const { sendServiceText } = await import("@/lib/service-text.server");
  let alerted = 0;
  for (const lead of leads) {
    if (budget.used + needTemplate.length > budget.limit) {
      return log({ alerted, skipped: "daily_limit" });
    }
    const at = new Date(now).toISOString();
    const { data: claimed } = await supabase
      .from("demo_leads")
      .update({ alerted_at: at })
      .eq("id", lead.id)
      .is("alerted_at", null)
      .select("id");
    if (!claimed || (claimed as unknown[]).length === 0) continue;

    for (const n of numbers) {
      const channel = windows.get(n) ?? null;
      if (channel) {
        const sent = await sendServiceText(supabase, {
          ...channel,
          windowOpen: true,
          body: alertText(lead),
          metadata: { kind: "lead_alert", lead_id: lead.id },
        });
        if (sent.ok) continue;
        // The window closed in between: the template, if we have it.
        if (!template) {
          console.log(JSON.stringify({ scope: "lead_alert", stage: "text_failed", lead: lead.id }));
          continue;
        }
      }
      if (!template) continue;
      const { sendCampaignTemplate } = await import("@/lib/campaigns.server");
      const outcome = await sendCampaignTemplate(
        supabase,
        platformOrgId,
        sender as Parameters<typeof sendCampaignTemplate>[2],
        { contactId: null, phone: n, variables: alertVariables(lead) },
        {
          name: template.name,
          language: template.language,
          variableOrder: [1, 2, 3, 4, 5],
          components: (template.components ?? null) as
            import("@/lib/templates").TemplateComponent[] | null,
        },
        { campaignId: null, category: "utility", buttonParams: { 0: lead.id } },
      );
      if (outcome.messageId && !outcome.error) budget.used += 1;
      else {
        console.log(
          JSON.stringify({
            scope: "lead_alert",
            stage: "send_failed",
            lead: lead.id,
            error: String(outcome.error ?? ""),
          }),
        );
      }
    }
    alerted += 1;
  }
  return { alerted, skipped: null };
}

function log(outcome: AlertOutcome): AlertOutcome {
  if (outcome.skipped) {
    console.log(JSON.stringify({ scope: "lead_alert", stage: "skipped", reason: outcome.skipped }));
  }
  return outcome;
}
