import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, round4 } from "@/lib/billing";

/**
 * Platform-owner billing surfaces.
 *
 * Everything here is super-admin only and enforced inside the function, not by
 * the caller: these reads expose Meta cost and margin, which no client surface
 * may ever see. Money is always compared with explicit null checks — ₹0 is a
 * real balance.
 */

async function requireSuper(supabase: SupabaseClient, actorId: string): Promise<void> {
  const { PermissionError } = await import("@/lib/billing.server");
  const { data } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", actorId)
    .maybeSingle();
  if ((data as { is_super_admin?: boolean } | null)?.is_super_admin !== true) {
    throw new PermissionError("super_admin", "This is a platform-owner action.");
  }
}

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type AdminOverviewRow = {
  organization_id: string;
  name: string;
  plan_name: string | null;
  plan_status: string | null;
  funding_model: string | null;
  available: number;
  held: number;
  balance: number;
  meta_float: number;
  low_credit_threshold: number;
  meta_float_target: number;
  mtd_consumed: number;
  mtd_meta_cost: number;
  mtd_margin: number;
  sent: number;
  delivered: number;
  failed: number;
  numbers: { display: string | null; quality: string | null; tier: number | null }[];
  pending_topups: number;
  last_activity: string | null;
};

/** The cross-organization money table behind /admin/billing. */
export async function adminOverview(
  supabase: SupabaseClient,
  actorId: string,
): Promise<{ rows: AdminOverviewRow[]; tasks: Record<string, unknown>[] }> {
  await requireSuper(supabase, actorId);
  const { adminBillingOverview } = await import("@/lib/billing.server");
  const base = await adminBillingOverview(supabase, { userId: actorId });
  const start = monthStart();

  const [{ data: settings }, { data: ledger }, { data: metaLedger }] = await Promise.all([
    supabase
      .from("organization_billing_settings")
      .select("organization_id, low_credit_threshold, meta_float_target"),
    supabase
      .from("wallet_ledger")
      .select("organization_id, amount, entry_type, created_at")
      .in("entry_type", ["debit_message", "debit_ai", "debit_addon"])
      .gte("created_at", start),
    supabase
      .from("meta_prepaid_ledger")
      .select("organization_id, amount, entry_type, created_at")
      .gte("created_at", start),
  ]);

  const settingsBy = new Map<string, Record<string, unknown>>();
  for (const s of (settings ?? []) as Record<string, unknown>[]) {
    settingsBy.set(String(s["organization_id"]), s);
  }
  const consumedBy = new Map<string, number>();
  for (const l of (ledger ?? []) as Record<string, unknown>[]) {
    const key = String(l["organization_id"]);
    consumedBy.set(key, (consumedBy.get(key) ?? 0) + Math.abs(Number(l["amount"] ?? 0)));
  }
  const metaCostBy = new Map<string, number>();
  for (const m of (metaLedger ?? []) as Record<string, unknown>[]) {
    if (String(m["entry_type"]) === "topup") continue;
    const key = String(m["organization_id"]);
    metaCostBy.set(key, (metaCostBy.get(key) ?? 0) + Math.abs(Number(m["amount"] ?? 0)));
  }

  const rows = await Promise.all(
    base.rows.map(async (row) => {
      const id = row.organization_id;
      const [sent, delivered, failed, activity] = await Promise.all([
        supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", id)
          .eq("direction", "outbound")
          .gte("created_at", start),
        supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", id)
          .eq("direction", "outbound")
          .in("status", ["delivered", "read"])
          .gte("created_at", start),
        supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", id)
          .eq("direction", "outbound")
          .eq("status", "failed")
          .gte("created_at", start),
        supabase
          .from("activity_log")
          .select("created_at")
          .eq("organization_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const setting = settingsBy.get(id) ?? {};
      const consumed = round2(consumedBy.get(id) ?? 0);
      const metaCost = round2(metaCostBy.get(id) ?? 0);

      return {
        organization_id: id,
        name: row.name,
        plan_name: row.plan_name,
        plan_status: row.plan_status,
        funding_model: row.funding_model,
        balance: row.balance,
        held: row.held,
        available: round2(row.balance - row.held),
        meta_float: row.meta_float,
        low_credit_threshold: Number(setting["low_credit_threshold"] ?? 0),
        meta_float_target: Number(setting["meta_float_target"] ?? 0),
        mtd_consumed: consumed,
        mtd_meta_cost: metaCost,
        mtd_margin: round2(consumed - metaCost),
        sent: sent.count ?? 0,
        delivered: delivered.count ?? 0,
        failed: failed.count ?? 0,
        numbers: (row.numbers as Record<string, unknown>[]).map((n) => ({
          display: (n["display_phone_number"] as string) ?? null,
          quality: (n["quality_rating"] as string) ?? null,
          tier: n["messaging_tier"] === null || n["messaging_tier"] === undefined
            ? null
            : Number(n["messaging_tier"]),
        })),
        pending_topups: row.pending_topups,
        last_activity: (activity.data as { created_at?: string } | null)?.created_at ?? null,
      } satisfies AdminOverviewRow;
    }),
  );

  return { rows, tasks: base.tasks };
}

/** Top-ups the platform still owes Meta, oldest first. */
export async function listTopupTasks(supabase: SupabaseClient, actorId: string) {
  await requireSuper(supabase, actorId);
  const { data } = await supabase
    .from("topup_tasks")
    .select(
      "id, organization_id, whatsapp_account_id, trigger, credits_amount, meta_amount, margin_amount, currency, status, due_at, reminders_sent, last_reminder_at, created_at, organizations:organization_id(name), whatsapp_accounts:whatsapp_account_id(display_phone_number, waba_id)",
    )
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(100);
  return (data ?? []) as Record<string, unknown>[];
}

export async function skipTopupTask(
  supabase: SupabaseClient,
  input: { taskId: string; reason: string; actorId: string },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);
  if (!input.reason.trim()) return { error: "Say why this top-up is being skipped." };
  const { error } = await supabase
    .from("topup_tasks")
    .update({
      status: "skipped",
      skip_reason: input.reason.trim().slice(0, 300),
      done_by: input.actorId,
      done_at: new Date().toISOString(),
    })
    .eq("id", input.taskId)
    .eq("status", "pending");
  if (error) return { error: "We couldn't skip that top-up. Please try again." };
  return { ok: true };
}

// ------------------------------------------------------------ billing account

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export async function listBillingAccounts(supabase: SupabaseClient, actorId: string) {
  await requireSuper(supabase, actorId);
  const { data } = await supabase
    .from("billing_accounts")
    .select("id, name, legal_name, gstin, state_code, country_code, currency, billing_email")
    .order("name")
    .limit(200);
  return (data ?? []) as Record<string, unknown>[];
}

export async function saveBillingAccount(
  supabase: SupabaseClient,
  input: {
    actorId: string;
    organizationId: string;
    accountId?: string | null;
    account: Record<string, unknown>;
  },
): Promise<{ ok: true; id: string } | { error: string }> {
  await requireSuper(supabase, input.actorId);

  const gstin = String(input.account["gstin"] ?? "").trim().toUpperCase();
  if (gstin && !GSTIN_PATTERN.test(gstin)) {
    return { error: "That GSTIN doesn't look right — it should be 15 characters, like 27AAAAA0000A1Z5." };
  }
  const name = String(input.account["name"] ?? "").trim();
  if (!name) return { error: "The billing account needs a name." };

  const payload = {
    name,
    legal_name: (input.account["legal_name"] as string) || null,
    gstin: gstin || null,
    country_code: (input.account["country_code"] as string) || "IN",
    state_code: (input.account["state_code"] as string) || null,
    currency: (input.account["currency"] as string) || "INR",
    billing_email: (input.account["billing_email"] as string) || null,
    billing_whatsapp: (input.account["billing_whatsapp"] as string) || null,
    address: (input.account["address"] as Record<string, unknown>) ?? {},
    tds_applicable: input.account["tds_applicable"] === true,
  };

  let accountId = input.accountId ?? null;
  if (accountId) {
    const { error } = await supabase.from("billing_accounts").update(payload).eq("id", accountId);
    if (error) return { error: "We couldn't save those billing details." };
  } else {
    const { data, error } = await supabase
      .from("billing_accounts")
      .insert({ ...payload, created_by: input.actorId })
      .select("id")
      .single();
    if (error || !data) return { error: "We couldn't create that billing account." };
    accountId = data.id as string;
  }

  await supabase
    .from("organizations")
    .update({ billing_account_id: accountId })
    .eq("id", input.organizationId);

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "billing_account_updated",
    details: { billing_account_id: accountId },
  });

  return { ok: true, id: accountId };
}

