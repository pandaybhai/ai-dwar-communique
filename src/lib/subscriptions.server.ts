import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, withGst } from "@/lib/billing";

/**
 * Auto-pay for the monthly plan fee.
 *
 * The merchant authorises one mandate; Razorpay charges it on schedule and
 * tells us through the webhook. Every charge becomes a payment row and a
 * numbered tax invoice with the month's usage stated on it.
 */

export type AutoPayStatus = {
  enabled: boolean;
  status: string | null;
  cycle: string | null;
  next_charge_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  short_url: string | null;
};

const ACTIVE_STATES = ["created", "authenticated", "active", "pending", "halted"];

export async function getAutoPay(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<AutoPayStatus> {
  const { data } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("organization_id", organizationId)
    .in("status", ACTIVE_STATES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = (data ?? null) as Record<string, unknown> | null;
  if (!row) {
    return {
      enabled: false,
      status: null,
      cycle: null,
      next_charge_at: null,
      current_period_end: null,
      cancel_at_period_end: false,
      short_url: null,
    };
  }
  const raw = (row["raw"] ?? {}) as Record<string, unknown>;
  return {
    enabled: row["status"] === "active" || row["status"] === "authenticated",
    status: String(row["status"]),
    cycle: String(row["billing_cycle"]),
    next_charge_at: (row["next_charge_at"] as string | null) ?? null,
    current_period_end: (row["current_period_end"] as string | null) ?? null,
    cancel_at_period_end: row["cancel_at_period_end"] === true,
    short_url: (raw["short_url"] as string | null) ?? null,
  };
}

/** Creates the mandate and hands back the authorisation link. */
export async function setupAutoPay(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string; cycle: "monthly" | "annual" },
): Promise<{ url: string } | { error: string }> {
  const { PermissionError } = await import("@/lib/billing.server");
  const { hasPermission } = await import("@/lib/permissions.server");
  if (!(await hasPermission(supabase, input.organizationId, input.userId, "billing.pay"))) {
    throw new PermissionError("billing.pay");
  }

  const existing = await getAutoPay(supabase, input.organizationId);
  if (existing.status === "active" || existing.status === "authenticated") {
    return { error: "Auto-pay is already set up for this workspace." };
  }
  if (existing.short_url) return { url: existing.short_url };

  const { razorpayKeys, createPlan, createSubscription, PAYMENTS_NOT_CONFIGURED } = await import(
    "@/lib/razorpay.server"
  );
  const keys = await razorpayKeys(supabase);
  if (!keys) return { error: PAYMENTS_NOT_CONFIGURED };

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, billing_account_id, plan_version_id")
    .eq("id", input.organizationId)
    .maybeSingle();
  const planVersionId = (org?.["plan_version_id"] as string | null) ?? null;
  if (!planVersionId) return { error: "This workspace isn't on a plan yet." };

  const { data: version } = await supabase
    .from("plan_versions")
    .select("id, price_monthly, price_annual, plans:plan_id(name)")
    .eq("id", planVersionId)
    .maybeSingle();
  if (!version) return { error: "We couldn't find the plan for this workspace." };

  const base =
    input.cycle === "annual"
      ? (version["price_annual"] as number | null)
      : (version["price_monthly"] as number | null);
  if (base === null || base === undefined) {
    return { error: "This plan doesn't have a price for that billing cycle." };
  }
  const planName = (version["plans"] as unknown as Record<string, unknown>)?.["name"] as string;
  const gross = withGst(Number(base)).total;

  const plan = await createPlan(keys, {
    period: input.cycle === "annual" ? "yearly" : "monthly",
    amount: gross,
    name: `AiDwar ${planName} (${input.cycle})`,
    description: `AiDwar ${planName} plan fee, inclusive of 18% GST`,
  });
  if (!plan.ok) return { error: plan.error ?? "We couldn't set up auto-pay." };

  const subscription = await createSubscription(keys, {
    planId: String(plan.body["id"]),
    cycle: input.cycle,
    organizationId: input.organizationId,
  });
  if (!subscription.ok) return { error: subscription.error ?? "We couldn't set up auto-pay." };

  const shortUrl = String(subscription.body["short_url"] ?? "");
  await supabase.from("subscriptions").insert({
    organization_id: input.organizationId,
    billing_account_id: (org?.["billing_account_id"] as string | null) ?? null,
    plan_version_id: planVersionId,
    billing_cycle: input.cycle,
    provider: "razorpay",
    provider_subscription_id: String(subscription.body["id"]),
    provider_plan_id: String(plan.body["id"]),
    status: "created",
    mandate_max_amount: round2(gross),
    raw: { ...subscription.body, short_url: shortUrl },
  });

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    action: "autopay_setup",
    details: { cycle: input.cycle, plan: planName },
  });

  if (!shortUrl) return { error: "The payment provider didn't return an authorisation link." };
  return { url: shortUrl };
}

