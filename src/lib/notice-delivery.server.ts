import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PUBLIC_URL } from "@/lib/app-url";
import {
  customerNoticeKind,
  metaErrorTitle,
  NOTICE_LABEL,
  readNoticeTag,
  undeliveredAlertText,
  maskedPhone,
  type NoticeKind,
  type UndeliveredBadge,
} from "@/lib/notice-delivery";

/**
 * Batch 81: what happens when one of AiDwar's own messages to a customer
 * (invoice, receipt, welcome/setup, sign-up reminder — notice-delivery.ts)
 * gets a status from Meta. Called by the status webhook off the reply path
 * (later()), never retried with the event, never touches the message's own
 * status.
 *
 * failed:
 *  1. claimed once per message (metadata.undelivered_alert_at, one
 *     conditional update) — a re-delivered "failed" does nothing again;
 *  2. the error goes onto the source record: an invoice's
 *     sent.whatsapp_error / sent.delivery_status = "failed" (found by the
 *     tag, else by sent.message_id — invoices sent before the tag), a billing
 *     notice's error (its status stays "sent": a re-send would be wrong);
 *  3. activity_log "notice_undelivered" on the customer's workspace (Admin's
 *     red "Not delivered" badge);
 *  4. one WhatsApp alert to platform_settings.lead_alert_numbers, the lead
 *     alerts' own way: a free text inside a number's open 24-hour window,
 *     else the approved internal alert template admin_ai_provider_alert.
 * delivered / read: activity_log "notice_delivered" — a later notice that
 * reached them clears the badge.
 *
 * Nothing is ever sent to the customer from here, and checkout is untouched.
 */

type NoticeRow = {
  id: string;
  template_name?: string | null;
  metadata?: Record<string, unknown> | null;
  conversations?: { contact_id?: string | null } | null;
};

const ALERT_TEMPLATE = "admin_ai_provider_alert";

export async function noteNoticeStatus(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    row: NoticeRow;
    status: string;
    errors: unknown;
    at: string;
    now?: number;
  },
): Promise<"alerted" | "recorded" | "delivered" | "none"> {
  const kind = customerNoticeKind(input.row);
  if (!kind) return "none";
  const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
  const platformOrgId = await resolvePlatformOrg(supabase);
  // Only the platform number's messages: a merchant may name a template the same.
  if (!platformOrgId || input.organizationId !== platformOrgId) return "none";
  const tag = readNoticeTag(input.row.metadata);
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");

  if (input.status === "delivered" || input.status === "read") {
    if (tag?.organization_id) {
      await logServerActivity(supabase, tag.organization_id, null, "notice_delivered", {
        message_id: input.row.id,
        kind,
        at: input.at,
      });
      return "delivered";
    }
    return "none";
  }
  if (input.status !== "failed") return "none";

  // 1. Once per message.
  const { data: claimed } = await supabase
    .from("messages")
    .update({ metadata: { ...(input.row.metadata ?? {}), undelivered_alert_at: input.at } })
    .eq("id", input.row.id)
    .is("metadata->>undelivered_alert_at", null)
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return "none";

  const error = metaErrorTitle(input.errors);

  // 2. The source record.
  let organizationId = tag?.organization_id ?? null;
  let invoiceNumber = tag?.invoice_number ?? null;
  let phone: string | null = null;
  if (kind === "invoice") {
    const query = supabase.from("invoices").select("id, organization_id, invoice_number, sent");
    const { data: invoice } = await (
      tag?.invoice_id ? query.eq("id", tag.invoice_id) : query.eq("sent->>message_id", input.row.id)
    ).maybeSingle();
    if (invoice) {
      const inv = invoice as Record<string, unknown>;
      const sent = (inv["sent"] ?? {}) as Record<string, unknown>;
      organizationId ??= (inv["organization_id"] as string | null) ?? null;
      invoiceNumber ??= (inv["invoice_number"] as string | null) ?? null;
      phone = (sent["whatsapp_to"] as string | null) ?? null;
      await supabase
        .from("invoices")
        .update({
          sent: {
            ...sent,
            whatsapp_error: error.title,
            delivery_status: "failed",
            whatsapp_failed_at: input.at,
          },
        })
        .eq("id", String(inv["id"]));
    }
  }
  if (tag?.notification_id) {
    await supabase
      .from("billing_notifications")
      .update({ error: `not delivered: ${error.title}`.slice(0, 300) })
      .eq("id", tag.notification_id);
  }

  // Who it was for.
  const contactId = input.row.conversations?.contact_id ?? null;
  let name: string | null = null;
  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("name, phone")
      .eq("id", contactId)
      .maybeSingle();
    const c = (contact ?? {}) as { name?: string | null; phone?: string | null };
    name = (c.name ?? "").trim() || null;
    phone ??= c.phone ?? null;
  }
  phone ??= (input.row.metadata?.["to"] as string | null | undefined) ?? null;
  let orgName: string | null = null;
  if (organizationId) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .maybeSingle();
    orgName = ((org as { name?: string | null } | null)?.name ?? "").trim() || null;
    if (!name) name = await ownerName(supabase, organizationId);
  }

  // 3. Admin's record (the badge).
  await logServerActivity(supabase, organizationId ?? platformOrgId, null, "notice_undelivered", {
    message_id: input.row.id,
    kind,
    template: input.row.template_name ?? null,
    error: error.title,
    error_code: error.code,
    phone_last4: maskedPhone(phone),
    invoice_number: invoiceNumber,
    lead_id: tag?.lead_id ?? null,
    at: input.at,
  });

  // 4. The team.
  const text = undeliveredAlertText({
    kind,
    name: name ?? "the customer",
    phone,
    org: orgName,
    error: error.title,
  });
  const sent = await alertTeam(supabase, platformOrgId, {
    text,
    kind,
    who: `${name ?? "the customer"} ${maskedPhone(phone)}${orgName ? ` (${orgName})` : ""}`,
    error: error.title,
    now: input.now ?? Date.now(),
  });
  return sent > 0 ? "alerted" : "recorded";
}

