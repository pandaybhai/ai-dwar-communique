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
  /** Only the invoice notice carries a PDF header. */
  headerFormat?: "DOCUMENT";
};

/**
 * The notices, all UTILITY, all with the same three variables so one
 * parameter builder covers every kind: who/what, an amount, and a link or
 * balance.
 */
export const BILLING_TEMPLATES: BillingTemplateSpec[] = [
  // Meta rejects a message that begins or ends with a variable, so every body
  // is wrapped in words.
  {
    name: "admin_credit_purchased",
    body: "Workspace {{1}} just bought {{2}} of credits. Their balance is now {{3}} — no action needed.",
    examples: ["Sharma Textiles", "₹5,000", "₹6,200"],
  },
  {
    name: "client_credit_purchased",
    body: "We've added {{2}} of credits to {{1}}. Your balance is now {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹5,000", "₹6,200"],
  },
  {
    name: "client_topup_requested",
    body: "Hello {{1}} — a teammate has asked for more credits ({{2}}). You can add them here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,000", "https://aidwar.in/app/billing"],
  },
  {
    name: "client_low_credits",
    body: "Workspace {{1}} is running low on credits — {{2}} left. Top up here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹350", "https://aidwar.in/app/billing"],
  },
  {
    name: "admin_float_low",
    body: "The Meta float for {{1}} is down to {{2}}. The target is {{3}} — please top it up.",
    examples: ["Sharma Textiles", "₹800", "₹5,000"],
  },
  {
    name: "client_campaign_approval",
    body: "A campaign on {{1}} is waiting for your approval. It will cost about {{2}}. Review it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹4,500", "https://aidwar.in/app/campaigns"],
  },
  {
    name: "admin_topup_due",
    body: "Workspace {{1}} needs a Meta float top-up of {{2}}. Credits sold: {{3}} — please top it up.",
    examples: ["Sharma Textiles", "₹4,200", "₹5,000"],
  },
  {
    name: "admin_settle_failed",
    body: "A payment for {{1}} of {{2}} could not be credited automatically. Please check it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,000", "https://aidwar.in/admin/billing"],
  },
  {
    name: "client_invoice_issued",
    body: "Hello {{1}} — your invoice for {{2}} is ready. You can view and download it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,950", "https://aidwar.in/app/billing"],
    headerFormat: "DOCUMENT",
  },
  {
    name: "client_invoice_overdue",
    body: "Hello {{1}} — an invoice for {{2}} is still unpaid. Please settle it here to keep everything running: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,950", "https://aidwar.in/app/billing"],
  },
  {
    name: "client_payment_failed",
    body: "Hello {{1}} — your auto-pay of {{2}} didn't go through. You can pay it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,950", "https://aidwar.in/app/billing"],
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
  "admin:topup_due": "admin_topup_due",
  "admin:topup_reminder": "admin_topup_due",
  "admin:settle_failed": "admin_settle_failed",
  "client:campaign_approval": "client_campaign_approval",
  "client:invoice_issued": "client_invoice_issued",
  "client:invoice_overdue": "client_invoice_overdue",
  "client:payment_failed": "client_payment_failed",
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

export type BillingTemplateReport = {
  created: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
  templates: { name: string; status: string | null; language: string; error: string | null }[];
};

/** A one-page sample PDF, so Meta can review the invoice notice's attachment. */
async function sampleInvoicePdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("AiDwar", { x: 40, y: 240, size: 22, font });
  page.drawText("Sample tax invoice", { x: 40, y: 210, size: 12, font });
  page.drawText("This document is only used for template review.", {
    x: 40,
    y: 190,
    size: 10,
    font,
  });
  return doc.save();
}

/**
 * Creates every notice template on the platform workspace, through exactly the
 * same path the Templates page uses. Idempotent by name: a template we already
 * hold is skipped, never resubmitted.
 */