/** Points an organization at a billing account that already exists. */
export async function linkBillingAccount(
  supabase: SupabaseClient,
  input: { actorId: string; organizationId: string; accountId: string },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);
  const { error } = await supabase
    .from("organizations")
    .update({ billing_account_id: input.accountId })
    .eq("id", input.organizationId);
  if (error) return { error: "We couldn't link that billing account." };
  return { ok: true };
}

// ------------------------------------------------------------------- rates

/**
 * A rate change is always a new row with its own effective_from — the history
 * of what a client was charged must stay readable, so nothing is ever edited
 * in place.
 */
export async function saveRateCard(
  supabase: SupabaseClient,
  input: {
    actorId: string;
    organizationId: string;
    countryCode: string;
    category: string;
    mode: "markup" | "fixed";
    markupPercent: number | null;
    fixedRate: number | null;
    currency?: string;
    effectiveFrom: string;
  },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);

  if (input.mode === "markup" && (input.markupPercent === null || input.markupPercent === undefined)) {
    return { error: "Enter the markup percentage." };
  }
  if (input.mode === "fixed" && (input.fixedRate === null || input.fixedRate === undefined)) {
    return { error: "Enter the fixed rate." };
  }

  const { error } = await supabase.from("rate_cards").insert({
    organization_id: input.organizationId,
    country_code: input.countryCode,
    category: input.category,
    mode: input.mode,
    markup_percent: input.mode === "markup" ? round2(Number(input.markupPercent)) : null,
    fixed_rate: input.mode === "fixed" ? round4(Number(input.fixedRate)) : null,
    currency: input.currency ?? "INR",
    effective_from: input.effectiveFrom,
    created_by: input.actorId,
  });
  if (error) return { error: "We couldn't save that rate. Please try again." };

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "billing_rate_updated",
    details: { category: input.category, country: input.countryCode, mode: input.mode },
  });
  return { ok: true };
}

