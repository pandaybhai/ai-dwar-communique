import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PUBLIC_URL } from "@/lib/app-url";
import { round2, withGst } from "@/lib/billing";

/**
 * Self-serve plan purchase for trial and locked workspaces.
 *
 * The app only ever sets organizations.plan_version_id + plan_status='active'.
 * Database triggers (org_plan_assigned_before / org_plan_assigned_billing_on)
 * own every side effect: billing_enabled_at, the AI cap, billing settings
 * and the billing feature flag. Nothing is granted to the wallet here.
 */

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export type PurchasablePlan = {
  key: string;
  name: string;
  tagline: string | null;
  plan_version_id: string;
  price_monthly: number | null;
  price_annual: number | null;
  currency: string;
  limits: Record<string, unknown>;
  highlights: string[];
};

export type PlanPurchaseState = {
  plan_status: string;
  plan_version_id: string | null;
  trial_ends_at: string | null;
  current_plan: { key: string; name: string } | null;
  suggested_plan: string | null;
  default_whatsapp: string | null;
  gstin: string | null;
  pending_payment: { id: string; url: string | null; plan_key: string | null } | null;
  plans: PurchasablePlan[];
};

export async function purchasablePlans(supabase: SupabaseClient): Promise<PurchasablePlan[]> {
  const { data } = await supabase
    .from("plans")
    .select(
      "key, name, tagline, sort_order, plan_versions(id, price_monthly, price_annual, currency, limits, highlights, is_current)",
    )
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");

  return ((data ?? []) as Record<string, unknown>[])
    .map((plan) => {
      const version = ((plan["plan_versions"] ?? []) as Record<string, unknown>[]).find(
        (v) => v["is_current"] === true,
      );
      if (!version) return null;
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return {
        key: String(plan["key"]),
        name: String(plan["name"]),
        tagline: (plan["tagline"] as string | null) ?? null,
        plan_version_id: String(version["id"]),
        price_monthly: num(version["price_monthly"]),
        price_annual: num(version["price_annual"]),
        currency: String(version["currency"] ?? "INR"),
        limits: (version["limits"] as Record<string, unknown>) ?? {},
        highlights: (version["highlights"] as string[]) ?? [],
      } satisfies PurchasablePlan;
    })
    .filter((p): p is PurchasablePlan => p !== null);
}

