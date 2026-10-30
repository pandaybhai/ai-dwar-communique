import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";
import { loadGstRegistered, priceNow } from "@/lib/gst-mode.server";

/** What the provider shows on the mandate. */
function planFeeDescription(planName: string, registered: boolean): string {
  return registered
    ? `AiDwar ${planName} plan fee, inclusive of 18% GST`
    : `AiDwar ${planName} plan fee`;
}

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
  /** The first charge, when it is still ahead (a trial's remaining days kept). */
  starts_at: string | null;
  /** The gateway this mandate (or a new one) runs on. */
  gateway: "cashfree" | "razorpay";
  /**
   * No auto-pay on offer: the workspace is on Cashfree without Cashfree
   * Subscriptions, so each period's fee comes as an invoice with a pay link.
   */
  pay_per_period: boolean;
  /** A Cashfree mandate still waiting for its authorisation. */
  checkout: { subscription_session_id: string; mode: "sandbox" | "production" } | null;
};

// Razorpay wants start_at in the future; a trial ending sooner than this is
// treated as over (charged on authorisation, exactly as before).
const START_AT_MARGIN_MS = 10 * 60_000;

/**
 * When the first plan charge should happen: the trial's end, if this is a
 * trial workspace whose trial still has time left (so those days are kept);
 * otherwise null = charge on authorisation, exactly as before.
 */
export function firstChargeAt(
  org: { plan_status?: string | null; trial_ends_at?: string | null },
  now: number = Date.now(),
): number | null {
  if (org.plan_status !== "trial" || !org.trial_ends_at) return null;
  const end = Date.parse(org.trial_ends_at);
  if (!Number.isFinite(end) || end <= now + START_AT_MARGIN_MS) return null;
  return Math.floor(end / 1000);
}

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
  const { paymentGateway } = await import("@/lib/cashfree-billing.server");
  const { cashfreeSubscriptionsEnabled } = await import("@/lib/cashfree.server");
  const gateway =
    row?.["provider"] === "cashfree" || row?.["provider"] === "razorpay"
      ? (row["provider"] as "cashfree" | "razorpay")
      : await paymentGateway(supabase, organizationId);
  if (!row) {
    return {
      enabled: false,
      status: null,
      cycle: null,
      next_charge_at: null,
      current_period_end: null,
      cancel_at_period_end: false,
      short_url: null,
      starts_at: null,
      gateway,
      pay_per_period: gateway === "cashfree" && !cashfreeSubscriptionsEnabled(),
      checkout: null,
    };
  }
  const raw = (row["raw"] ?? {}) as Record<string, unknown>;
  const startAt = Number(raw["start_at"] ?? 0);
  const sessionId =
    typeof raw["subscription_session_id"] === "string"
      ? (raw["subscription_session_id"] as string)
      : "";
  return {
    enabled: row["status"] === "active" || row["status"] === "authenticated",
    status: String(row["status"]),
    cycle: String(row["billing_cycle"]),
    next_charge_at: (row["next_charge_at"] as string | null) ?? null,
    current_period_end: (row["current_period_end"] as string | null) ?? null,
    cancel_at_period_end: row["cancel_at_period_end"] === true,
    short_url: (raw["short_url"] as string | null) ?? null,
    starts_at: startAt > 0 && startAt * 1000 > Date.now() ? new Date(startAt * 1000).toISOString() : null,
    gateway,
    pay_per_period: false,
    checkout:
      gateway === "cashfree" && row["status"] === "created" && sessionId
        ? {
            subscription_session_id: sessionId,
            mode: raw["cashfree_env"] === "production" ? "production" : "sandbox",
          }
        : null,
  };
}

/** Said when the workspace is on Cashfree without Cashfree Subscriptions. */
export const PAY_PER_PERIOD_NOTE =
  "Auto-pay isn't available yet. Each month you'll get your plan invoice with a payment link on WhatsApp and email — pay it from there, or with Pay now on the invoice below.";

/** Creates the mandate and hands back the authorisation link. */
export async function setupAutoPay(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string; cycle: "monthly" | "annual" },
): Promise<
  | { url: string }
  | { checkout: { subscription_session_id: string; mode: "sandbox" | "production" } }
  | { error: string }
