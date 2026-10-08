import { outsideFetch } from "@/lib/outside-call.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { money } from "@/lib/billing";
import { normalizePhone } from "@/lib/phone";
import { STAFF_HANDOFF_TEMPLATE } from "@/lib/handoff-alerts.server";

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
  {
    name: "client_trial_ending",
    body: "Your AiDwar trial for {{1}} ends in {{2}} days. Choose a plan at {{3}} to keep Aiden working — nothing is deleted.",
    examples: ["Sharma Textiles", "3", "aidwar.in/app/billing"],
  },
  {
    // AI provider trouble (credit/quota/outage, or the backup answering).
    // Raised at most once an hour by ai-fallback.server.ts.
    name: "admin_ai_provider_alert",
    body: "AiDwar AI alert: {{1}}. Right now {{2}}. Details are here: {{3}} — please check.",
    examples: ["Lovable AI gateway is out of credit or quota", "Aiden is answering on the anthropic backup", "https://aidwar.in/admin/ai"],
  },
  // Batch 21: staff hand-off alert outside the 24-hour window (sent by handoff-alerts.server.ts).
  STAFF_HANDOFF_TEMPLATE,
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
  "client:trial_ending": "client_trial_ending",
  "admin:ai_provider_alert": "admin_ai_provider_alert",
  // Card renders past the monthly alarm (card-usage-alert.server.ts): same
  // approved template, same admin number.
  "admin:card_usage_alert": "admin_ai_provider_alert",
  // A merchant's website moved, lost many pages or grew a shelf
  // (knowledge.server.ts raiseSiteAlert): same approved template.
  "admin:site_change_alert": "admin_ai_provider_alert",
  // Sent messages whose debit still failed after a retry (billing-sweep
  // retryFailedDebits, Batch 26a): same approved template.
  "admin:billing_debit_alert": "admin_ai_provider_alert",
};

/**
 * The workspace AiDwar itself runs on. Set PLATFORM_ORG_ID to pin it; without
 * it, the workspace that owns platform_settings.onboarding_whatsapp_account_id
 * is the platform workspace; failing that, the oldest workspace that has a
 * platform owner in it.
 */