export async function planPurchaseState(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string },
): Promise<PlanPurchaseState> {
  const [{ data: org }, plans, { data: session }, { data: profile }, { data: pending }] =
    await Promise.all([
      supabase
        .from("organizations")
        .select(
          "plan_status, plan_version_id, trial_ends_at, billing_account_id, billing_accounts:billing_account_id(gstin, billing_whatsapp), plan_versions:plan_version_id(plans(key, name))",
        )
        .eq("id", input.organizationId)
        .maybeSingle(),
      purchasablePlans(supabase),
      supabase
        .from("onboarding_sessions")
        .select("phone, attribution")
        .eq("organization_id", input.organizationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("profiles").select("phone").eq("id", input.userId).maybeSingle(),
      supabase
        .from("payments")
        .select("id, raw")
        .eq("organization_id", input.organizationId)
        .eq("purpose", "plan_fee")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const o = (org ?? {}) as Record<string, unknown>;
  const account = (o["billing_accounts"] ?? null) as Record<string, unknown> | null;
  const version = (o["plan_versions"] ?? null) as Record<string, unknown> | null;
  const currentPlan = (version?.["plans"] ?? null) as Record<string, unknown> | null;
  const attribution = ((session as Record<string, unknown> | null)?.["attribution"] ?? {}) as Record<
    string,
    unknown
  >;
  const pendingRaw = ((pending as Record<string, unknown> | null)?.["raw"] ?? {}) as Record<
    string,
    unknown
  >;
  const pendingLink = (pendingRaw["link"] ?? {}) as Record<string, unknown>;

  return {
    plan_status: String(o["plan_status"] ?? "trial"),
    plan_version_id: (o["plan_version_id"] as string | null) ?? null,
    trial_ends_at: (o["trial_ends_at"] as string | null) ?? null,
    current_plan: currentPlan
      ? { key: String(currentPlan["key"]), name: String(currentPlan["name"]) }
      : null,
    suggested_plan: typeof attribution["plan"] === "string" ? (attribution["plan"] as string) : null,
    default_whatsapp:
      (account?.["billing_whatsapp"] as string | null) ??
      ((session as Record<string, unknown> | null)?.["phone"] as string | null) ??
      ((profile as Record<string, unknown> | null)?.["phone"] as string | null) ??
      null,
    gstin: (account?.["gstin"] as string | null) ?? null,
    pending_payment:
      pending && pendingRaw["kind"] === "plan_purchase"
        ? {
            id: String((pending as Record<string, unknown>)["id"]),
            url: (pendingLink["short_url"] as string | null) ?? null,
            plan_key: (pendingRaw["plan_key"] as string | null) ?? null,
          }
        : null,
    plans,
  };
}

/** Creates the billing account for a self-signup workspace if it has none. */
async function ensureBillingAccount(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    orgName: string;
    existingId: string | null;
    gstin: string | null;
    billingWhatsapp: string | null;
    billingEmail: string | null;
  },
): Promise<{ id: string } | { error: string }> {
  if (input.existingId) {
    const patch: Record<string, unknown> = {};
    if (input.gstin) patch["gstin"] = input.gstin;
    if (input.billingWhatsapp) patch["billing_whatsapp"] = input.billingWhatsapp;
    if (Object.keys(patch).length > 0) {
      await supabase.from("billing_accounts").update(patch).eq("id", input.existingId);
    }
    return { id: input.existingId };
  }
  const { data, error } = await supabase
    .from("billing_accounts")
    .insert({
      name: input.orgName,
      legal_name: input.orgName,
      gstin: input.gstin,
      state_code: input.gstin ? input.gstin.slice(0, 2) : null,
      country_code: "IN",
      currency: "INR",
      billing_email: input.billingEmail,
      billing_whatsapp: input.billingWhatsapp,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { error: "We couldn't set up your billing details. Please try again." };
  await supabase
    .from("organizations")
    .update({ billing_account_id: data.id })
    .eq("id", input.organizationId);
  return { id: data.id as string };
}

export async function startPlanPurchase(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    planKey: string;
    gstin?: string | null;
    billingWhatsapp?: string | null;
  },
): Promise<{ url: string; payment_id: string } | { error: string }> {
  const { hasPermission } = await import("@/lib/permissions.server");
  if (!(await hasPermission(supabase, input.organizationId, input.userId, "billing.pay"))) {
    return { error: "Only an owner can choose a plan for this workspace." };
  }

  const plans = await purchasablePlans(supabase);
  const plan = plans.find((p) => p.key === input.planKey);
  if (!plan) return { error: "That plan isn't available right now." };
  if (plan.price_monthly === null || plan.price_monthly <= 0) {
    return { error: "This plan is priced for you personally — write to us and we'll set it up." };
  }

  const gstin = (input.gstin ?? "").trim().toUpperCase() || null;
  if (gstin && !GSTIN_PATTERN.test(gstin)) {
    return { error: "That GSTIN doesn't look right — it should be 15 characters, like 27AAAAA0000A1Z5." };
  }
  const billingWhatsapp = (input.billingWhatsapp ?? "").replace(/[^\d+]/g, "") || null;
  if (billingWhatsapp && billingWhatsapp.replace(/\D/g, "").length < 10) {
    return { error: "That billing WhatsApp number looks too short." };
  }

  const { razorpayKeys, createPaymentLink, PAYMENTS_NOT_CONFIGURED } =
    await import("@/lib/razorpay.server");
  const keys = await razorpayKeys(supabase);
  if (!keys) return { error: PAYMENTS_NOT_CONFIGURED };

  const [{ data: org }, { data: profile }] = await Promise.all([
    supabase
      .from("organizations")
      .select("name, billing_account_id, plan_status, plan_version_id")
      .eq("id", input.organizationId)
      .maybeSingle(),
    supabase.from("profiles").select("email, full_name").eq("id", input.userId).maybeSingle(),
  ]);
  if (!org) return { error: "We couldn't find this workspace." };
  const o = org as Record<string, unknown>;
  if (o["plan_status"] === "active" && o["plan_version_id"] === plan.plan_version_id) {
    return { error: "You're already on this plan." };
  }

  const account = await ensureBillingAccount(supabase, {
    organizationId: input.organizationId,
    userId: input.userId,
    orgName: String(o["name"] ?? "Workspace"),
    existingId: (o["billing_account_id"] as string | null) ?? null,
    gstin,
    billingWhatsapp,
    billingEmail: ((profile as Record<string, unknown> | null)?.["email"] as string | null) ?? null,
  });
  if ("error" in account) return account;

  const base = round2(plan.price_monthly);
  const { gst, total } = withGst(base);

  // One live plan link at a time: earlier unpaid attempts are closed off.
  const { data: stale } = await supabase
    .from("payments")
    .select("id, raw")
    .eq("organization_id", input.organizationId)
    .eq("purpose", "plan_fee")
    .in("status", ["created", "pending"])
    .contains("raw", { kind: "plan_purchase" });
  for (const old of (stale ?? []) as Record<string, unknown>[]) {
    await supabase
      .from("payments")
      .update({
        status: "failed",
        raw: { ...((old["raw"] ?? {}) as Record<string, unknown>), reason: "superseded" },
      })
      .eq("id", old["id"] as string);
  }

  const raw = {
    kind: "plan_purchase",
    plan_key: plan.key,
    plan_name: plan.name,
    plan_version_id: plan.plan_version_id,
    cycle: "monthly",
    gst_rate: 0.18,
    gst_amount: gst,
    gross_amount: total,
  };

  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .insert({
      organization_id: input.organizationId,
      billing_account_id: account.id,
      provider: "razorpay",
      purpose: "plan_fee",
      amount: base, // ex-GST, like every plan_fee row
      currency: "INR",
      status: "created",
      raw,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (payErr || !payment) return { error: "We couldn't start this payment. Please try again." };

  const { link, error } = await createPaymentLink(keys, {
    amount: total,
    currency: "INR",
    description: `AiDwar ${plan.name} plan — first month (incl. 18% GST)`,
    reference: payment.id as string,
    customer: {
      name: String(o["name"] ?? ""),
      email: ((profile as Record<string, unknown> | null)?.["email"] as string | null) ?? null,
      contact: billingWhatsapp,
    },
    callbackUrl: `${APP_PUBLIC_URL}/app/billing?payment=${payment.id}`,
    expireBy: Math.floor(Date.now() / 1000) + 24 * 3600,
    notes: {
      organization_id: input.organizationId,
      payment_id: payment.id as string,
      plan_key: plan.key,
    },
  });
  if (!link || error) {
    await supabase
      .from("payments")
      .update({ status: "failed", raw: { ...raw, error } })
      .eq("id", payment.id);
    return { error: error ?? "We couldn't create the payment link. Please try again." };
  }

  await supabase
    .from("payments")
    .update({
      provider_link_id: link.id,
      status: "pending",
      raw: {
        ...raw,
        expires_at: new Date(Date.now() + 24 * 3600e3).toISOString(),
        link: link.raw,
      },
    })
    .eq("id", payment.id);

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    action: "plan_purchase_started",
    details: { payment_id: payment.id, plan_key: plan.key, amount: base },
  });

  return { url: link.short_url, payment_id: payment.id as string };
}

/**
 * Called by settlePayment once a plan_purchase payment is paid. Sets the plan
 * and the status only — the triggers do the rest.
 */
export async function activatePlanFromPayment(
  supabase: SupabaseClient,
  payment: { id: string; organization_id: string; raw: Record<string, unknown> },
): Promise<void> {
  const planVersionId = payment.raw["plan_version_id"];
  if (typeof planVersionId !== "string" || !planVersionId) return;

  const { error } = await supabase
    .from("organizations")
    .update({ plan_version_id: planVersionId, plan_status: "active", trial_ends_at: null })
    .eq("id", payment.organization_id);
  if (error) {
    console.error("[plan-purchase] activation failed", payment.id, error.message);
    await supabase
      .from("payments")
      .update({ raw: { ...payment.raw, activation_error: error.message.slice(0, 300) } })
      .eq("id", payment.id);
    return;
  }

  await supabase.from("activity_log").insert({
    organization_id: payment.organization_id,
    user_id: null,
    action: "plan_purchased",
    details: {
      payment_id: payment.id,
      plan_key: payment.raw["plan_key"] ?? null,
      plan_version_id: planVersionId,
    },
  });
}