export async function ensureBillingTemplates(
  supabase: SupabaseClient,
  actorId: string,
): Promise<BillingTemplateReport> {
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
  const errors = new Map<string, string>();

  const orgId = await resolvePlatformOrg(supabase);
  if (!orgId) {
    return {
      created,
      skipped,
      failed: [{ name: "all", error: "No platform workspace is set up yet." }],
      templates: await listBillingTemplates(supabase),
    };
  }

  const { emptyDraft, extractVariables } = await import("@/lib/templates");
  const { createTemplateFromDraft } = await import("@/lib/template-create.server");

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

    const draft = emptyDraft();
    draft.name = spec.name;
    draft.language = "en";
    draft.category = "UTILITY";
    draft.body = spec.body;
    draft.bodyExamples = Object.fromEntries(
      extractVariables(spec.body).map((v, i) => [v, spec.examples[i] ?? ""]),
    );

    if (spec.headerFormat === "DOCUMENT") {
      const { uploadTemplateMedia } = await import("@/lib/template-media.server");
      const uploaded = await uploadTemplateMedia(supabase, {
        organizationId: orgId,
        userId: actorId,
        bytes: await sampleInvoicePdf(),
        mime: "application/pdf",
        fileName: "sample-invoice.pdf",
        format: "DOCUMENT",
        slot: "header",
      });
      if (!uploaded.ok) {
        failed.push({ name: spec.name, error: uploaded.error });
        errors.set(spec.name, uploaded.error);
        continue;
      }
      draft.headerFormat = "DOCUMENT";
      draft.headerHandle = uploaded.handle;
      draft.headerMediaUrl = uploaded.mediaUrl;
      draft.headerFileName = "invoice.pdf";
    }

    const result = await createTemplateFromDraft(supabase, {
      organizationId: orgId,
      userId: actorId,
      draft,
    });
    if (!result.ok) {
      failed.push({ name: spec.name, error: result.error });
      errors.set(spec.name, result.error);
      continue;
    }
    created.push(spec.name);
  }

  await supabase.from("activity_log").insert({
    organization_id: orgId,
    user_id: actorId,
    action: "billing_templates_created",
    details: { created: created.length, skipped: skipped.length, failed: failed.length },
  });

  const templates = (await listBillingTemplates(supabase)).map((t) => ({
    ...t,
    error: errors.get(t.name) ?? null,
  }));
  return { created, skipped, failed, templates };
}

/** What Meta currently says about each billing notice template. */
export async function listBillingTemplates(
  supabase: SupabaseClient,
): Promise<{ name: string; status: string | null; language: string; error: string | null }[]> {
  const orgId = await resolvePlatformOrg(supabase);
  const rows = orgId
    ? ((
        await supabase
          .from("message_templates")
          .select("name, language, status")
          .eq("organization_id", orgId)
          .in(
            "name",
            BILLING_TEMPLATES.map((t) => t.name),
          )
      ).data ?? [])
    : [];
  const byName = new Map(
    (rows as { name: string; language: string; status: string | null }[]).map((r) => [r.name, r]),
  );
  return BILLING_TEMPLATES.map((spec) => {
    const row = byName.get(spec.name);
    return {
      name: spec.name,
      language: row?.language ?? "en",
      status: row?.status ?? null,
      error: null,
    };
  });
}

function paramsFor(kind: string, orgName: string, payload: Record<string, unknown>): string[] {
  const amount = payload["amount"];
  const link = String(payload["link"] ?? "https://aidwar.in/app/billing");
  switch (kind) {
    case "credits_added":
      return [
        orgName,
        money(Number(amount ?? 0)),
        money(Number(payload["balance"] ?? amount ?? 0)),
      ];
    case "topup_requested":
      return [
        orgName,
        amount === null || amount === undefined ? "some credits" : money(Number(amount)),
        link,
      ];
    case "low_credits":
      return [orgName, money(Number(payload["available"] ?? 0)), link];
    case "topup_due":
    case "topup_reminder":
      return [
        orgName,
        money(Number(payload["meta_amount"] ?? 0)),
        money(Number(payload["credits"] ?? 0)),
      ];
    case "settle_failed":
      return [orgName, money(Number(payload["amount"] ?? 0)), "https://aidwar.in/admin/billing"];
    case "float_low":
      return [
        orgName,
        money(Number(payload["estimate"] ?? 0)),
        money(Number(payload["target"] ?? 0)),
      ];
    case "invoice_issued":
    case "invoice_overdue":
      return [orgName, money(Number(payload["amount"] ?? 0)), link];
    case "payment_failed":
      return [orgName, money(Number(payload["amount"] ?? 0)), link];
    case "campaign_approval":
      return [orgName, money(Number(payload["estimate"] ?? 0)), link];
    default:
      return [orgName, money(Number(amount ?? 0)), link];
  }
}

/**
 * The one place that decides where a platform-owner notice goes, so every
 * audience=admin kind resolves identically: the pinned number first, then the
 * platform's own billing account.
 */