// ---------------------------------------------------------------- settings

const SETTINGS_FIELDS = [
  "plan_fee_override",
  "starter_credits",
  "meta_float_target",
  "overdraft_limit",
  "low_credit_threshold",
  "auto_topup_enabled",
  "auto_topup_threshold",
  "auto_topup_pack_id",
  "monthly_budget_cap",
  "campaign_approval_threshold",
  "ai_answers_included_override",
  "credits_expire_months",
  "notes",
] as const;

export async function saveOrgBillingSettings(
  supabase: SupabaseClient,
  input: {
    actorId: string;
    organizationId: string;
    settings: Record<string, unknown>;
    fundingModel?: string | null;
    billingDay?: number | null;
  },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);

  const patch: Record<string, unknown> = { organization_id: input.organizationId, updated_by: input.actorId };
  for (const field of SETTINGS_FIELDS) {
    if (!(field in input.settings)) continue;
    const value = input.settings[field];
    patch[field] = value === "" ? null : value;
  }

  const { error } = await supabase
    .from("organization_billing_settings")
    .upsert(patch, { onConflict: "organization_id" });
  if (error) return { error: "We couldn't save those settings." };

  if (input.fundingModel || input.billingDay) {
    const orgPatch: Record<string, unknown> = {};
    if (input.fundingModel) orgPatch["funding_model"] = input.fundingModel;
    if (input.billingDay) orgPatch["billing_day"] = input.billingDay;
    await supabase.from("organizations").update(orgPatch).eq("id", input.organizationId);
  }

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "billing_settings_updated",
    details: { funding_model: input.fundingModel ?? null },
  });
  return { ok: true };
}

