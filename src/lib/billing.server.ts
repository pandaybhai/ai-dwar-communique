import type { SupabaseClient } from "@supabase/supabase-js";
import { FEATURES } from "@/lib/feature-registry";
import {
  MESSAGE_CATEGORIES,
  round2,
  round4,
  withGst,
  type BillingSummary,
  type CampaignCostEstimate,
  type ClientRate,
  type MessageCategory,
  type UsageBucket,
} from "@/lib/billing";

/**
 * The money core.
 *
 * Every wallet movement goes through public.wallet_apply — no debit or credit
 * arithmetic is repeated here, so the ledger and the balance can never drift.
 * Rates reach client surfaces only through public.client_rate_for, which
 * already hides the Meta cost and the markup.
 */

const MONTH_MS = 30 * 864e5;

export type ActorContext = { organizationId: string; userId: string };

export async function billingEnabled(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data } = await supabase.rpc("org_flag_enabled", {
    p_org: organizationId,
    p_flag: "billing",
  });
  return data === true;
}

function monthWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function ensureSettings(supabase: SupabaseClient, organizationId: string) {
  const { data } = await supabase
    .from("organization_billing_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (data) return data as Record<string, unknown>;
  const { data: created } = await supabase
    .from("organization_billing_settings")
    .insert({ organization_id: organizationId })
    .select("*")
    .maybeSingle();
  return (created ?? {}) as Record<string, unknown>;
}

async function ensureWallet(supabase: SupabaseClient, organizationId: string) {
  const { data } = await supabase
    .from("wallet_balances")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (data) return data as Record<string, unknown>;
  const { data: created } = await supabase
    .from("wallet_balances")
    .insert({ organization_id: organizationId })
    .select("*")
    .maybeSingle();
  return (created ?? { balance: 0, held: 0, currency: "INR" }) as Record<string, unknown>;
}

export async function clientRates(
  supabase: SupabaseClient,
  organizationId: string,
  country = "IN",
): Promise<ClientRate[]> {
  const rows = await Promise.all(
    MESSAGE_CATEGORIES.map(async (category) => {
      const { data } = await supabase.rpc("client_rate_for", {
        p_org: organizationId,
        p_country: country,
        p_category: category,
      });
      const row = (Array.isArray(data) ? data[0] : null) as
        | { rate: number | null; currency: string | null }
        | null;
      return {
        category,
        rate: row?.rate === null || row?.rate === undefined ? null : Number(row.rate),
        currency: row?.currency ?? "INR",
      } satisfies ClientRate;
    }),
  );
  return rows;
}

/** One client rate, with the Meta cost stripped out. */
export async function rateFor(
  supabase: SupabaseClient,
  organizationId: string,
  category: MessageCategory,
  country = "IN",
): Promise<{ rate: number; currency: string }> {
  const { data } = await supabase.rpc("client_rate_for", {
    p_org: organizationId,
    p_country: country,
    p_category: category,
  });
  const row = (Array.isArray(data) ? data[0] : null) as
    | { rate: number | null; currency: string | null }
    | null;
  return { rate: Number(row?.rate ?? 0), currency: row?.currency ?? "INR" };
}

/** Month-to-date spend, split the way a merchant thinks about it. */
async function usageBuckets(
  supabase: SupabaseClient,
  organizationId: string,
  start: string,
  end: string,
): Promise<{ buckets: UsageBucket[]; total: number }> {
  const { data } = await supabase
    .from("wallet_ledger")
    .select("entry_type, amount, metadata")
    .eq("organization_id", organizationId)
    .in("entry_type", ["debit_message", "debit_ai", "debit_addon"])
    .gte("created_at", start)
    .lt("created_at", end);

  const rows = (data ?? []) as { entry_type: string; amount: number; metadata: Record<string, unknown> }[];
  const seed: Record<UsageBucket["category"], UsageBucket> = {
    messaging: { category: "messaging", label: "Campaigns & broadcasts", amount: 0, count: 0 },
    automation: { category: "automation", label: "Automations & flows", amount: 0, count: 0 },
    inbox: { category: "inbox", label: "Inbox replies", amount: 0, count: 0 },
    ai: { category: "ai", label: "AI answers", amount: 0, count: 0 },
  };

  for (const row of rows) {
    const source = String(row.metadata?.["source"] ?? "");
    let key: UsageBucket["category"] = "messaging";
    if (row.entry_type === "debit_ai") key = "ai";
    else if (source === "flow" || source === "automation") key = "automation";
    else if (source === "inbox") key = "inbox";
    const bucket = seed[key];
    bucket.amount = round2(bucket.amount + Math.abs(Number(row.amount ?? 0)));
    bucket.count += 1;
  }

  const buckets = Object.values(seed);
  return { buckets, total: round2(buckets.reduce((sum, b) => sum + b.amount, 0)) };
}

export async function getClientBillingSummary(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<BillingSummary> {
  const { start, end } = monthWindow();
  const [enabled, wallet, settings] = await Promise.all([
    billingEnabled(supabase, organizationId),
    ensureWallet(supabase, organizationId),
    ensureSettings(supabase, organizationId),
  ]);

  const [{ data: org }, rates, usage, { data: packs }, { data: allowance }] = await Promise.all([
    supabase
      .from("organizations")
      .select(
        "plan_status, trial_ends_at, billing_day, billing_account_id, plan_version_id, plan_versions:plan_version_id(price_monthly, limits, highlights, plans:plan_id(key, name, tagline))",
      )
      .eq("id", organizationId)
      .maybeSingle(),
    clientRates(supabase, organizationId),
    usageBuckets(supabase, organizationId, start, end),
    supabase
      .from("credit_packs")
      .select("id, name, amount, bonus_amount, currency")
      .eq("is_active", true)
      .order("sort_order"),
    supabase.rpc("ai_answers_allowance", { p_org: organizationId }),
  ]);

  const orgRow = (org ?? {}) as Record<string, unknown>;
  const version = (orgRow["plan_versions"] ?? null) as Record<string, unknown> | null;
  const planRow = (version?.["plans"] ?? null) as Record<string, unknown> | null;

  const [{ count: aiUsed }, { data: account }] = await Promise.all([
    supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", start)
      .lt("created_at", end),
    orgRow["billing_account_id"]
      ? supabase
          .from("billing_accounts")
          .select("id, name, gstin, billing_email, state_code")
          .eq("id", orgRow["billing_account_id"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const balance = Number(wallet["balance"] ?? 0);
  const held = Number(wallet["held"] ?? 0);
  const accountRow = (account ?? null) as Record<string, unknown> | null;

  return {
    organization_id: organizationId,
    enabled,
    wallet: {
      balance: round2(balance),
      held: round2(held),
      available: round2(balance - held),
      currency: String(wallet["currency"] ?? "INR"),
      lifetime_purchased: round2(Number(wallet["lifetime_purchased"] ?? 0)),
      lifetime_consumed: round2(Number(wallet["lifetime_consumed"] ?? 0)),
    },
    plan: {
      key: (planRow?.["key"] as string) ?? null,
      name: (planRow?.["name"] as string) ?? null,
      tagline: (planRow?.["tagline"] as string) ?? null,
      status: (orgRow["plan_status"] as string) ?? null,
      price_monthly:
        version?.["price_monthly"] === undefined || version?.["price_monthly"] === null
          ? null
          : Number(version["price_monthly"]),
      limits: (version?.["limits"] as Record<string, number>) ?? {},
      highlights: (version?.["highlights"] as string[]) ?? [],
      trial_ends_at: (orgRow["trial_ends_at"] as string) ?? null,
      billing_day: (orgRow["billing_day"] as number) ?? null,
    },
    ai_answers: { included: Number(allowance ?? 0), used: Number(aiUsed ?? 0) },
    usage: usage.buckets,
    usage_total: usage.total,
    rates,
    packs: (packs ?? []) as BillingSummary["packs"],
    settings: {
      low_credit_threshold: Number(settings["low_credit_threshold"] ?? 0),
      auto_topup_enabled: settings["auto_topup_enabled"] === true,
      monthly_budget_cap:
        settings["monthly_budget_cap"] === null || settings["monthly_budget_cap"] === undefined
          ? null
          : Number(settings["monthly_budget_cap"]),
      campaign_approval_threshold:
        settings["campaign_approval_threshold"] === null ||
        settings["campaign_approval_threshold"] === undefined
          ? null
          : Number(settings["campaign_approval_threshold"]),
      overdraft_limit: Number(settings["overdraft_limit"] ?? 0),
      credits_expire_months: Number(settings["credits_expire_months"] ?? 12),
    },
    billing_account: {
      id: (accountRow?.["id"] as string) ?? null,
      name: (accountRow?.["name"] as string) ?? null,
      gstin: (accountRow?.["gstin"] as string) ?? null,
      billing_email: (accountRow?.["billing_email"] as string) ?? null,
      state_code: (accountRow?.["state_code"] as string) ?? null,
    },
    period: { start, end },
  };
}

export async function listLedger(
  supabase: SupabaseClient,
  organizationId: string,
  { limit = 50, before }: { limit?: number; before?: string | null } = {},
) {
  let query = supabase
    .from("wallet_ledger")
    .select("id, entry_type, amount, balance_after, currency, description, reference_type, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (before) query = query.lt("created_at", before);
  const { data } = await query;
  return (data ?? []) as Record<string, unknown>[];
}

// ---------------------------------------------------------------- purchases

export async function createCreditPurchase(
  supabase: SupabaseClient,
  input: ActorContext & { packId: string; couponCode?: string | null; origin: string },
): Promise<{ url: string; payment_id: string } | { error: string }> {
  const { razorpayKeys, createPaymentLink, PAYMENTS_NOT_CONFIGURED } = await import(
    "@/lib/razorpay.server"
  );

  const { data: pack } = await supabase
    .from("credit_packs")
    .select("id, name, amount, bonus_amount, currency, is_active")
    .eq("id", input.packId)
    .maybeSingle();
  if (!pack || pack.is_active !== true) return { error: "That credit pack is no longer available." };

  let coupon: Record<string, unknown> | null = null;
  if (input.couponCode?.trim()) {
    const code = input.couponCode.trim().toUpperCase();
    const { data: found } = await supabase
      .from("coupons")
      .select("id, code, kind, value, max_uses, uses, valid_from, valid_to, is_active")
      .eq("code", code)
      .maybeSingle();
    const today = new Date().toISOString().slice(0, 10);
    const usable =
      found &&
      found.is_active === true &&
      String(found.valid_from) <= today &&
      (found.valid_to === null || String(found.valid_to) >= today) &&
      (found.max_uses === null || Number(found.uses ?? 0) < Number(found.max_uses));
    if (!usable) return { error: "That coupon code isn't valid any more." };
    coupon = found as Record<string, unknown>;
  }

  const keys = await razorpayKeys(supabase);
  if (!keys) return { error: PAYMENTS_NOT_CONFIGURED };

  const base = Number(pack.amount);
  const { gst, total } = withGst(base);

  const { data: org } = await supabase
    .from("organizations")
    .select("name, billing_account_id, billing_accounts:billing_account_id(billing_email, billing_whatsapp, name)")
    .eq("id", input.organizationId)
    .maybeSingle();
  const account = ((org ?? {}) as Record<string, unknown>)["billing_accounts"] as
    | Record<string, unknown>
    | null;

  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .insert({
      organization_id: input.organizationId,
      billing_account_id: ((org ?? {}) as Record<string, unknown>)["billing_account_id"] ?? null,
      provider: "razorpay",
      purpose: "credit_purchase",
      credit_pack_id: pack.id,
      coupon_id: coupon ? (coupon["id"] as string) : null,
      amount: total,
      currency: pack.currency ?? "INR",
      status: "created",
      raw: { pack_amount: base, gst, bonus: Number(pack.bonus_amount ?? 0) },
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (payErr || !payment) return { error: "We couldn't start this payment. Please try again." };

  const { link, error } = await createPaymentLink(keys, {
    amount: total,
    currency: pack.currency ?? "INR",
    description: `${pack.name} credits for ${String(((org ?? {}) as Record<string, unknown>)["name"] ?? "your workspace")}`,
    reference: payment.id as string,
    customer: {
      name: (account?.["name"] as string) ?? (((org ?? {}) as Record<string, unknown>)["name"] as string),
      email: (account?.["billing_email"] as string) ?? null,
      contact: (account?.["billing_whatsapp"] as string) ?? null,
    },
    callbackUrl: `${input.origin}/app/billing?payment=${payment.id}`,
    notes: { organization_id: input.organizationId, payment_id: payment.id as string },
  });

  if (!link || error) {
    await supabase.from("payments").update({ status: "failed", raw: { error } }).eq("id", payment.id);
    return { error: error ?? "We couldn't create the payment link. Please try again." };
  }

  await supabase
    .from("payments")
    .update({ provider_link_id: link.id, status: "pending", raw: link.raw })
    .eq("id", payment.id);

  return { url: link.short_url, payment_id: payment.id as string };
}

/** Credits a paid payment exactly once, then queues the follow-up work. */
export async function settlePayment(
  supabase: SupabaseClient,
  paymentId: string,
  providerPaymentId: string | null,
  raw: Record<string, unknown>,
): Promise<{ credited: boolean }> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, organization_id, status, amount, currency, credit_pack_id, coupon_id, purpose, raw")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment) return { credited: false };
  if (payment.status === "paid") return { credited: false }; // already settled

  await supabase
    .from("payments")
    .update({
      status: "paid",
      provider_payment_id: providerPaymentId,
      paid_at: new Date().toISOString(),
      raw: { ...(payment.raw as Record<string, unknown>), webhook: raw },
    })
    .eq("id", payment.id);

  if (payment.purpose !== "credit_purchase" || !payment.organization_id) return { credited: false };

  const stored = (payment.raw ?? {}) as Record<string, unknown>;
  const credits = Number(stored["pack_amount"] ?? 0);
  const bonus = Number(stored["bonus"] ?? 0);

  await supabase.rpc("wallet_apply", {
    p_org: payment.organization_id,
    p_type: "credit_purchase",
    p_amount: credits,
    p_ref_type: "payment",
    p_ref_id: payment.id,
    p_description: "Credits bought",
    p_metadata: { payment_id: payment.id },
  });
  if (bonus > 0) {
    await supabase.rpc("wallet_apply", {
      p_org: payment.organization_id,
      p_type: "bonus_credits",
      p_amount: bonus,
      p_ref_type: "payment",
      p_ref_id: payment.id,
      p_description: "Bonus credits",
      p_metadata: { payment_id: payment.id },
    });
  }

  if (payment.coupon_id) {
    const { data: coupon } = await supabase
      .from("coupons")
      .select("id, kind, value, uses")
      .eq("id", payment.coupon_id)
      .maybeSingle();
    if (coupon) {
      if (coupon.kind === "bonus_credits" && Number(coupon.value) > 0) {
        await supabase.rpc("wallet_apply", {
          p_org: payment.organization_id,
          p_type: "coupon_credits",
          p_amount: Number(coupon.value),
          p_ref_type: "payment",
          p_ref_id: payment.id,
          p_description: "Coupon credits",
          p_metadata: { coupon_id: coupon.id },
        });
      }
      await supabase
        .from("coupons")
        .update({ uses: Number(coupon.uses ?? 0) + 1 })
        .eq("id", coupon.id);
    }
  }

  // A credit purchase means we owe Meta more float: queue the top-up task.
  await queueTopupTask(supabase, {
    organizationId: payment.organization_id as string,
    trigger: "credit_purchase",
    creditsAmount: credits + bonus,
    paymentId: payment.id as string,
  });

  await notify(supabase, {
    organizationId: payment.organization_id as string,
    audience: "client",
    kind: "credits_added",
    payload: { amount: credits, bonus },
  });

  // Prompt 2 turns this draft into a numbered tax invoice.
  await supabase.from("invoices").insert({
    organization_id: payment.organization_id,
    payment_id: payment.id,
    series: "AD",
    kind: "tax_invoice",
    purpose: "credit_purchase",
    status: "draft",
    issue_date: new Date().toISOString().slice(0, 10),
    currency: payment.currency ?? "INR",
    subtotal: credits,
    taxable_value: credits,
    total: Number(payment.amount ?? 0),
    amount_paid: Number(payment.amount ?? 0),
    buyer_snapshot: {},
  });

  return { credited: true };
}

// ------------------------------------------------------------- meta float

export async function queueTopupTask(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    trigger: "credit_purchase" | "float_low" | "onboarding_float" | "manual";
    creditsAmount?: number;
    metaAmount?: number;
    paymentId?: string | null;
    whatsappAccountId?: string | null;
  },
): Promise<void> {
  const credits = Number(input.creditsAmount ?? 0);
  // What we must place with Meta: the client rate less our margin. Without a
  // marketing rate on file we mirror the credits and let the operator correct.
  const rate = await rateFor(supabase, input.organizationId, "marketing");
  const { data: metaRow } = await supabase
    .from("message_rates")
    .select("rate")
    .eq("country_code", "IN")
    .eq("category", "marketing")
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  const metaRate = Number((metaRow as { rate?: number } | null)?.rate ?? 0);
  const ratio = rate.rate > 0 && metaRate > 0 ? metaRate / rate.rate : 1;
  const metaAmount = round2(input.metaAmount ?? credits * ratio);

  await supabase.from("topup_tasks").insert({
    organization_id: input.organizationId,
    whatsapp_account_id: input.whatsappAccountId ?? null,
    trigger: input.trigger,
    credits_amount: credits,
    meta_amount: metaAmount,
    margin_amount: round2(credits - metaAmount),
    status: "pending",
    due_at: new Date(Date.now() + 12 * 3600e3).toISOString(),
    payment_id: input.paymentId ?? null,
  });

  await notify(supabase, {
    organizationId: input.organizationId,
    audience: "admin",
    kind: "topup_due",
    payload: { credits, meta_amount: metaAmount, trigger: input.trigger },
  });
}

export async function completeTopupTask(
  supabase: SupabaseClient,
  input: { taskId: string; amount: number; metaTxnRef: string | null; actorId: string },
): Promise<{ ok: true } | { error: string }> {
  const { data: task } = await supabase
    .from("topup_tasks")
    .select("id, organization_id, whatsapp_account_id, status")
    .eq("id", input.taskId)
    .maybeSingle();
  if (!task) return { error: "That top-up task no longer exists." };
  if (task.status === "done") return { error: "This top-up is already marked done." };

  const previous = Number(
    (await supabase.rpc("meta_balance_estimate", { p_org: task.organization_id })).data ?? 0,
  );
  await supabase.from("meta_prepaid_ledger").insert({
    organization_id: task.organization_id,
    whatsapp_account_id: task.whatsapp_account_id,
    entry_type: "topup",
    amount: input.amount,
    balance_after: round2(previous + input.amount),
    meta_txn_ref: input.metaTxnRef,
    reference_type: "topup_task",
    reference_id: task.id,
    created_by: input.actorId,
  });

  await supabase
    .from("topup_tasks")
    .update({
      status: "done",
      amount_topped_up: input.amount,
      meta_txn_ref: input.metaTxnRef,
      done_by: input.actorId,
      done_at: new Date().toISOString(),
    })
    .eq("id", task.id);

  return { ok: true };
}

// ---------------------------------------------------------------- top-ups

export async function requestTopup(
  supabase: SupabaseClient,
  input: ActorContext & { amount: number | null; note: string | null },
): Promise<{ ok: true }> {
  await notify(supabase, {
    organizationId: input.organizationId,
    audience: "client",
    kind: "topup_requested",
    payload: {
      amount: input.amount,
      note: input.note?.slice(0, 300) ?? null,
      requested_by: input.userId,
    },
  });
  await notify(supabase, {
    organizationId: input.organizationId,
    audience: "admin",
    kind: "topup_requested",
    payload: { amount: input.amount, requested_by: input.userId },
  });
  return { ok: true };
}

export async function notify(
  supabase: SupabaseClient,
  input: {
    organizationId: string | null;
    audience: "client" | "admin";
    kind: string;
    payload: Record<string, unknown>;
    channel?: "whatsapp" | "email" | "inapp";
    recipient?: string | null;
  },
): Promise<void> {
  try {
    await supabase.from("billing_notifications").insert({
      organization_id: input.organizationId,
      audience: input.audience,
      kind: input.kind,
      channel: input.channel ?? "whatsapp",
      recipient: input.recipient ?? null,
      payload: input.payload,
      status: "queued",
    });
  } catch {
    // a queued notice must never break the money path
  }
}

// ------------------------------------------------------------ plans & flags

export async function recommendPlan(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ plan_key: string | null; reason: string }> {
  const [{ count: members }, { count: numbers }, { data: versions }] = await Promise.all([
    supabase
      .from("organization_members")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    supabase
      .from("whatsapp_accounts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    supabase
      .from("plan_versions")
      .select("limits, plans:plan_id(key, name, sort_order, is_active)")
      .eq("is_current", true),
  ]);

  const { start, end } = monthWindow();
  const { count: aiUsed } = await supabase
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .gte("created_at", start)
    .lt("created_at", end);

  const rows = ((versions ?? []) as Record<string, unknown>[])
    .map((v) => ({
      limits: (v["limits"] ?? {}) as Record<string, number>,
      plan: (v["plans"] ?? {}) as Record<string, unknown>,
    }))
    .filter((r) => r.plan["is_active"] === true)
    .sort((a, b) => Number(a.plan["sort_order"] ?? 0) - Number(b.plan["sort_order"] ?? 0));

  const fits = (limit: number | undefined, need: number) =>
    limit === undefined || limit === -1 || limit >= need;

  const match = rows.find(
    (r) =>
      fits(r.limits["members"], Number(members ?? 0)) &&
      fits(r.limits["numbers"], Number(numbers ?? 0)) &&
      fits(r.limits["ai_answers"], Number(aiUsed ?? 0)),
  );

  return {
    plan_key: (match?.plan["key"] as string) ?? null,
    reason: `${members ?? 0} teammates, ${numbers ?? 0} number(s) and ${aiUsed ?? 0} AI answers this month.`,
  };
}

export async function assignPlan(
  supabase: SupabaseClient,
  input: { organizationId: string; planKey: string; actorId: string; status?: string },
): Promise<{ ok: true } | { error: string }> {
  const { data: version } = await supabase
    .from("plan_versions")
    .select("id, plans:plan_id(key)")
    .eq("is_current", true);
  const row = ((version ?? []) as Record<string, unknown>[]).find(
    (v) => ((v["plans"] ?? {}) as Record<string, unknown>)["key"] === input.planKey,
  );
  if (!row) return { error: "That plan doesn't have a current version." };

  const { error } = await supabase
    .from("organizations")
    .update({
      plan_version_id: row["id"],
      plan_status: input.status ?? "active",
    })
    .eq("id", input.organizationId);
  if (error) return { error: "We couldn't change the plan. Please try again." };

  // A plan carries a set of features. Manual super-admin decisions are kept.
  const settings = await ensureSettings(supabase, input.organizationId);
  const overrides = (settings["limits_override"] ?? {}) as Record<string, unknown>;
  const manual = (overrides["_manual_flags"] ?? {}) as Record<string, boolean>;

  const { data: full } = await supabase
    .from("plan_versions")
    .select("features")
    .eq("id", row["id"] as string)
    .maybeSingle();
  const planFeatures = (full?.["features"] ?? []) as string[];

  if (planFeatures.length > 0) {
    for (const feature of FEATURES) {
      if (feature.key in manual) continue;
      const enabled = planFeatures.includes(feature.key);
      await supabase
        .from("organization_feature_overrides")
        .upsert(
          { organization_id: input.organizationId, flag_key: feature.flag_key, enabled },
          { onConflict: "organization_id,flag_key" },
        );
    }
  }

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "plan_changed",
    details: { plan: input.planKey },
  });

  return { ok: true };
}

export type FeatureImpact = {
  flag_key: string;
  feature_key: string;
  feature_name: string;
  dependents: { key: string; name: string }[];
  live: { label: string; count: number }[];
  blocking: boolean;
};

/** What actually breaks if this feature is switched off right now. */
export async function featureImpact(
  supabase: SupabaseClient,
  organizationId: string,
  featureKey: string,
): Promise<FeatureImpact> {
  const feature = FEATURES.find((f) => f.key === featureKey);
  const dependents = FEATURES.filter((f) => f.depends_on.includes(featureKey)).map((f) => ({
    key: f.key,
    name: f.name,
  }));

  const counts: { label: string; count: number }[] = [];
  const add = async (label: string, promise: PromiseLike<{ count: number | null }>) => {
    const { count } = await promise;
    if ((count ?? 0) > 0) counts.push({ label, count: count ?? 0 });
  };

  const scoped = (table: string) =>
    supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  if (featureKey === "shopify") {
    await add("connected stores", scoped("shopify_stores"));
    await add("synced products", scoped("products"));
  }
  if (featureKey === "flows") {
    await add("live flows", scoped("flows").eq("is_enabled", true));
    await add("messages waiting to go out", scoped("scheduled_sends").eq("status", "pending"));
  }
  if (featureKey === "campaigns") {
    await add("campaigns sending or scheduled", scoped("campaigns").in("status", ["sending", "scheduled"]));
  }
  if (featureKey === "ai") {
    await add("conversations the AI is handling", scoped("conversations").eq("status", "open"));
  }
  if (featureKey === "contacts") {
    await add("contacts", scoped("contacts"));
  }
  if (featureKey === "templates") {
    await add("approved templates", scoped("message_templates").eq("status", "APPROVED"));
  }
  if (featureKey === "inbox") {
    await add("open conversations", scoped("conversations").eq("status", "open"));
  }

  return {
    flag_key: feature?.flag_key ?? featureKey,
    feature_key: featureKey,
    feature_name: feature?.name ?? featureKey,
    dependents,
    live: counts,
    blocking: dependents.length > 0 || counts.length > 0,
  };
}

export async function setFeatureOverride(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    featureKey: string;
    enabled: boolean;
    force?: boolean;
    actorId: string;
  },
): Promise<{ ok: true } | { impact: FeatureImpact } | { error: string }> {
  const feature = FEATURES.find((f) => f.key === input.featureKey);
  if (!feature) return { error: "Unknown feature." };

  if (!input.enabled) {
    const impact = await featureImpact(supabase, input.organizationId, input.featureKey);
    if (impact.blocking && input.force !== true) return { impact };
    if (input.force === true) await pauseDependents(supabase, input.organizationId, input.featureKey);
  }

  const { error } = await supabase
    .from("organization_feature_overrides")
    .upsert(
      { organization_id: input.organizationId, flag_key: feature.flag_key, enabled: input.enabled },
      { onConflict: "organization_id,flag_key" },
    );
  if (error) return { error: "We couldn't change that setting. Please try again." };

  // Remember that a person decided this, so a later plan change respects it.
  const settings = await ensureSettings(supabase, input.organizationId);
  const overrides = { ...((settings["limits_override"] ?? {}) as Record<string, unknown>) };
  const manual = { ...((overrides["_manual_flags"] ?? {}) as Record<string, boolean>) };
  manual[feature.key] = input.enabled;
  overrides["_manual_flags"] = manual;
  await supabase
    .from("organization_billing_settings")
    .upsert(
      { organization_id: input.organizationId, limits_override: overrides, updated_by: input.actorId },
      { onConflict: "organization_id" },
    );

  return { ok: true };
}

/** Switching a feature off pauses what depends on it — it never deletes. */
async function pauseDependents(
  supabase: SupabaseClient,
  organizationId: string,
  featureKey: string,
): Promise<void> {
  if (featureKey === "flows" || featureKey === "shopify" || featureKey === "templates") {
    await supabase
      .from("flows")
      .update({ is_enabled: false })
      .eq("organization_id", organizationId)
      .eq("is_enabled", true);
    await supabase
      .from("scheduled_sends")
      .update({ status: "cancelled" })
      .eq("organization_id", organizationId)
      .eq("status", "pending");
  }
  if (featureKey === "campaigns" || featureKey === "templates" || featureKey === "contacts") {
    await supabase
      .from("campaigns")
      .update({ status: "paused" })
      .eq("organization_id", organizationId)
      .in("status", ["sending", "scheduled"]);
  }
}

// ------------------------------------------------------------ campaign spend

export async function estimateCampaignCost(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    recipients: number;
    category?: MessageCategory;
    whatsappAccountId?: string | null;
  },
): Promise<CampaignCostEstimate> {
  const category = input.category ?? "marketing";
  const enabled = await billingEnabled(supabase, input.organizationId);
  const [{ rate, currency }, wallet, settings] = await Promise.all([
    rateFor(supabase, input.organizationId, category),
    ensureWallet(supabase, input.organizationId),
    ensureSettings(supabase, input.organizationId),
  ]);

  const available = round2(Number(wallet["balance"] ?? 0) - Number(wallet["held"] ?? 0));
  const overdraft = Number(settings["overdraft_limit"] ?? 0);
  const estimate = round2(rate * input.recipients);
  const shortfall = round2(Math.max(0, estimate - (available + overdraft)));
  const threshold =
    settings["campaign_approval_threshold"] === null ||
    settings["campaign_approval_threshold"] === undefined
      ? null
      : Number(settings["campaign_approval_threshold"]);

  let dailyLimit: number | null = null;
  if (input.whatsappAccountId) {
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("messaging_tier")
      .eq("id", input.whatsappAccountId)
      .maybeSingle();
    const tier = Number((account as { messaging_tier?: number } | null)?.messaging_tier ?? 0);
    dailyLimit = tier > 0 ? tier : null;
  }

  return {
    enabled,
    recipients: input.recipients,
    category,
    rate: round4(rate),
    currency,
    estimate,
    available,
    shortfall,
    can_send: !enabled || shortfall === 0,
    needs_approval: enabled && threshold !== null && estimate > threshold,
    approval_threshold: threshold,
    daily_limit: dailyLimit,
    over_daily_limit: dailyLimit !== null && input.recipients > dailyLimit,
    days_needed: dailyLimit !== null && dailyLimit > 0 ? Math.ceil(input.recipients / dailyLimit) : 1,
  };
}

/** Holds the estimate so two campaigns can't spend the same credits. */
export async function holdCampaignSpend(
  supabase: SupabaseClient,
  input: { organizationId: string; campaignId: string; amount: number; actorId: string },
): Promise<{ ok: true } | { error: string }> {
  if (input.amount <= 0) return { ok: true };
  const { error } = await supabase.rpc("wallet_apply", {
    p_org: input.organizationId,
    p_type: "hold",
    p_amount: input.amount,
    p_ref_type: "campaign",
    p_ref_id: input.campaignId,
    p_description: "Held for a campaign",
    p_metadata: { campaign_id: input.campaignId },
    p_actor: input.actorId,
  });
  if (error) {
    return {
      error: error.message.includes("INSUFFICIENT_CREDITS")
        ? "There aren't enough credits to cover this campaign."
        : "We couldn't reserve credits for this campaign. Please try again.",
    };
  }
  return { ok: true };
}

/** Gives back whatever the campaign didn't use once it finishes. */
export async function releaseCampaignHold(
  supabase: SupabaseClient,
  input: { organizationId: string; campaignId: string; amount: number },
): Promise<void> {
  if (input.amount <= 0) return;
  await supabase.rpc("wallet_apply", {
    p_org: input.organizationId,
    p_type: "hold_release",
    p_amount: input.amount,
    p_ref_type: "campaign",
    p_ref_id: input.campaignId,
    p_description: "Unused campaign credits returned",
    p_metadata: { campaign_id: input.campaignId },
  });
}

// --------------------------------------------------------------- admin view

export async function adminBillingOverview(supabase: SupabaseClient) {
  const [{ data: orgs }, { data: wallets }, { data: tasks }, { data: numbers }, { data: meta }] =
    await Promise.all([
      supabase
        .from("organizations")
        .select("id, name, status, plan_status, funding_model, plan_version_id, plan_versions:plan_version_id(price_monthly, plans:plan_id(key, name))")
        .order("name"),
      supabase.from("wallet_balances").select("organization_id, balance, held, currency, lifetime_purchased, lifetime_consumed"),
      supabase
        .from("topup_tasks")
        .select("id, organization_id, trigger, credits_amount, meta_amount, margin_amount, status, due_at, created_at")
        .eq("status", "pending")
        .order("due_at"),
      supabase
        .from("whatsapp_accounts")
        .select("id, organization_id, display_phone_number, quality_rating, messaging_tier, status"),
      supabase
        .from("meta_prepaid_ledger")
        .select("organization_id, balance_after, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
    ]);

  const walletBy = new Map<string, Record<string, unknown>>();
  for (const w of (wallets ?? []) as Record<string, unknown>[])
    walletBy.set(String(w["organization_id"]), w);

  const floatBy = new Map<string, number>();
  for (const m of (meta ?? []) as Record<string, unknown>[]) {
    const key = String(m["organization_id"]);
    if (!floatBy.has(key)) floatBy.set(key, Number(m["balance_after"] ?? 0));
  }

  const numbersBy = new Map<string, Record<string, unknown>[]>();
  for (const n of (numbers ?? []) as Record<string, unknown>[]) {
    const key = String(n["organization_id"]);
    numbersBy.set(key, [...(numbersBy.get(key) ?? []), n]);
  }

  const pendingBy = new Map<string, number>();
  for (const t of (tasks ?? []) as Record<string, unknown>[]) {
    const key = String(t["organization_id"]);
    pendingBy.set(key, (pendingBy.get(key) ?? 0) + 1);
  }

  const rows = ((orgs ?? []) as Record<string, unknown>[]).map((org) => {
    const id = String(org["id"]);
    const wallet = walletBy.get(id) ?? {};
    const version = (org["plan_versions"] ?? null) as Record<string, unknown> | null;
    const plan = (version?.["plans"] ?? null) as Record<string, unknown> | null;
    const purchased = Number(wallet["lifetime_purchased"] ?? 0);
    const float = floatBy.get(id) ?? 0;
    return {
      organization_id: id,
      name: String(org["name"] ?? ""),
      status: String(org["status"] ?? ""),
      plan_status: (org["plan_status"] as string) ?? null,
      plan_name: (plan?.["name"] as string) ?? null,
      plan_fee: version?.["price_monthly"] === undefined ? null : Number(version?.["price_monthly"]),
      funding_model: (org["funding_model"] as string) ?? null,
      balance: round2(Number(wallet["balance"] ?? 0)),
      held: round2(Number(wallet["held"] ?? 0)),
      lifetime_purchased: round2(purchased),
      lifetime_consumed: round2(Number(wallet["lifetime_consumed"] ?? 0)),
      meta_float: round2(float),
      margin: round2(purchased - float),
      pending_topups: pendingBy.get(id) ?? 0,
      numbers: numbersBy.get(id) ?? [],
    };
  });

  return { rows, tasks: (tasks ?? []) as Record<string, unknown>[] };
}

export async function adminOrgBilling(supabase: SupabaseClient, organizationId: string) {
  const [summary, { data: settings }, { data: rateCards }, { data: ledger }, { data: overrides }, { data: metaRates }] =
    await Promise.all([
      getClientBillingSummary(supabase, organizationId),
      supabase.from("organization_billing_settings").select("*").eq("organization_id", organizationId).maybeSingle(),
      supabase
        .from("rate_cards")
        .select("id, organization_id, country_code, category, mode, markup_percent, fixed_rate, currency, effective_from, effective_to")
        .or(`organization_id.eq.${organizationId},organization_id.is.null`)
        .order("effective_from", { ascending: false }),
      supabase
        .from("wallet_ledger")
        .select("id, entry_type, amount, balance_after, currency, description, reference_type, created_at")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("organization_feature_overrides")
        .select("flag_key, enabled")
        .eq("organization_id", organizationId),
      supabase
        .from("message_rates")
        .select("country_code, category, rate, currency, effective_from")
        .order("effective_from", { ascending: false }),
    ]);

  const recommendation = await recommendPlan(supabase, organizationId);
  const { data: plans } = await supabase
    .from("plan_versions")
    .select("id, price_monthly, limits, plans:plan_id(key, name, is_active)")
    .eq("is_current", true);

  return {
    summary,
    settings: settings ?? null,
    rate_cards: rateCards ?? [],
    ledger: ledger ?? [],
    overrides: overrides ?? [],
    meta_rates: metaRates ?? [],
    plans: plans ?? [],
    recommendation,
  };
}