export async function resolveAdminRecipient(supabase: SupabaseClient): Promise<string | null> {
  const pinned = process.env["BILLING_ADMIN_WHATSAPP"];
  if (pinned) {
    const normalized = normalizePhone(pinned);
    if (normalized) return normalized;
  }

  const { data: settings } = await supabase
    .from("platform_settings")
    .select("billing_admin_whatsapp")
    .eq("id", true)
    .maybeSingle();
  const fromSettings = (settings as { billing_admin_whatsapp?: string | null } | null)
    ?.billing_admin_whatsapp;
  if (fromSettings) {
    const normalized = normalizePhone(fromSettings);
    if (normalized) return normalized;
  }

  const { data: account } = await supabase
    .from("billing_accounts")
    .select("billing_whatsapp")
    .eq("owner_scope", "platform")
    .not("billing_whatsapp", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const fromAccount = (account as { billing_whatsapp?: string | null } | null)?.billing_whatsapp;
  return fromAccount ? normalizePhone(fromAccount) : null;
}

async function recipientFor(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string | null> {
  const explicit = (row["recipient"] as string | null) ?? null;
  if (explicit) return normalizePhone(explicit);

  if (row["audience"] === "admin") return resolveAdminRecipient(supabase);

  const orgId = row["organization_id"] as string | null;
  if (!orgId) return null;
  const { data: org } = await supabase
    .from("organizations")
    .select("billing_accounts:billing_account_id(billing_whatsapp)")
    .eq("id", orgId)
    .maybeSingle();
  const account = ((org ?? {}) as Record<string, unknown>)["billing_accounts"] as Record<
    string,
    unknown
  > | null;
  const phone = (account?.["billing_whatsapp"] as string) ?? null;
  return phone ? normalizePhone(phone) : null;
}

/** How many times a failed notice is retried before it is left alone. */
const MAX_ATTEMPTS = 3;

/**
 * The live wording for a top-up notice: read from the task itself at send
 * time, so a corrected task is what the owner sees.
 */
async function topupText(
  supabase: SupabaseClient,
  orgName: string,
  payload: Record<string, unknown>,
): Promise<string> {
  let meta = Number(payload["meta_amount"] ?? 0);
  let margin = Number(payload["margin_amount"] ?? 0);
  let credits = Number(payload["credits"] ?? 0);
  let number: string | null = null;

  const taskId = (payload["task_id"] as string | null) ?? null;
  if (taskId) {
    const { data: task } = await supabase
      .from("topup_tasks")
      .select("meta_amount, margin_amount, credits_amount, whatsapp_account_id")
      .eq("id", taskId)
      .maybeSingle();
    if (task) {
      const t = task as Record<string, unknown>;
      meta = Number(t["meta_amount"] ?? meta);
      margin = Number(t["margin_amount"] ?? margin);
      credits = Number(t["credits_amount"] ?? credits);
      if (t["whatsapp_account_id"]) {
        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("display_phone_number, waba_id")
          .eq("id", t["whatsapp_account_id"] as string)
          .maybeSingle();
        const a = (account ?? {}) as Record<string, unknown>;
        number = (a["display_phone_number"] as string) ?? (a["waba_id"] as string) ?? null;
      }
    }
  }
  if (margin === 0 && credits > 0) margin = Math.round((credits - meta) * 100) / 100;

  const on = number ? ` on WABA ${number}` : "";
  return `Top up ${money(meta)}${on} for ${orgName} · credits sold ${money(credits)} · your margin ${money(margin)}.`;
}

/** Sends up to `limit` pending notices. One bad notice never stops the rest. */
export async function drainBillingNotifications(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const counts = { sent: 0, failed: 0, skipped: 0 };

  // Only work that is still pending: a notice already marked 'sent' is never
  // sent a second time, and a failed one is retried a limited number of times.
  const { data: rows } = await supabase
    .from("billing_notifications")
    .select("id, organization_id, audience, kind, channel, recipient, payload, status")
    .in("status", ["queued", "failed"])
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 50));

  const queued = ((rows ?? []) as Record<string, unknown>[]).filter((row) => {
    if (row["status"] !== "failed") return true;
    const attempts = Number(((row["payload"] ?? {}) as Record<string, unknown>)["attempts"] ?? 0);
    return attempts < MAX_ATTEMPTS;
  });
  if (queued.length === 0) return counts;

  const platformOrgId = await resolvePlatformOrg(supabase);
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const connectionResult = platformOrgId
    ? await getWhatsAppConnection(supabase, platformOrgId)
    : { connection: null, error: "no_platform_org" as string | null };

  const mark = async (
    row: Record<string, unknown>,
    status: "sent" | "failed" | "skipped",
    error?: string,
  ) => {
    const payload = (row["payload"] ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {
      status,
      error: error ?? null,
      sent_at: new Date().toISOString(),
    };
    if (status === "failed") {
      patch["payload"] = { ...payload, attempts: Number(payload["attempts"] ?? 0) + 1 };
    }
    await supabase
      .from("billing_notifications")
      .update(patch)
      .eq("id", row["id"] as string);
  };

  for (const row of queued) {
    try {
      const channel = String(row["channel"] ?? "whatsapp");
      if (channel !== "whatsapp") {
        // Only WhatsApp rows ever touch the WhatsApp path. Email rows wait
        // their turn (the email sender isn't built yet) and in-app rows are
        // records, not messages — neither is a failure.
        counts.skipped += 1;
        continue;
      }

      const kind = String(row["kind"]);
      const templateName = TEMPLATE_FOR[`${String(row["audience"])}:${kind}`];
      if (!templateName) {
        // Nothing to send over WhatsApp: it stays an in-app record. 'sent' is
        // reserved for a message that actually left the platform number.
        await mark(row, "skipped", "no_template_for_kind");
        counts.skipped += 1;
        continue;
      }

      const connection = connectionResult.connection;
      if (!connection || !platformOrgId) {
        await mark(row, "failed", connectionResult.error ?? "platform_number_not_connected");
        counts.failed += 1;
        continue;
      }

      const to = await recipientFor(supabase, row);
      if (!to) {
        await mark(row, "failed", "no_recipient");
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
      if ((kind === "topup_due" || kind === "topup_reminder") && payload["task_id"]) {
        // Amounts come from the task as it stands now, not as it stood when
        // the notice was queued.
        const { data: task } = await supabase
          .from("topup_tasks")
          .select("meta_amount, margin_amount, credits_amount")
          .eq("id", payload["task_id"] as string)
          .maybeSingle();
        if (task) Object.assign(payload, task as Record<string, unknown>);
      }
      const params = paramsFor(kind, orgName, payload);

      // Inside the 24-hour window a plain message is friendlier and cheaper.
      // Numbers are stored with and without the leading +, so match both.
      const digits = to.replace(/^\+/, "");
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id")
        .eq("organization_id", platformOrgId)
        .in("phone", [`+${digits}`, digits])
        .limit(1);
      const contact = (contacts as { id: string }[] | null)?.[0] ?? null;
      let conversationId: string | null = null;
      if (contact) {
        const { data: conversation } = await supabase
          .from("conversations")
          .select("id, last_customer_message_at")
          .eq("organization_id", platformOrgId)
          .eq("contact_id", contact.id)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const { isServiceWindowOpen } = await import("@/lib/service-window");
        if (conversation && isServiceWindowOpen(conversation)) {
          conversationId = conversation.id as string;
        }
      }

      if (conversationId) {
        // Inside the window an invoice goes out as the document itself — the
        // link belongs only to the template fallback.
        if (kind === "invoice_issued" && payload["pdf_path"]) {
          const { invoiceDownloadUrl } = await import("@/lib/invoices.server");
          const url = await invoiceDownloadUrl(supabase, String(payload["pdf_path"]));
          if (url) {
            const { sendServiceDocument } = await import("@/lib/service-text.server");
            const number = String(payload["invoice_number"] ?? "invoice");
            const docResult = await sendServiceDocument(supabase, {
              organizationId: platformOrgId,
              phoneNumberId: connection.phoneNumberId,
              accessToken: connection.accessToken,
              conversationId,
              to,
              documentUrl: url,
              fileName: `${number.replace(/\//g, "-")}.pdf`,
              caption: `Your invoice ${number} for ${money(Number(payload["amount"] ?? 0))} — thank you.`,
            });
            if (docResult.ok) {
              await mark(row, "sent");
              counts.sent += 1;
              continue;
            }
          }
        }

        const { sendServiceText } = await import("@/lib/service-text.server");
        const spec = BILLING_TEMPLATES.find((t) => t.name === templateName);
        const body =
          kind === "topup_due" || kind === "topup_reminder"
            ? await topupText(supabase, orgName, payload)
            : (spec?.body ?? "{{1}} {{2}} {{3}}")
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
          await mark(row, "sent");
          counts.sent += 1;
          continue;
        }
        // The plain message didn't go through — fall through to the template,
        // which is the one path that still works outside the window.
      }

      const { data: template } = await supabase
        .from("message_templates")
        .select("name, language, status")
        .eq("organization_id", platformOrgId)
        .eq("name", templateName)
        .maybeSingle();
      if (!template) {
        await mark(row, "failed", "template_missing");
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
        await mark(row, "sent");
        counts.sent += 1;
      } else {
        const text = (await res.text()).slice(0, 300);
        await mark(row, "failed", text || "send_failed");
        counts.failed += 1;
      }
    } catch (error) {
      try {
        await mark(row, "failed", String((error as Error)?.message ?? error).slice(0, 300));
      } catch {
        // a notice that can't even be marked must not stop the drain
      }
      counts.failed += 1;
    }
  }

  return counts;
}