// ------------------------------------------------------------------ wallet

/** Money taken outside Razorpay — a bank transfer or a goodwill credit. */
export async function adminAddCredits(
  supabase: SupabaseClient,
  input: {
    actorId: string;
    organizationId: string;
    amount: number;
    method: string;
    reason: string;
  },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);
  if (!(input.amount > 0)) return { error: "Enter an amount greater than zero." };
  if (!input.reason.trim()) return { error: "A manual credit always needs a reason." };

  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .insert({
      organization_id: input.organizationId,
      provider: "manual",
      method: input.method || "bank_transfer",
      purpose: "credit_purchase",
      amount: round2(input.amount),
      currency: "INR",
      status: "paid",
      paid_at: new Date().toISOString(),
      raw: { reason: input.reason.trim().slice(0, 300), pack_amount: round2(input.amount), bonus: 0 },
      created_by: input.actorId,
    })
    .select("id")
    .single();
  if (payErr || !payment) return { error: "We couldn't record that payment." };

  const { error } = await supabase.rpc("wallet_apply", {
    p_org: input.organizationId,
    p_type: "credit_purchase",
    p_amount: round2(input.amount),
    p_ref_type: "payment",
    p_ref_id: payment.id,
    p_description: input.reason.trim().slice(0, 200),
    p_metadata: { manual: true, payment_id: payment.id },
    p_actor: input.actorId,
  });
  if (error) return { error: "We couldn't add those credits. Please try again." };

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "billing_credits_added",
    details: { amount: round2(input.amount), method: input.method },
  });
  return { ok: true };
}

/** A correction, in either direction, that always carries its reason. */
export async function adminAdjustment(
  supabase: SupabaseClient,
  input: { actorId: string; organizationId: string; amount: number; reason: string },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);
  if (input.amount === 0) return { error: "An adjustment of zero doesn't change anything." };
  if (!input.reason.trim()) return { error: "An adjustment always needs a reason." };

  const { error } = await supabase.rpc("wallet_apply", {
    p_org: input.organizationId,
    p_type: "adjustment",
    p_amount: round2(input.amount),
    p_ref_type: "manual",
    p_ref_id: null,
    p_description: input.reason.trim().slice(0, 200),
    p_metadata: { manual: true },
    p_actor: input.actorId,
  });
  if (error) return { error: "We couldn't apply that adjustment. Please try again." };

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "billing_adjustment",
    details: { amount: round2(input.amount) },
  });
  return { ok: true };
}

/** Float we placed with Meta before the client ever sent a message. */
export async function recordOnboardingFloat(
  supabase: SupabaseClient,
  input: {
    actorId: string;
    organizationId: string;
    amount: number;
    metaTxnRef: string | null;
    whatsappAccountId?: string | null;
  },
): Promise<{ ok: true } | { error: string }> {
  await requireSuper(supabase, input.actorId);
  if (!(input.amount > 0)) return { error: "Enter the amount placed with Meta." };

  const { data: task, error: taskErr } = await supabase
    .from("topup_tasks")
    .insert({
      organization_id: input.organizationId,
      whatsapp_account_id: input.whatsappAccountId ?? null,
      trigger: "onboarding_float",
      credits_amount: 0,
      meta_amount: round2(input.amount),
      margin_amount: 0,
      status: "pending",
      due_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (taskErr || !task) return { error: "We couldn't record that float." };

  const { completeTopupTask } = await import("@/lib/billing.server");
  const done = await completeTopupTask(supabase, {
    taskId: task.id as string,
    amount: round2(input.amount),
    metaTxnRef: input.metaTxnRef,
    actorId: input.actorId,
  });
  if ("error" in done) return done;
  return { ok: true };
}

export async function adminOrgPayments(
  supabase: SupabaseClient,
  organizationId: string,
  actorId: string,
) {
  await requireSuper(supabase, actorId);
  const { data } = await supabase
    .from("payments")
    .select("id, provider, method, purpose, status, amount, currency, paid_at, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []) as Record<string, unknown>[];
}