export async function cancelAutoPay(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string },
): Promise<{ ok: true } | { error: string }> {
  const { PermissionError } = await import("@/lib/billing.server");
  const { hasPermission } = await import("@/lib/permissions.server");
  if (!(await hasPermission(supabase, input.organizationId, input.userId, "billing.pay"))) {
    throw new PermissionError("billing.pay");
  }

  const { data: row } = await supabase
    .from("subscriptions")
    .select("id, provider_subscription_id")
    .eq("organization_id", input.organizationId)
    .in("status", ACTIVE_STATES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return { error: "There's no auto-pay to cancel." };

  const { razorpayKeys, cancelSubscription, PAYMENTS_NOT_CONFIGURED } = await import(
    "@/lib/razorpay.server"
  );
  const keys = await razorpayKeys(supabase);
  if (!keys) return { error: PAYMENTS_NOT_CONFIGURED };

  const result = await cancelSubscription(keys, String(row["provider_subscription_id"]), true);
  if (!result.ok) return { error: result.error ?? "We couldn't cancel auto-pay." };

  await supabase
    .from("subscriptions")
    .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
    .eq("id", row["id"] as string);

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    action: "autopay_cancelled",
    details: {},
  });
  return { ok: true };
}

// ------------------------------------------------------------- webhook side

function iso(seconds: unknown): string | null {
  const value = Number(seconds ?? 0);
  return value > 0 ? new Date(value * 1000).toISOString() : null;
}

