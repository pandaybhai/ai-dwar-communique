import type { SupabaseClient } from "@supabase/supabase-js";
import { money } from "@/lib/billing";
import { normalizePhone } from "@/lib/phone";

/**
 * Delivery for queued billing notices.
 *
 * Everything goes out from the platform's own workspace number: inside the
 * 24-hour window as a plain message, outside it as an approved template. A
 * notice that can't go out is marked failed with the reason — it is never
 * silently dropped, and the loop never throws.
 */

export type BillingTemplateSpec = {
  name: string;
  body: string;
  examples: string[];
};

/**
 * The six notices, all UTILITY, all with the same three variables so one
 * parameter builder covers every kind: who/what, an amount, and a link or
 * balance.
 */
export const BILLING_TEMPLATES: BillingTemplateSpec[] = [
  {
    name: "admin_credit_purchased",
    body: "{{1}} just bought {{2}} of credits. Their balance is now {{3}}.",
    examples: ["Sharma Textiles", "₹5,000", "₹6,200"],
  },
  {
    name: "client_credit_purchased",
    body: "We've added {{2}} of credits to {{1}}. Your balance is now {{3}}.",
    examples: ["Sharma Textiles", "₹5,000", "₹6,200"],
  },
  {
    name: "client_topup_requested",
    body: "{{1}}: a teammate has asked for more credits ({{2}}). You can add them here: {{3}}",
    examples: ["Sharma Textiles", "₹2,000", "https://aidwar.in/app/billing"],
  },
  {
    name: "client_low_credits",
    body: "{{1}} is running low on credits — {{2}} left. Top up here: {{3}}",
    examples: ["Sharma Textiles", "₹350", "https://aidwar.in/app/billing"],
  },
  {
    name: "admin_float_low",
    body: "Meta float for {{1}} is down to {{2}}. The target is {{3}}.",
    examples: ["Sharma Textiles", "₹800", "₹5,000"],
  },
  {
    name: "client_campaign_approval",
    body: "A campaign on {{1}} is waiting for your approval. It will cost about {{2}}. Review it here: {{3}}",
    examples: ["Sharma Textiles", "₹4,500", "https://aidwar.in/app/campaigns"],
  },
];

/** audience:kind -> template name. Anything unmapped stays an in-app notice. */
const TEMPLATE_FOR: Record<string, string> = {
  "admin:credits_added": "admin_credit_purchased",
  "client:credits_added": "client_credit_purchased",
  "client:topup_requested": "client_topup_requested",
  "admin:topup_requested": "client_topup_requested",
  "client:low_credits": "client_low_credits",
  "admin:float_low": "admin_float_low",
  "client:campaign_approval": "client_campaign_approval",
};

/**
 * The workspace AiDwar itself runs on. Set PLATFORM_ORG_ID to pin it; without
 * it we fall back to the oldest workspace that has a platform owner in it.
 */
export async function resolvePlatformOrg(supabase: SupabaseClient): Promise<string | null> {
  const pinned = process.env["PLATFORM_ORG_ID"];
  if (pinned) return pinned;

  const { data: admins } = await supabase
    .from("profiles")
    .select("id")
    .eq("is_super_admin", true)
    .limit(20);
  const ids = ((admins ?? []) as { id: string }[]).map((a) => a.id);
  if (ids.length === 0) return null;

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, created_at")
    .in("user_id", ids)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (membership as { organization_id?: string } | null)?.organization_id ?? null;
}