> {
  const { PermissionError } = await import("@/lib/billing.server");
  const { hasPermission } = await import("@/lib/permissions.server");
  if (!(await hasPermission(supabase, input.organizationId, input.userId, "billing.pay"))) {
    throw new PermissionError("billing.pay");
  }

  const existing = await getAutoPay(supabase, input.organizationId);
  if (existing.status === "active" || existing.status === "authenticated") {
    return { error: "Auto-pay is already set up for this workspace." };
  }
  if (existing.checkout) return { checkout: existing.checkout };
  if (existing.short_url) return { url: existing.short_url };
  if (existing.gateway === "cashfree") {
    if (existing.pay_per_period) return { error: PAY_PER_PERIOD_NOTE };
    if (
      !(await hasPermission(supabase, input.organizationId, input.userId, "cashfree_billing.pay"))
    ) {
      throw new PermissionError("cashfree_billing.pay");
    }
    return setupCashfreeAutoPay(supabase, input);
  }

  const { razorpayKeys, createPlan, createSubscription, PAYMENTS_NOT_CONFIGURED } = await import(
    "@/lib/razorpay.server"
  );
  const keys = await razorpayKeys(supabase);
  if (!keys) return { error: PAYMENTS_NOT_CONFIGURED };

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, billing_account_id, plan_version_id, plan_status, trial_ends_at")
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
  // Batch 55: GST only while the platform is GST-registered.
  const priced = await priceNow(supabase, Number(base));
  if ("error" in priced) return priced;
  const gross = priced.total;

  const plan = await createPlan(keys, {
    period: input.cycle === "annual" ? "yearly" : "monthly",
    amount: gross,
    name: `AiDwar ${planName} (${input.cycle})`,
    description: planFeeDescription(planName, priced.registered),
  });
  if (!plan.ok) return { error: plan.error ?? "We couldn't set up auto-pay." };

  // A trial workspace keeps its remaining trial days: the first charge is on
  // the day the trial ends.
  const startAt = firstChargeAt((org ?? {}) as { plan_status?: string | null; trial_ends_at?: string | null });
  const subscription = await createSubscription(keys, {
    planId: String(plan.body["id"]),
    cycle: input.cycle,
    organizationId: input.organizationId,
    ...(startAt ? { startAt } : {}),
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
    raw: { ...subscription.body, short_url: shortUrl, ...(startAt ? { start_at: startAt } : {}) },
  });

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    action: "autopay_setup",
    details: {
      cycle: input.cycle,
      plan: planName,
      ...(startAt ? { first_charge_at: new Date(startAt * 1000).toISOString() } : {}),
    },
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
    .select("id, provider, provider_subscription_id")
    .eq("organization_id", input.organizationId)
    .in("status", ACTIVE_STATES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return { error: "There's no auto-pay to cancel." };

  if (row["provider"] === "cashfree") {
    // Cashfree cancels at once; the period already paid stays paid (the
    // CANCELLED webhook leaves the plan alone when we asked for it), and
    // the next period comes as an invoice with a pay link.
    const { cashfreeConfig, cancelSubscription: cancelCashfree } =
      await import("@/lib/cashfree.server");
    const { PAYMENTS_NOT_CONFIGURED } = await import("@/lib/razorpay.server");
    const config = cashfreeConfig();
    if (!config) return { error: PAYMENTS_NOT_CONFIGURED };
    // Marked first, so the webhook that answers the cancel already sees it.
    await supabase
      .from("subscriptions")
      .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
      .eq("id", row["id"] as string);
    const result = await cancelCashfree(config, String(row["provider_subscription_id"]));
    if (!result.ok) {
      await supabase
        .from("subscriptions")
        .update({ cancel_at_period_end: false, updated_at: new Date().toISOString() })
        .eq("id", row["id"] as string);
      return { error: result.error ?? "We couldn't cancel auto-pay." };
    }
    await supabase.from("activity_log").insert({
      organization_id: input.organizationId,
      user_id: input.userId,
      action: "autopay_cancelled",
      details: { gateway: "cashfree" },
    });
    return { ok: true };
  }

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

/**
 * Keeps the auto-pay mandate and the assigned plan in step. The provider is
 * asked to move the mandate onto the new plan from the next cycle; if it
 * refuses, the mandate is cancelled at the end of the period so nothing is
 * ever charged for a plan the workspace has left.
 */
export async function alignSubscriptionToPlan(
  supabase: SupabaseClient,
  input: { organizationId: string; planVersionId: string; actorId: string },
): Promise<{ changed: boolean; note: string; needs_new_mandate?: boolean }> {
  const { data: row } = await supabase
    .from("subscriptions")
    .select("id, provider, provider_subscription_id, plan_version_id, billing_cycle")
    .eq("organization_id", input.organizationId)
    .in("status", ACTIVE_STATES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return { changed: false, note: "No auto-pay mandate for this workspace." };
  if ((row["plan_version_id"] as string | null) === input.planVersionId) {
    return { changed: false, note: "Auto-pay already matches this plan." };
  }

  if (row["provider"] === "cashfree") {
    // A Cashfree mandate's amount can't be moved: it is cancelled (the paid
    // period stays), so nothing is ever charged for a plan the workspace left.
    const { cashfreeConfig, cancelSubscription: cancelCashfree } =
      await import("@/lib/cashfree.server");
    const config = cashfreeConfig();
    const { PAYMENTS_NOT_CONFIGURED } = await import("@/lib/razorpay.server");
    if (!config) return { changed: false, note: PAYMENTS_NOT_CONFIGURED };
    await supabase
      .from("subscriptions")
      .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
      .eq("id", row["id"] as string);
    const cancelled = await cancelCashfree(config, String(row["provider_subscription_id"]));
    await supabase.from("activity_log").insert({
      organization_id: input.organizationId,
      user_id: input.actorId,
      action: "autopay_plan_changed",
      details: {
        outcome: cancelled.ok ? "cancelled" : "cancel_failed",
        gateway: "cashfree",
        reason: cancelled.error,
      },
    });
    return {
      changed: true,
      needs_new_mandate: true,
      note: cancelled.ok
        ? "The Cashfree auto-pay mandate was stopped — set up a fresh one on the new plan."
        : `The Cashfree auto-pay mandate couldn't be stopped (${cancelled.error ?? "unknown error"}) — stop it in the Cashfree dashboard.`,
    };
  }

  const {
    razorpayKeys,
    createPlan,
    updateSubscriptionPlan,
    cancelSubscription,
    PAYMENTS_NOT_CONFIGURED,
  } = await import("@/lib/razorpay.server");
  const keys = await razorpayKeys(supabase);
  if (!keys) return { changed: false, note: PAYMENTS_NOT_CONFIGURED };

  const cycle = String(row["billing_cycle"] ?? "monthly") === "annual" ? "annual" : "monthly";
  const { data: version } = await supabase
    .from("plan_versions")
    .select("price_monthly, price_annual, plans:plan_id(name)")
    .eq("id", input.planVersionId)
    .maybeSingle();
  const base =
    cycle === "annual"
      ? (version?.["price_annual"] as number | null)
      : (version?.["price_monthly"] as number | null);
  const planName =
    ((version?.["plans"] as unknown as Record<string, unknown>)?.["name"] as string) ?? "plan";

  const subscriptionId = String(row["provider_subscription_id"]);
  const fail = async (note: string) => {
    const cancelled = await cancelSubscription(keys, subscriptionId, true);
    if (cancelled.ok) {
      await supabase
        .from("subscriptions")
        .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
        .eq("id", row["id"] as string);
    }
    await supabase.from("activity_log").insert({
      organization_id: input.organizationId,
      user_id: input.actorId,
      action: "autopay_plan_changed",
      details: { plan: planName, outcome: "cancelled_at_period_end", reason: note },
    });
    return {
      changed: true,
      needs_new_mandate: true,
      note: `${note} Auto-pay will stop at the end of this period — set up a fresh mandate on ${planName}.`,
    };
  };

  if (base === null || base === undefined) {
    return fail(`The ${planName} plan has no ${cycle} price.`);
  }
  const priced = await priceNow(supabase, Number(base));
  if ("error" in priced) return fail(priced.error);
  const gross = priced.total;

  const plan = await createPlan(keys, {
    period: cycle === "annual" ? "yearly" : "monthly",
    amount: gross,
    name: `AiDwar ${planName} (${cycle})`,
    description: planFeeDescription(planName, priced.registered),
  });
  if (!plan.ok) return fail(plan.error ?? "The payment provider couldn't create the new plan.");

  const updated = await updateSubscriptionPlan(keys, subscriptionId, String(plan.body["id"]));
  if (!updated.ok) return fail(updated.error ?? "The mandate couldn't be moved to the new plan.");

  await supabase
    .from("subscriptions")
    .update({
      plan_version_id: input.planVersionId,
      provider_plan_id: String(plan.body["id"]),
      mandate_max_amount: round2(gross),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row["id"] as string);

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "autopay_plan_changed",
    details: { plan: planName, cycle, outcome: "updated_from_next_cycle" },
  });

  return { changed: true, note: `Auto-pay moves to ${planName} from the next cycle.` };
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

  // Every write is checked: a failure throws SettleError, so the webhook
  // answers 500 and Razorpay delivers the event again (each step is safe to
  // repeat; a charge already recorded is recognised by its payment id).
  const { SettleError } = await import("@/lib/billing.server");
  const must = (what: string, error: { message: string } | null) => {
    if (error) throw new SettleError(`subscription ${what} failed: ${error.message}`);
  };
  const { data: row, error: rowError } = await supabase
    .from("subscriptions")
    .select("id, organization_id, plan_version_id, billing_cycle, billing_account_id, raw")
    .eq("provider_subscription_id", providerId)
    .maybeSingle();
  must("read", rowError);
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
    const { error } = await supabase
      .from("organizations")
      .update({ plan_status: "active", trial_ends_at: null })
      .eq("id", orgId);
    must("plan status", error);
    await unpauseForPayment(supabase, orgId);
  } else if (kind === "charged") {
    patch["status"] = "active";
    const { error } = await supabase.from("organizations").update({ plan_status: "active" }).eq("id", orgId);
    must("plan status", error);
    await unpauseForPayment(supabase, orgId);
    await recordPlanCharge(supabase, {
      organizationId: orgId,
      subscription: row as Record<string, unknown>,
      provider: "razorpay",
      providerPaymentId: (payment?.["id"] as string | null) ?? null,
      gross: round2(Number(payment?.["amount"] ?? 0) / 100),
      periodStart: iso(subscription["current_start"]) ?? new Date().toISOString(),
      periodEnd: iso(subscription["current_end"]) ?? new Date().toISOString(),
      raw,
    });
  } else if (kind === "halted" || kind === "pending") {
    patch["status"] = kind;
    const { error } = await supabase.from("organizations").update({ plan_status: "past_due" }).eq("id", orgId);
    must("plan status", error);
    const { notify } = await import("@/lib/billing.server");
    await notify(supabase, {
      organizationId: orgId,
      audience: "client",
      kind: "payment_failed",
      payload: { reason: kind },
    });
  } else if (kind === "cancelled" || kind === "completed") {
    patch["status"] = kind;
    const { error } = await supabase.from("organizations").update({ plan_status: "cancelled" }).eq("id", orgId);
    must("plan status", error);
  } else if (kind === "paused") {
    patch["status"] = "paused";
  }

  const { error: patchError } = await supabase.from("subscriptions").update(patch).eq("id", row["id"] as string);
  must("update", patchError);
}

async function unpauseForPayment(supabase: SupabaseClient, organizationId: string): Promise<void> {
  const { restoreAfterPayment } = await import("@/lib/dunning.server");
  try {
    await restoreAfterPayment(supabase, organizationId);
  } catch (error) {
    const { SettleError } = await import("@/lib/billing.server");
    throw new SettleError(`dunning restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A successful mandate charge: one payment row, one numbered tax invoice.
 * The mandate charges the plan fee only — usage is never added on to it; it
 * is debited from prepaid credits and only stated on the invoice.
 */
async function recordPlanCharge(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    subscription: Record<string, unknown>;
    provider: "razorpay" | "cashfree";
    providerPaymentId: string | null;
    /** Rupees incl. GST, what the mandate collected. */
    gross: number;
    periodStart: string;
    periodEnd: string;
    raw: Record<string, unknown>;
  },
): Promise<void> {
  const providerPaymentId = input.providerPaymentId;
  const { SettleError } = await import("@/lib/billing.server");
  if (providerPaymentId) {
    const { data: seen, error: seenError } = await supabase
      .from("payments")
      .select("id")
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle();
    if (seenError) throw new SettleError(`plan charge read failed: ${seenError.message}`);
    if (seen) return; // replay
  }

  const gross = input.gross;
  const periodStart = input.periodStart;
  const periodEnd = input.periodEnd;

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
  // The mandate charges GST-inclusive while the platform is GST-registered;
  // the invoice states the base. Not registered (Batch 55), what it collected
  // is the base.
  const registered = (await loadGstRegistered(supabase)) !== false;
  const base =
    listed === null || listed === undefined
      ? round2(registered ? gross / 1.18 : gross)
      : round2(Number(listed));

  const { data: paymentRow, error: paymentError } = await supabase
    .from("payments")
    .insert({
      organization_id: input.organizationId,
      billing_account_id: (input.subscription["billing_account_id"] as string | null) ?? null,
      provider: input.provider,
      provider_payment_id: providerPaymentId,
      purpose: "plan_fee",
      // Same convention as credit purchases: the payment carries the ex-GST
      // amount, with the tax and what was actually collected alongside it.
      amount: base,
      currency: "INR",
      method: "mandate",
      status: "paid",
      paid_at: new Date().toISOString(),
      raw: { ...input.raw, gst_amount: round2(gross - base), gross_amount: gross },
    })
    .select("id")
    .maybeSingle();
  // A Cashfree charge a racing delivery already recorded (the
  // payments_cashfree_payment_once index, 2026110x) is a replay.
  if (paymentError?.code === "23505" && input.provider === "cashfree") return;
  // Nothing recorded yet: the retry records it. (Past this point the charge
  // is on file; a missing invoice is raised by the nightly backfill.)
  if (paymentError) throw new SettleError(`plan charge not recorded: ${paymentError.message}`);

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
  await issueInvoice(supabase, built.invoice_id, { deliver: true });
  await markPaid(supabase, built.invoice_id, (paymentRow?.["id"] as string | null) ?? null, gross);
}

// ------------------------------------------------------- Cashfree auto-pay

/**
 * A Cashfree Subscriptions mandate (only with CASHFREE_SUBSCRIPTIONS_ENABLED):
 * a PERIODIC plan that charges the GST-inclusive fee each period, with the
 * same ceiling rule as the Razorpay mandate (mandate_max_amount = the fee).
 */
async function setupCashfreeAutoPay(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string; cycle: "monthly" | "annual" },
): Promise<
  | { checkout: { subscription_session_id: string; mode: "sandbox" | "production" } }
  | { error: string }
> {
  const { cashfreeConfig, createSubscription, cashfreePhone } =
    await import("@/lib/cashfree.server");
  const { PAYMENTS_NOT_CONFIGURED } = await import("@/lib/razorpay.server");
  const config = cashfreeConfig();
  if (!config) return { error: PAYMENTS_NOT_CONFIGURED };

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, billing_account_id, plan_version_id, plan_status, trial_ends_at")
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
  const planName =
    ((version["plans"] as unknown as Record<string, unknown>)?.["name"] as string) ?? "plan";
  const priced = await priceNow(supabase, Number(base));
  if ("error" in priced) return priced;
  const gross = round2(priced.total);

  const { orderCustomer } = await import("@/lib/cashfree-billing.server");
  const { data: account } = org?.["billing_account_id"]
    ? await supabase
        .from("billing_accounts")
        .select("billing_email, billing_whatsapp")
        .eq("id", org["billing_account_id"] as string)
        .maybeSingle()
    : { data: null };
  const customer = await orderCustomer(supabase, input.organizationId, {
    name: (org?.["name"] as string | null) ?? null,
    email: (account?.["billing_email"] as string | null) ?? null,
    phone: (account?.["billing_whatsapp"] as string | null) ?? null,
  });
  if ("error" in customer) return customer;
  if (!customer.email)
    return { error: "Add a billing email first — the auto-pay mandate needs one." };

  const startAt = firstChargeAt(
    (org ?? {}) as { plan_status?: string | null; trial_ends_at?: string | null },
  );
  const subscriptionId = `sub_${crypto.randomUUID().replace(/-/g, "")}`;
  const { APP_PUBLIC_URL } = await import("@/lib/app-url");
  const created = await createSubscription(config, {
    subscriptionId,
    customer: {
      phone: cashfreePhone(customer.phone) ?? customer.phone,
      email: customer.email,
      name: customer.name,
    },
    planName: `AiDwar ${planName} ${input.cycle}`,
    amount: gross,
    maxAmount: gross,
    intervalType: input.cycle === "annual" ? "YEAR" : "MONTH",
    firstChargeAt: startAt ? new Date(startAt * 1000) : null,
    returnUrl: `${APP_PUBLIC_URL}/app/billing?autopay=1`,
    tags: { organization_id: input.organizationId },
  });
  const sessionId =
    typeof created.body["subscription_session_id"] === "string"
      ? (created.body["subscription_session_id"] as string)
      : "";
  if (!created.ok || !sessionId) return { error: created.error ?? "We couldn't set up auto-pay." };

  const { error: insertError } = await supabase.from("subscriptions").insert({
    organization_id: input.organizationId,
    billing_account_id: (org?.["billing_account_id"] as string | null) ?? null,
    plan_version_id: planVersionId,
    billing_cycle: input.cycle,
    provider: "cashfree",
    provider_subscription_id: subscriptionId,
    provider_plan_id:
      (((created.body["plan_details"] ?? {}) as Record<string, unknown>)["plan_id"] as
        string | null) ?? null,
    status: "created",
    mandate_max_amount: gross,
    raw: {
      cf_subscription_id: created.body["cf_subscription_id"] ?? null,
      subscription_status: created.body["subscription_status"] ?? null,
      subscription_session_id: sessionId,
      cashfree_env: config.env,
      ...(startAt ? { start_at: startAt } : {}),
    },
  });
  if (insertError) return { error: "We couldn't save the auto-pay mandate. Please try again." };

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    action: "autopay_setup",
    details: {
      cycle: input.cycle,
      plan: planName,
      gateway: "cashfree",
      ...(startAt ? { first_charge_at: new Date(startAt * 1000).toISOString() } : {}),
    },
  });
  return { checkout: { subscription_session_id: sessionId, mode: config.env } };
}

/** Cashfree subscription states in the vocabulary the subscriptions table already uses. */
export function cashfreeSubscriptionStatus(value: unknown): string | null {
  switch (String(value ?? "").toUpperCase()) {
    case "INITIALIZED":
    case "BANK_APPROVAL_PENDING":
      return "created";
    case "ACTIVE":
      return "active";
    case "ON_HOLD":
      return "halted";
    case "PAUSED":
    case "CUSTOMER_PAUSED":
      return "paused";
    case "CANCELLED":
    case "CUSTOMER_CANCELLED":
    case "LINK_EXPIRED":
      return "cancelled";
    case "COMPLETED":
    case "EXPIRED":
      return "completed";
    default:
      return null;
  }
}

function addPeriod(startIso: string, cycle: string): string {
  const end = new Date(startIso);
  if (cycle === "annual") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end.toISOString();
}

/**
 * Applies a SUBSCRIPTION_* Cashfree event, with the same effects on the
 * workspace as the Razorpay subscription.* events. Safe to replay; a write
 * that fails throws SettleError so Cashfree delivers it again.
 */
export async function applyCashfreeSubscriptionEvent(
  supabase: SupabaseClient,
  type: string,
  data: Record<string, unknown>,
  raw: Record<string, unknown>,
): Promise<void> {
  const details = (data["subscription_details"] ?? {}) as Record<string, unknown>;
  const subscriptionId = String(data["subscription_id"] ?? details["subscription_id"] ?? "");
  if (!subscriptionId) return;

  const { SettleError, notify } = await import("@/lib/billing.server");
  const must = (what: string, error: { message: string } | null) => {
    if (error) throw new SettleError(`subscription ${what} failed: ${error.message}`);
  };
  const { data: row, error: rowError } = await supabase
    .from("subscriptions")
    .select(
      "id, organization_id, plan_version_id, billing_cycle, billing_account_id, cancel_at_period_end, current_period_end, raw",
    )
    .eq("provider", "cashfree")
    .eq("provider_subscription_id", subscriptionId)
    .maybeSingle();
  must("read", rowError);
  if (!row) return;

  const orgId = String(row["organization_id"]);
  const existingRaw = (row["raw"] ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {
    raw: { ...existingRaw, last_event: type, entity: data },
    updated_at: new Date().toISOString(),
  };
  if (details["next_schedule_date"])
    patch["next_charge_at"] = String(details["next_schedule_date"]);

  const activate = async (status: "active" | "authenticated") => {
    patch["status"] = status;
    const { error } = await supabase
      .from("organizations")
      .update({ plan_status: "active", trial_ends_at: null })
      .eq("id", orgId);
    must("plan status", error);
    await unpauseForPayment(supabase, orgId);
  };
  const paymentType = String(data["payment_type"] ?? "").toUpperCase();
  const paymentStatus = String(data["payment_status"] ?? "").toUpperCase();

  if (type === "SUBSCRIPTION_STATUS_CHANGED") {
    const status = cashfreeSubscriptionStatus(details["subscription_status"]);
    if (status === "active") await activate("active");
    else if (status === "halted") {
      patch["status"] = "halted";
      const { error } = await supabase
        .from("organizations")
        .update({ plan_status: "past_due" })
        .eq("id", orgId);
      must("plan status", error);
      await notify(supabase, {
        organizationId: orgId,
        audience: "client",
        kind: "payment_failed",
        payload: { reason: "halted" },
      });
    } else if (status === "cancelled" || status === "completed") {
      patch["status"] = status;
      // A cancel we asked for (merchant turned auto-pay off, or the plan
      // changed) keeps the paid period; the next one is invoiced with a link.
      if (row["cancel_at_period_end"] !== true) {
        const { error } = await supabase
          .from("organizations")
          .update({ plan_status: "cancelled" })
          .eq("id", orgId);
        must("plan status", error);
      }
    } else if (status) {
      patch["status"] = status;
    }
  } else if (
    type === "SUBSCRIPTION_AUTH_STATUS" ||
    (type === "SUBSCRIPTION_PAYMENT_SUCCESS" && paymentType === "AUTH")
  ) {
    if (paymentStatus === "SUCCESS") await activate("authenticated");
  } else if (type === "SUBSCRIPTION_PAYMENT_SUCCESS") {
    await activate("active");
    const cycle = String(row["billing_cycle"] ?? "monthly");
    const scheduled = String(data["payment_schedule_date"] ?? data["payment_initiated_date"] ?? "");
    const periodStart = Number.isFinite(Date.parse(scheduled))
      ? new Date(scheduled).toISOString()
      : new Date().toISOString();
    const periodEnd = addPeriod(periodStart, cycle);
    patch["current_period_start"] = periodStart;
    patch["current_period_end"] = periodEnd;
    await recordPlanCharge(supabase, {
      organizationId: orgId,
      subscription: row as Record<string, unknown>,
      provider: "cashfree",
      providerPaymentId:
        data["cf_payment_id"] !== undefined && data["cf_payment_id"] !== null
          ? String(data["cf_payment_id"])
          : null,
      gross: round2(Number(data["payment_amount"] ?? 0)),
      periodStart,
      periodEnd,
      raw,
    });
  } else if (type === "SUBSCRIPTION_PAYMENT_FAILED") {
    if (paymentType !== "AUTH") {
      patch["status"] = "pending";
      const { error } = await supabase
        .from("organizations")
        .update({ plan_status: "past_due" })
        .eq("id", orgId);
      must("plan status", error);
      await notify(supabase, {
        organizationId: orgId,
        audience: "client",
        kind: "payment_failed",
        payload: { reason: "pending" },
      });
    }
  }
  // SUBSCRIPTION_PAYMENT_CANCELLED, _REFUND_STATUS and the reminders are recorded only.

  const { error: patchError } = await supabase
    .from("subscriptions")
    .update(patch)
    .eq("id", row["id"] as string);
  must("update", patchError);
}