/** Applies a subscription.* event. Safe to replay. */
export async function applySubscriptionEvent(
  supabase: SupabaseClient,
  event: string,
  subscription: Record<string, unknown>,
  payment: Record<string, unknown> | null,
  raw: Record<string, unknown>,
): Promise<void> {
  const providerId = String(subscription["id"] ?? "");
  if (!providerId) return;

  const { data: row } = await supabase
    .from("subscriptions")
    .select("id, organization_id, plan_version_id, billing_cycle, billing_account_id, raw")
    .eq("provider_subscription_id", providerId)
    .maybeSingle();
  if (!row) return;

  const orgId = String(row["organization_id"]);
  const existingRaw = (row["raw"] ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {
    current_period_start: iso(subscription["current_start"]),
    current_period_end: iso(subscription["current_end"]),
    next_charge_at: iso(subscription["charge_at"]),
    raw: { ...existingRaw, last_event: event, entity: subscription },
    updated_at: new Date().toISOString(),
  };

  const kind = event.replace("subscription.", "");

  if (kind === "authenticated" || kind === "activated") {
    patch["status"] = kind === "activated" ? "active" : "authenticated";
    await supabase
      .from("organizations")
      .update({ plan_status: "active", trial_ends_at: null })
      .eq("id", orgId);
    await unpauseForPayment(supabase, orgId);
  } else if (kind === "charged") {
    patch["status"] = "active";
    await supabase.from("organizations").update({ plan_status: "active" }).eq("id", orgId);
    await unpauseForPayment(supabase, orgId);
    await recordPlanCharge(supabase, {
      organizationId: orgId,
      subscription: row as Record<string, unknown>,
      entity: subscription,
      payment,
      raw,
    });
  } else if (kind === "halted" || kind === "pending") {
    patch["status"] = kind;
    await supabase.from("organizations").update({ plan_status: "past_due" }).eq("id", orgId);
    const { notify } = await import("@/lib/billing.server");
    await notify(supabase, {
      organizationId: orgId,
      audience: "client",
      kind: "payment_failed",
      payload: { reason: kind },
    });
  } else if (kind === "cancelled" || kind === "completed") {
    patch["status"] = kind;
    await supabase.from("organizations").update({ plan_status: "cancelled" }).eq("id", orgId);
  } else if (kind === "paused") {
    patch["status"] = "paused";
  }

  await supabase.from("subscriptions").update(patch).eq("id", row["id"] as string);
}

async function unpauseForPayment(supabase: SupabaseClient, organizationId: string): Promise<void> {
  const { restoreAfterPayment } = await import("@/lib/dunning.server");
  await restoreAfterPayment(supabase, organizationId);
}

/**
 * A successful mandate charge: one payment row, one numbered tax invoice
 * carrying the plan fee plus the month's usage as informational lines.
 */
async function recordPlanCharge(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    subscription: Record<string, unknown>;
    entity: Record<string, unknown>;
    payment: Record<string, unknown> | null;
    raw: Record<string, unknown>;
  },
): Promise<void> {
  const providerPaymentId = (input.payment?.["id"] as string | null) ?? null;
  if (providerPaymentId) {
    const { data: seen } = await supabase
      .from("payments")
      .select("id")
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle();
    if (seen) return; // replay
  }

  const gross = round2(Number(input.payment?.["amount"] ?? 0) / 100);
  const periodStart = iso(input.entity["current_start"]) ?? new Date().toISOString();
  const periodEnd = iso(input.entity["current_end"]) ?? new Date().toISOString();

  const { data: version } = await supabase
    .from("plan_versions")
    .select("price_monthly, price_annual, plans:plan_id(name)")
    .eq("id", input.subscription["plan_version_id"] as string)
    .maybeSingle();
  const planName =
    (((version?.["plans"] ?? {}) as Record<string, unknown>)["name"] as string) ?? "Plan";
  const cycle = String(input.subscription["billing_cycle"] ?? "monthly");
  const listed =
    cycle === "annual"
      ? (version?.["price_annual"] as number | null)
      : (version?.["price_monthly"] as number | null);
  // The mandate charges GST-inclusive; the invoice states the base.
  const base = listed === null || listed === undefined ? round2(gross / 1.18) : Number(listed);

  const { data: paymentRow } = await supabase
    .from("payments")
    .insert({
      organization_id: input.organizationId,
      billing_account_id: (input.subscription["billing_account_id"] as string | null) ?? null,
      provider: "razorpay",
      provider_payment_id: providerPaymentId,
      purpose: "plan_fee",
      amount: gross,
      currency: "INR",
      method: "mandate",
      status: "paid",
      paid_at: new Date().toISOString(),
      raw: input.raw,
    })
    .select("id")
    .maybeSingle();

  const { buildStatementLines, planFeeRoiSnapshot } = await import("@/lib/billing-statement.server");
  const { loadSupplier, buildInvoice, issueInvoice, markPaid } = await import(
    "@/lib/invoices.server"
  );
  const supplier = await loadSupplier(supabase);
  const statement = await buildStatementLines(supabase, input.organizationId, periodStart, periodEnd);
  const roi = await planFeeRoiSnapshot(supabase, input.organizationId, periodStart, periodEnd);

  const built = await buildInvoice(supabase, input.organizationId, {
    kind: "tax_invoice",
    purpose: "plan_fee",
    payment_id: (paymentRow?.["id"] as string | null) ?? null,
    period: { start: periodStart.slice(0, 10), end: periodEnd.slice(0, 10) },
    roi_snapshot: roi,
    lines: [
      {
        line_type: "plan",
        description: `${planName} plan — ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}`,
        sac_code: supplier.sac_platform,
        unit_price: base,
      },
      ...statement,
    ],
  });
  if ("error" in built) return;
  await issueInvoice(supabase, built.invoice_id);
  await markPaid(supabase, built.invoice_id, (paymentRow?.["id"] as string | null) ?? null, gross);
}
