import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { FINISH_SIGNUP_TEMPLATE_NAME } from "@/lib/platform-notice-templates";

/**
 * Batch 75: one WhatsApp reminder to a /start lead who didn't sign up.
 *
 * Run by the minute worker (/api/internal/knowledge-worker, next to the
 * onboarding nudges — no new cron). A lead gets it once, 30 minutes after
 * its row was created (and within a day of it), from AiDwar's own number
 * (platform_settings.onboarding_whatsapp_account_id), as the approved
 * utility template aidwar_finish_signup with a "Finish sign-up" link that
 * resumes that one lead for 48 hours. Never after sign-up (the lead is
 * linked, or an account already uses that number), never to an opted-out
 * number, skipped (logged, tried again next minute) while the template isn't
 * APPROVED, and stopped for the day once the number's daily
 * business-initiated limit (its messaging tier, e.g. TIER_250) is reached.
 */

export const REMIND_AFTER_MS = 30 * 60 * 1000;
/** Leads older than this are never reminded (and the day's backlog never floods). */
export const REMIND_WITHIN_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The limit when Meta hasn't told us the tier yet: the smallest one. */
const DEFAULT_DAILY_LIMIT = 250;

type LeadRow = {
  id: string;
  name: string | null;
  phone: string;
  created_at: string;
};

export type ReminderOutcome = {
  sent: number;
  skipped:
    | null
    | "no_platform_org"
    | "template_missing"
    | `template_${string}`
    | "no_onboarding_number"
    | "onboarding_number_not_connected"
    | "daily_limit";
};

/**
 * Links a /start lead to the account just created from it (the sign-up's
 * own number must be the lead's number, the account under recentMs old).
 */