export async function resolvePlatformOrg(supabase: SupabaseClient): Promise<string | null> {
  const pinned = process.env["PLATFORM_ORG_ID"];
  if (pinned) return pinned;

  const { data: settings } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .limit(1)
    .maybeSingle();
  const onboardingAccountId = (settings as { onboarding_whatsapp_account_id?: string } | null)
    ?.onboarding_whatsapp_account_id;
  if (onboardingAccountId) {
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("organization_id")
      .eq("id", onboardingAccountId)
      .maybeSingle();
    const orgId = (account as { organization_id?: string } | null)?.organization_id;
    if (orgId) return orgId;
  }

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

export type BillingTemplateOutcome = "created" | "skipped" | "failed" | "remaining";

export type BillingTemplateReport = {
  created: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
  /** Not started because the run's time budget ran out — the next run picks them up. */
  remaining: string[];
  /** One row per template, in BILLING_TEMPLATES order, with Meta's own error text. */
  results: { name: string; outcome: BillingTemplateOutcome; error: string | null }[];
  templates: { name: string; status: string | null; language: string; error: string | null }[];
};

/**
 * One run of "Create billing templates" starts no new template after this
 * long (each takes ~4 s at Meta), so a run always answers well inside the
 * request limit; the admin page calls again for whatever is left.
 */
export const BILLING_TEMPLATE_BUDGET_MS = 20_000;
/** Templates submitted side by side within one run. */
const BILLING_TEMPLATE_CONCURRENCY = 3;

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

type TemplateModules = {
  templates: typeof import("@/lib/templates");
  create: typeof import("@/lib/template-create.server");
  media: typeof import("@/lib/template-media.server");
};

/** Submits one notice template. Never throws: every failure comes back as text. */
async function createBillingTemplate(
  supabase: SupabaseClient,
  orgId: string,
  actorId: string,
  spec: BillingTemplateSpec,
  modules: TemplateModules,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { emptyDraft, extractVariables } = modules.templates;
    const { createTemplateFromDraft } = modules.create;

    const draft = emptyDraft();
    draft.name = spec.name;
    draft.language = "en";
    draft.category = "UTILITY";
    draft.body = spec.body;
    draft.bodyExamples = Object.fromEntries(
      extractVariables(spec.body).map((v, i) => [v, spec.examples[i] ?? ""]),
    );

    if (spec.headerFormat === "DOCUMENT") {
      // Meta reviews a media header only with a sample uploaded through the
      // resumable upload API (example.header_handle); uploadTemplateMedia is
      // the same path the Templates page uses.
      let bytes: Uint8Array;
      try {
        bytes = await sampleInvoicePdf();
      } catch (error) {
        return {
          ok: false,
          error: `We couldn't build the sample PDF: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
        };
      }
      const uploaded = await modules.media.uploadTemplateMedia(supabase, {
        organizationId: orgId,
        userId: actorId,
        bytes,
        mime: "application/pdf",
        fileName: "sample-invoice.pdf",
        format: "DOCUMENT",
        slot: "header",
      });
      if (!uploaded.ok) return { ok: false, error: uploaded.error };
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
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

/**
 * Creates every notice template on the platform workspace, through exactly the
 * same path the Templates page uses. Each template stands alone: one failure
 * never stops the rest. Idempotent by name: a template the platform workspace
 * already holds (in any language) is skipped, never resubmitted. A run starts
 * nothing new after BILLING_TEMPLATE_BUDGET_MS; what is left comes back as
 * `remaining` for the next run, which passes them as `names` so a template
 * that just failed isn't retried in the same click.
 */
export async function ensureBillingTemplates(
  supabase: SupabaseClient,
  actorId: string,
  options: { budgetMs?: number; now?: () => number; names?: string[] | null } = {},
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

  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? BILLING_TEMPLATE_BUDGET_MS);
  const outcomes = new Map<string, { outcome: BillingTemplateOutcome; error: string | null }>();

  const orgId = await resolvePlatformOrg(supabase);
  if (!orgId) {
    const error = "No platform workspace is set up yet.";
    return {
      created: [],
      skipped: [],
      failed: [{ name: "all", error }],
      remaining: [],
      results: BILLING_TEMPLATES.map((t) => ({ name: t.name, outcome: "failed" as const, error })),
      templates: await listBillingTemplates(supabase),
    };
  }

  // One read for what the platform already holds, whatever the language
  // (staff_handoff_alert was first made by hand in en_US).
  const { data: held, error: heldError } = await supabase
    .from("message_templates")
    .select("name")
    .eq("organization_id", orgId)
    .in(
      "name",
      BILLING_TEMPLATES.map((t) => t.name),
    );
  if (heldError) {
    // Without knowing what exists, submitting would resubmit everything.
    const error = `We couldn't read the existing templates: ${heldError.message}`;
    return {
      created: [],
      skipped: [],
      failed: [{ name: "all", error }],
      remaining: [],
      results: BILLING_TEMPLATES.map((t) => ({ name: t.name, outcome: "failed" as const, error })),
      templates: await listBillingTemplates(supabase),
    };
  }
  const heldNames = new Set(((held ?? []) as { name: string }[]).map((r) => r.name));

  const only = options.names?.length ? new Set(options.names) : null;
  const queue: BillingTemplateSpec[] = [];
  for (const spec of BILLING_TEMPLATES) {
    if (heldNames.has(spec.name)) outcomes.set(spec.name, { outcome: "skipped", error: null });
    else if (only && !only.has(spec.name)) outcomes.set(spec.name, { outcome: "skipped", error: null });
    else queue.push(spec);
  }

  // Loaded once, before templates are submitted side by side.
  const modules: TemplateModules = {
    templates: await import("@/lib/templates"),
    create: await import("@/lib/template-create.server"),
    media: await import("@/lib/template-media.server"),
  };
  const worker = async () => {
    for (;;) {
      if (now() >= deadline) return;
      const spec = queue.shift();
      if (!spec) return;
      const result = await createBillingTemplate(supabase, orgId, actorId, spec, modules);
      outcomes.set(
        spec.name,
        result.ok ? { outcome: "created", error: null } : { outcome: "failed", error: result.error },
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BILLING_TEMPLATE_CONCURRENCY, queue.length) }, worker),
  );
  for (const spec of queue) outcomes.set(spec.name, { outcome: "remaining", error: null });

  const results = BILLING_TEMPLATES.map((t) => ({
    name: t.name,
    ...(outcomes.get(t.name) ?? { outcome: "remaining" as const, error: null }),
  }));
  const pick = (o: BillingTemplateOutcome) => results.filter((r) => r.outcome === o);
  const created = pick("created").map((r) => r.name);
  const skipped = pick("skipped").map((r) => r.name);
  const failed = pick("failed").map((r) => ({ name: r.name, error: r.error ?? "failed" }));
  const remaining = pick("remaining").map((r) => r.name);

  try {
    await supabase.from("activity_log").insert({
      organization_id: orgId,
      user_id: actorId,
      action: "billing_templates_created",
      details: {
        created: created.length,
        skipped: skipped.length,
        failed: failed.length,
        remaining: remaining.length,
        errors: failed,
      },
    });
  } catch {
    // the report matters more than the log line
  }

  const errors = new Map(failed.map((f) => [f.name, f.error]));
  const templates = (await listBillingTemplates(supabase)).map((t) => ({
    ...t,
    error: errors.get(t.name) ?? null,
  }));
  return { created, skipped, failed, remaining, results, templates };
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
        money(Number(payload["credits_amount"] ?? payload["credits"] ?? 0)),
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
    case "trial_ending":
      return [orgName, String(payload["days"] ?? 3), "aidwar.in/app/billing"];
    case "campaign_approval":
      return [orgName, money(Number(payload["estimate"] ?? 0)), link];
    case "ai_provider_alert":
    case "card_usage_alert":
    case "site_change_alert":
    case "billing_debit_alert":
      return [
        String(payload["headline"] ?? "the AI provider is failing"),
        String(payload["detail"] ?? "Aiden replies may be failing"),
        String(payload["link"] ?? "https://aidwar.in/admin/ai"),
      ];
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

export async function recipientFor(
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
  if (phone) return normalizePhone(phone);

  // No billing number on file: the workspace owner is the right person.
  const { data: owners } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1);
  const ownerId = (owners as { user_id: string }[] | null)?.[0]?.user_id ?? null;
  if (!ownerId) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", ownerId)
    .maybeSingle();
  const ownerPhone = (profile as { phone?: string | null } | null)?.phone ?? null;
  return ownerPhone ? normalizePhone(ownerPhone) : null;
}

/** How many times a failed notice is retried before it is left alone. */
const MAX_ATTEMPTS = 3;

/**
 * A notice not out within this long is never sent: it is failed as "stale"
 * instead. A trial-ending or invoice notice days late is wrong, and a
 * standing warning that old has been superseded by the sweep anyway.
 */
export const NOTICE_STALE_MS = 48 * 3600_000;

export function isStaleNotice(createdAt: unknown, now = Date.now()): boolean {
  const at = Date.parse(String(createdAt ?? ""));
  return Number.isFinite(at) && now - at > NOTICE_STALE_MS;
}

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

/** A drain's claim on a notice; older than this, the drain died. */
const NOTICE_CLAIM_MS = 10 * 60_000;

/** Sends up to `limit` pending notices. One bad notice never stops the rest. */
export async function drainBillingNotifications(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const counts = { sent: 0, failed: 0, skipped: 0 };

  // Only work that is still pending: a notice already marked 'sent' is never
  // sent a second time, and a failed one is retried a limited number of times.
  // Dead rows (out of attempts, or failed by hand with no attempt count) are
  // left out in the query itself: filtered afterwards, 50 old dead rows
  // filled the whole window and nothing newer went out (28 Sep - 7 Oct).
  // Only WhatsApp rows: email rows are sent by drainEmailNotices
  // (email-notices.server.ts) and in-app rows are records, so neither may
  // take a place in this batch.
  const { data: rows } = await supabase
    .from("billing_notifications")
    .select("id, organization_id, audience, kind, channel, recipient, payload, status, sent_at, created_at")
    .eq("channel", "whatsapp")
    .or(
      `status.eq.queued,and(status.eq.failed,payload->>attempts.in.(${Array.from(
        { length: MAX_ATTEMPTS - 1 },
        (_, i) => i + 1,
      ).join(",")}))`,
    )
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 50));

  const queued = ((rows ?? []) as Record<string, unknown>[]).filter((row) => {
    if (row["status"] === "queued") return true;
    if (row["status"] !== "failed") return false;
    const attempts = Number(((row["payload"] ?? {}) as Record<string, unknown>)["attempts"] ?? 0);
    return attempts >= 1 && attempts < MAX_ATTEMPTS;
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
    attempts?: number,
  ) => {
    const payload = (row["payload"] ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {
      status,
      error: error ?? null,
      sent_at: new Date().toISOString(),
    };
    if (status === "failed") {
      patch["payload"] = {
        ...payload,
        attempts: attempts ?? Number(payload["attempts"] ?? 0) + 1,
      };
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
        // The query reads WhatsApp rows only; should another ever come back,
        // it is left untouched for its own sender, never sent from here.
        counts.skipped += 1;
        continue;
      }

      if (isStaleNotice(row["created_at"])) {
        // Too late to be useful; out of attempts so it is never picked again.
        await mark(row, "failed", "stale", MAX_ATTEMPTS);
        counts.failed += 1;
        continue;
      }

      const kind = String(row["kind"]);
      if (kind === "invoice_issued" && (row["payload"] as Record<string, unknown> | null)?.["invoice_id"]) {
        // The invoice as it stands now: already on the buyer's WhatsApp (a
        // super admin's resend went first) → never a second copy; otherwise
        // its PDF may have been filed after the notice was queued.
        const payload = row["payload"] as Record<string, unknown>;
        const { data: invoice } = await supabase
          .from("invoices")
          .select("pdf_path, sent")
          .eq("id", String(payload["invoice_id"]))
          .maybeSingle();
        const inv = (invoice ?? {}) as Record<string, unknown>;
        if (((inv["sent"] ?? {}) as Record<string, unknown>)["whatsapp_at"]) {
          await mark(row, "skipped", "already_delivered");
          counts.skipped += 1;
          continue;
        }
        if (inv["pdf_path"]) row["payload"] = { ...payload, pdf_path: inv["pdf_path"] };
      }
      const templateName = TEMPLATE_FOR[`${String(row["audience"])}:${kind}`];
      if (!templateName) {
        // Nothing to send over WhatsApp: it stays an in-app record. 'sent' is
        // reserved for a message that actually left the platform number.
        await mark(row, "skipped", "no_template_for_kind");
        counts.skipped += 1;
        continue;
      }

      // Claim it first (compare-and-set on sent_at, which every outcome
      // writes): two drains running at once can't both send it. A claim
      // less than ten minutes old belongs to a drain still at work.
      const claimedAt = (row["sent_at"] as string | null) ?? null;
      if (claimedAt && Date.now() - Date.parse(claimedAt) < NOTICE_CLAIM_MS) {
        counts.skipped += 1;
        continue;
      }
      const claim = supabase
        .from("billing_notifications")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", row["id"] as string)
        .eq("status", row["status"] as string);
      const { data: claimed, error: claimError } = await (claimedAt
        ? claim.eq("sent_at", claimedAt)
        : claim.is("sent_at", null)
      ).select("id");
      if (claimError || !claimed?.length) {
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

      const res = await outsideFetch(
        "meta",
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