async function ownerName(supabase: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("organization_members")
    .select("profiles(full_name)")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .limit(1);
  const first = ((data ?? []) as Array<Record<string, unknown>>)[0];
  const profile = (
    Array.isArray(first?.["profiles"]) ? first["profiles"][0] : first?.["profiles"]
  ) as { full_name?: string | null } | null | undefined;
  return (profile?.full_name ?? "").trim() || null;
}

/** One alert per alert number; returns how many went. Never throws. */
async function alertTeam(
  supabase: SupabaseClient,
  platformOrgId: string,
  alert: { text: string; kind: NoticeKind; who: string; error: string; now: number },
): Promise<number> {
  try {
    const { readLeadAlertNumbers, openWindowChannel } = await import("@/lib/lead-alerts.server");
    const numbers = await readLeadAlertNumbers(supabase);
    if (numbers.length === 0) return 0;
    const { sendServiceText } = await import("@/lib/service-text.server");

    let template: { name: string; language: string; components: unknown } | null | undefined;
    let sender: unknown = null;
    let budget = { limit: Infinity, used: 0 };
    const loadTemplate = async () => {
      if (template !== undefined) return template;
      template = null;
      const { data: setting } = await supabase
        .from("platform_settings")
        .select("onboarding_whatsapp_account_id")
        .maybeSingle();
      const accountId =
        (setting as { onboarding_whatsapp_account_id?: string | null } | null)
          ?.onboarding_whatsapp_account_id ?? null;
      const { data: t } = await supabase
        .from("message_templates")
        .select("name, language, components, status")
        .eq("organization_id", platformOrgId)
        .eq("name", ALERT_TEMPLATE)
        .maybeSingle();
      const stored = t as {
        name: string;
        language: string;
        components: unknown;
        status: string | null;
      } | null;
      if (!accountId || !stored || String(stored.status ?? "").toUpperCase() !== "APPROVED") {
        log("template_unavailable");
        return template;
      }
      const { loadSenderContext } = await import("@/lib/campaigns.server");
      sender = await loadSenderContext(supabase, platformOrgId, accountId);
      if (!sender) return template;
      const { platformTemplateBudget } = await import("@/lib/start-reminders.server");
      budget = await platformTemplateBudget(supabase, platformOrgId, accountId, alert.now);
      template = stored;
      return template;
    };

    let sent = 0;
    for (const n of numbers) {
      const channel = await openWindowChannel(supabase, n, alert.now);
      if (channel) {
        const r = await sendServiceText(supabase, {
          ...channel,
          windowOpen: true,
          body: alert.text,
          metadata: { kind: "notice_undelivered_alert" },
        });
        if (r.ok) {
          sent += 1;
          continue;
        }
      }
      const t = await loadTemplate();
      if (!t) continue;
      if (budget.used >= budget.limit) {
        log("daily_limit");
        continue;
      }
      const { sendCampaignTemplate } = await import("@/lib/campaigns.server");
      const outcome = await sendCampaignTemplate(
        supabase,
        platformOrgId,
        sender as Parameters<typeof sendCampaignTemplate>[2],
        {
          contactId: null,
          phone: n,
          variables: {
            "1": `${NOTICE_LABEL[alert.kind]} not delivered to ${alert.who}`,
            "2": `Meta says "${alert.error}" — call them`,
            "3": `${APP_PUBLIC_URL}/admin/customers`,
          },
        },
        {
          name: t.name,
          language: t.language,
          variableOrder: [1, 2, 3],
          components: (t.components ?? null) as
            import("@/lib/templates").TemplateComponent[] | null,
        },
        {
          campaignId: null,
          category: "utility",
          messageMetadata: { kind: "notice_undelivered_alert" },
        },
      );
      if (outcome.messageId && !outcome.error) {
        sent += 1;
        budget.used += 1;
      } else log("send_failed");
    }
    return sent;
  } catch (error) {
    console.log(
      JSON.stringify({
        scope: "notice_undelivered",
        stage: "alert_threw",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 0;
  }
}

function log(stage: string) {
  console.log(JSON.stringify({ scope: "notice_undelivered", stage }));
}

const BADGE_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Admin's red "Not delivered" badge per workspace: its latest
 * notice_undelivered in the last 30 days, unless a later customer notice
 * was delivered (notice_delivered). A failed read shows no badges.
 */
export async function undeliveredBadges(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<Map<string, UndeliveredBadge>> {
  const out = new Map<string, UndeliveredBadge>();
  try {
    const { data } = await supabase
      .from("activity_log")
      .select("organization_id, action, details, created_at")
      .in("action", ["notice_undelivered", "notice_delivered"])
      .gte("created_at", new Date(now - BADGE_WITHIN_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(2000);
    const decided = new Set<string>();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const org = String(r["organization_id"] ?? "");
      if (!org || decided.has(org)) continue;
      decided.add(org); // newest first: the latest outcome decides
      if (r["action"] !== "notice_undelivered") continue;
      const d = (r["details"] ?? {}) as Record<string, unknown>;
      out.set(org, {
        at: String(d["at"] ?? r["created_at"]),
        kind: (d["kind"] as NoticeKind) ?? "billing",
        error: String(d["error"] ?? "Not delivered"),
        invoice_number: (d["invoice_number"] as string | null) ?? null,
      });
    }
  } catch {
    // no badges rather than no page
  }
  return out;
}