export async function linkStartLeadToUser(
  supabase: SupabaseClient,
  input: { leadId: string; userId: string; recentMs: number; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const { data: leadRow } = await supabase
    .from("demo_leads")
    .select("id, phone, source, linked_user_id")
    .eq("id", input.leadId)
    .maybeSingle();
  const lead = leadRow as {
    id: string;
    phone: string;
    source: string;
    linked_user_id: string | null;
  } | null;
  if (!lead || lead.source !== "landing_start" || lead.linked_user_id) return false;
  const admin = (
    supabase as unknown as {
      auth: {
        admin: {
          getUserById: (id: string) => Promise<{
            data: {
              user: {
                id: string;
                created_at?: string;
                user_metadata?: Record<string, unknown>;
              } | null;
            };
          }>;
        };
      };
    }
  ).auth.admin;
  const { data } = await admin.getUserById(input.userId);
  const user = data?.user ?? null;
  if (!user) return false;
  const created = Date.parse(user.created_at ?? "");
  if (!Number.isFinite(created) || now - created > input.recentMs) return false;
  const phone = normalizePhone(String(user.user_metadata?.["phone"] ?? ""));
  if (!phone || phone !== normalizePhone(lead.phone)) return false;
  const { data: linked } = await supabase
    .from("demo_leads")
    .update({ linked_user_id: input.userId })
    .eq("id", lead.id)
    .is("linked_user_id", null)
    .select("id");
  return Boolean(linked && (linked as unknown[]).length > 0);
}

/** Has anyone signed up with this number? (an AiDwar account's own phone) */
async function accountForNumber(supabase: SupabaseClient, phone: string): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("phone", normalizePhone(phone))
    .limit(1);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

/**
 * AiDwar's own number's daily business-initiated budget: its messaging tier
 * (TIER_250 → 250; unknown → the smallest, 250; unlimited → no cap) and the
 * template messages the platform workspace sent in the last 24 hours. Shared
 * by the Batch 75 reminder and the Batch 76 new-lead alerts.
 */
export async function platformTemplateBudget(
  supabase: SupabaseClient,
  platformOrgId: string,
  accountId: string,
  now: number,
): Promise<{ limit: number; used: number }> {
  const { data: account } = await supabase
    .from("whatsapp_accounts")
    .select("messaging_tier")
    .eq("id", accountId)
    .maybeSingle();
  const { messagingTierLimit } = await import("@/lib/billing");
  const tier = (account as { messaging_tier?: string | null } | null)?.messaging_tier ?? null;
  const limit =
    tier === "TIER_UNLIMITED" ? Infinity : (messagingTierLimit(tier) ?? DEFAULT_DAILY_LIMIT);
  return { limit, used: await templatesSentToday(supabase, platformOrgId, now) };
}

/** Business-initiated (template) messages the platform workspace sent in the last 24 hours. */
async function templatesSentToday(
  supabase: SupabaseClient,
  platformOrgId: string,
  now: number,
): Promise<number> {
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", platformOrgId)
    .eq("direction", "outbound")
    .eq("type", "template")
    .gte("created_at", new Date(now - DAY_MS).toISOString());
  return count ?? 0;
}

export async function runStartReminders(
  supabase: SupabaseClient,
  opts: { now?: number; limit?: number } = {},
): Promise<ReminderOutcome> {
  const now = opts.now ?? Date.now();
  const { data: rows } = await supabase
    .from("demo_leads")
    .select("id, name, phone, created_at")
    .eq("source", "landing_start")
    .eq("is_test", false)
    .is("nudged_at", null)
    .is("linked_user_id", null)
    .is("organization_id", null)
    .lte("created_at", new Date(now - REMIND_AFTER_MS).toISOString())
    .gte("created_at", new Date(now - REMIND_WITHIN_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 20);
  const leads = (rows ?? []) as LeadRow[];
  if (leads.length === 0) return { sent: 0, skipped: null };

  const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
  const platformOrgId = await resolvePlatformOrg(supabase);
  if (!platformOrgId) return log({ sent: 0, skipped: "no_platform_org" });

  const { data: templateRow } = await supabase
    .from("message_templates")
    .select("name, language, components, status")
    .eq("organization_id", platformOrgId)
    .eq("name", FINISH_SIGNUP_TEMPLATE_NAME)
    .maybeSingle();
  const stored = templateRow as {
    name: string;
    language: string;
    components: unknown;
    status: string | null;
  } | null;
  if (!stored) return log({ sent: 0, skipped: "template_missing" });
  if (String(stored.status ?? "").toUpperCase() !== "APPROVED") {
    return log({
      sent: 0,
      skipped: `template_${String(stored.status ?? "unknown").toLowerCase()}`,
    });
  }

  const { data: setting } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId =
    (setting as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!accountId) return log({ sent: 0, skipped: "no_onboarding_number" });

  const budget = await platformTemplateBudget(supabase, platformOrgId, accountId, now);
  const dailyLimit = budget.limit;
  let used = budget.used;
  if (used >= dailyLimit) return log({ sent: 0, skipped: "daily_limit" });

  const { loadSenderContext, sendCampaignTemplate } = await import("@/lib/campaigns.server");
  const sender = await loadSenderContext(supabase, platformOrgId, accountId);
  if (!sender) return log({ sent: 0, skipped: "onboarding_number_not_connected" });

  const { contactOptedOut } = await import("@/lib/opt-out.server");
  const { continueToken } = await import("@/lib/start-lead-cookie.server");

  let sent = 0;
  for (const lead of leads) {
    if (used >= dailyLimit) return log({ sent, skipped: "daily_limit" });

    // Signed up already (by this number): link it and never remind.
    const existing = await accountForNumber(supabase, lead.phone);
    if (existing) {
      await supabase
        .from("demo_leads")
        .update({ linked_user_id: existing })
        .eq("id", lead.id)
        .is("linked_user_id", null);
      continue;
    }
    // Opted out of AiDwar's own number: never.
    const { optedOut } = await contactOptedOut(supabase, platformOrgId, { phone: lead.phone });
    if (optedOut) continue;

    // Claim first, so two overlapping ticks can never both send.
    const at = new Date(now).toISOString();
    const { data: claimed } = await supabase
      .from("demo_leads")
      .update({ nudged_at: at })
      .eq("id", lead.id)
      .is("nudged_at", null)
      .select("id");
    if (!claimed || (claimed as unknown[]).length === 0) continue;

    const firstName = (lead.name ?? "").trim().split(/\s+/)[0] || "there";
    const outcome = await sendCampaignTemplate(
      supabase,
      platformOrgId,
      sender,
      { contactId: null, phone: lead.phone, variables: { "1": firstName } },
      {
        name: stored.name,
        language: stored.language,
        variableOrder: [1],
        components: (stored.components ?? null) as
          import("@/lib/templates").TemplateComponent[] | null,
      },
      {
        campaignId: null,
        category: "utility",
        buttonParams: { 0: await continueToken(lead.id, now) },
      },
    );
    if (outcome.messageId && !outcome.error) {
      sent += 1;
      used += 1;
    } else {
      // Meta refused it: nothing went out, so the lead may be tried again.
      await supabase
        .from("demo_leads")
        .update({ nudged_at: null })
        .eq("id", lead.id)
        .eq("nudged_at", at);
      console.log(
        JSON.stringify({
          scope: "start_reminder",
          stage: "send_failed",
          lead: lead.id,
          error: String(outcome.error ?? ""),
        }),
      );
    }
  }
  return { sent, skipped: null };
}

function log(outcome: ReminderOutcome): ReminderOutcome {
  if (outcome.skipped) {
    console.log(
      JSON.stringify({ scope: "start_reminder", stage: "skipped", reason: outcome.skipped }),
    );
  }
  return outcome;
}