/** Creates the six notice templates on the platform number for Meta review. */
export async function ensureBillingTemplates(
  supabase: SupabaseClient,
  actorId: string,
): Promise<{ created: string[]; skipped: string[]; failed: { name: string; error: string }[] }> {
  const { PermissionError } = await import("@/lib/billing.server");
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", actorId)
    .maybeSingle();
  if ((profile as { is_super_admin?: boolean } | null)?.is_super_admin !== true) {
    throw new PermissionError("super_admin", "This is a platform-owner action.");
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: { name: string; error: string }[] = [];

  const orgId = await resolvePlatformOrg(supabase);
  if (!orgId) return { created, skipped, failed: [{ name: "all", error: "no_platform_org" }] };

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { graphFetch, graphErrorMessage } = await import("@/lib/whatsapp-api.server");
  const { connection, error } = await getWhatsAppConnection(supabase, orgId);
  if (!connection) return { created, skipped, failed: [{ name: "all", error: error ?? "not_connected" }] };

  for (const spec of BILLING_TEMPLATES) {
    const { data: existing } = await supabase
      .from("message_templates")
      .select("id")
      .eq("organization_id", orgId)
      .eq("name", spec.name)
      .eq("language", "en")
      .maybeSingle();
    if (existing) {
      skipped.push(spec.name);
      continue;
    }

    const components = [
      { type: "BODY", text: spec.body, example: { body_text: [spec.examples] } },
    ];
    const result = await graphFetch(`${connection.wabaId}/message_templates`, connection.accessToken, {
      method: "POST",
      body: { name: spec.name, language: "en", category: "UTILITY", components },
    });
    if (!result.ok) {
      failed.push({ name: spec.name, error: graphErrorMessage(result.body) });
      continue;
    }

    await supabase.from("message_templates").upsert(
      {
        organization_id: orgId,
        waba_id: connection.wabaId,
        meta_template_id: (result.body["id"] as string) ?? null,
        name: spec.name,
        language: "en",
        category: "UTILITY",
        status: String(result.body["status"] ?? "PENDING").toUpperCase(),
        components,
      },
      { onConflict: "organization_id,waba_id,name,language" },
    );
    created.push(spec.name);
  }

  return { created, skipped, failed };
}

function paramsFor(kind: string, orgName: string, payload: Record<string, unknown>): string[] {
  const amount = payload["amount"];
  const link = String(payload["link"] ?? "https://aidwar.in/app/billing");
  switch (kind) {
    case "credits_added":
      return [orgName, money(Number(amount ?? 0)), money(Number(payload["balance"] ?? amount ?? 0))];
    case "topup_requested":
      return [orgName, amount === null || amount === undefined ? "some credits" : money(Number(amount)), link];
    case "low_credits":
      return [orgName, money(Number(payload["available"] ?? 0)), link];
    case "float_low":
      return [orgName, money(Number(payload["estimate"] ?? 0)), money(Number(payload["target"] ?? 0))];
    case "campaign_approval":
      return [orgName, money(Number(payload["estimate"] ?? 0)), link];
    default:
      return [orgName, money(Number(amount ?? 0)), link];
  }
}

async function recipientFor(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string | null> {
  const explicit = (row["recipient"] as string | null) ?? null;
  if (explicit) return normalizePhone(explicit).e164;

  if (row["audience"] === "admin") {
    const admin = process.env["BILLING_ADMIN_WHATSAPP"];
    return admin ? normalizePhone(admin).e164 : null;
  }

  const orgId = row["organization_id"] as string | null;
  if (!orgId) return null;
  const { data: org } = await supabase
    .from("organizations")
    .select("billing_accounts:billing_account_id(billing_whatsapp)")
    .eq("id", orgId)
    .maybeSingle();
  const account = ((org ?? {}) as Record<string, unknown>)["billing_accounts"] as
    | Record<string, unknown>
    | null;
  const phone = (account?.["billing_whatsapp"] as string) ?? null;
  return phone ? normalizePhone(phone).e164 : null;
}

/** Sends up to `limit` queued notices. One bad notice never stops the rest. */
export async function drainBillingNotifications(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const counts = { sent: 0, failed: 0, skipped: 0 };

  const { data: rows } = await supabase
    .from("billing_notifications")
    .select("id, organization_id, audience, kind, channel, recipient, payload")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 50));

  const queued = (rows ?? []) as Record<string, unknown>[];
  if (queued.length === 0) return counts;

  const platformOrgId = await resolvePlatformOrg(supabase);
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const connectionResult = platformOrgId
    ? await getWhatsAppConnection(supabase, platformOrgId)
    : { connection: null, error: "no_platform_org" as string | null };

  const mark = async (id: string, status: "sent" | "failed", error?: string) => {
    await supabase
      .from("billing_notifications")
      .update({ status, error: error ?? null, sent_at: new Date().toISOString() })
      .eq("id", id);
  };

  for (const row of queued) {
    const id = String(row["id"]);
    try {
      const templateName = TEMPLATE_FOR[`${String(row["audience"])}:${String(row["kind"])}`];
      if (!templateName || row["channel"] === "inapp") {
        // Nothing to send over WhatsApp: it stays an in-app record.
        await mark(id, "sent");
        counts.skipped += 1;
        continue;
      }

      const connection = connectionResult.connection;
      if (!connection || !platformOrgId) {
        await mark(id, "failed", connectionResult.error ?? "platform_number_not_connected");
        counts.failed += 1;
        continue;
      }

      const to = await recipientFor(supabase, row);
      if (!to) {
        await mark(id, "failed", "no_recipient");
        counts.failed += 1;
        continue;
      }

      const { data: org } = row["organization_id"]
        ? await supabase
            .from("organizations")
            .select("name")
            .eq("id", row["organization_id"] as string)
            .maybeSingle()
        : { data: null };
      const orgName = ((org as { name?: string } | null)?.name ?? "your workspace") as string;
      const payload = (row["payload"] ?? {}) as Record<string, unknown>;
      const params = paramsFor(String(row["kind"]), orgName, payload);

      // Inside the 24-hour window a plain message is friendlier and cheaper.
      const { data: contact } = await supabase
        .from("contacts")
        .select("id")
        .eq("organization_id", platformOrgId)
        .eq("phone", to)
        .maybeSingle();
      let conversationId: string | null = null;
      if (contact) {
        const { data: conversation } = await supabase
          .from("conversations")
          .select("id, last_customer_message_at")
          .eq("organization_id", platformOrgId)
          .eq("contact_id", contact.id as string)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const { isServiceWindowOpen } = await import("@/lib/service-window");
        if (conversation && isServiceWindowOpen(conversation)) {
          conversationId = conversation.id as string;
        }
      }

      if (conversationId) {
        const { sendServiceText } = await import("@/lib/service-text.server");
        const spec = BILLING_TEMPLATES.find((t) => t.name === templateName);
        const body = (spec?.body ?? "{{1}} {{2}} {{3}}")
          .replace("{{1}}", params[0] ?? "")
          .replace("{{2}}", params[1] ?? "")
          .replace("{{3}}", params[2] ?? "");
        const result = await sendServiceText(supabase, {
          organizationId: platformOrgId,
          phoneNumberId: connection.phoneNumberId,
          accessToken: connection.accessToken,
          conversationId,
          to,
          body,
        });
        if (result.ok) {
          await mark(id, "sent");
          counts.sent += 1;
        } else {
          await mark(id, "failed", result.error ?? "send_failed");
          counts.failed += 1;
        }
        continue;
      }

      const { data: template } = await supabase
        .from("message_templates")
        .select("name, language, status")
        .eq("organization_id", platformOrgId)
        .eq("name", templateName)
        .maybeSingle();
      if (!template) {
        await mark(id, "failed", "template_missing");
        counts.failed += 1;
        continue;
      }

      const res = await fetch(
        `https://graph.facebook.com/v25.0/${connection.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: template.name,
              language: { code: (template.language as string) ?? "en" },
              components: [
                {
                  type: "body",
                  parameters: params.map((text) => ({ type: "text", text })),
                },
              ],
            },
          }),
        },
      );

      if (res.ok) {
        await mark(id, "sent");
        counts.sent += 1;
      } else {
        const text = (await res.text()).slice(0, 300);
        await mark(id, "failed", text || "send_failed");
        counts.failed += 1;
      }
    } catch (error) {
      try {
        await mark(id, "failed", String((error as Error)?.message ?? error).slice(0, 300));
      } catch {
        // a notice that can't even be marked must not stop the drain
      }
      counts.failed += 1;
    }
  }

  return counts;
}
