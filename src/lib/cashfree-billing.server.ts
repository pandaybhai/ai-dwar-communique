import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PUBLIC_URL } from "@/lib/app-url";
import {
  cashfreeConfig,
  cashfreeCustomerId,
  cashfreePhone,
  createOrder,
  failureReason,
  getOrder,
  getOrderPayments,
  settleFactsFrom,
  successfulPayment,
  type CashfreeConfig,
} from "@/lib/cashfree.server";

/**
 * AiDwar billing on Cashfree: the glue between our payments rows and the
 * Cashfree PG API. There is no second payments table and no second ledger
 * path — a paid Cashfree order settles through billing.server.ts settlePayment,
 * exactly like a Razorpay one, so the wallet credit, the plan activation and
 * the GST invoice are the same code with the same once-only guards.
 *
 * One payments row is one Cashfree order: order_id = payments.id.
 */

export type PaymentGateway = "cashfree" | "razorpay";

/** The workspace flag that moves a workspace's NEW payments to Cashfree (default off). */
export const CASHFREE_BILLING_FLAG = "cashfree_billing";

/**
 * Which gateway takes this workspace's NEW payments: Cashfree only when the
 * cashfree_billing flag is on for it (feature_flags default + its
 * organization_feature_overrides row, read by org_flag_enabled like every
 * other flag). Flag off, flag row missing or a failed read = Razorpay,
 * exactly as before. Existing rows always settle on the gateway they were
 * made on.
 */
export async function paymentGateway(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PaymentGateway> {
  try {
    const { data, error } = await supabase.rpc("org_flag_enabled", {
      p_org: organizationId,
      p_flag: CASHFREE_BILLING_FLAG,
    });
    if (error) return "razorpay";
    return data === true ? "cashfree" : "razorpay";
  } catch {
    return "razorpay";
  }
}

/** Where Cashfree sends a server-to-server notification for an order. */
export const CASHFREE_WEBHOOK_URL = `${APP_PUBLIC_URL}/api/public/cashfree-webhook`;

/** The public pay page for one payment (invoice links, "Finish payment"). */
export function payPageUrl(paymentId: string): string {
  return `${APP_PUBLIC_URL}/pay/${paymentId}`;
}

export type CheckoutSession = {
  payment_session_id: string;
  mode: "sandbox" | "production";
};

export type OrderCustomer = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string;
};

/**
 * The person paying: the workspace owner (profile name, email, phone), with
 * the billing account filling what the profile lacks. Cashfree needs a phone.
 */
export async function orderCustomer(
  supabase: SupabaseClient,
  organizationId: string,
  fallback: { name?: string | null; email?: string | null; phone?: string | null } = {},
): Promise<OrderCustomer | { error: string }> {
  const { data: owners } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1);
  const ownerId = (owners as { user_id: string }[] | null)?.[0]?.user_id ?? null;
  const { data: profile } = ownerId
    ? await supabase
        .from("profiles")
        .select("full_name, email, phone")
        .eq("id", ownerId)
        .maybeSingle()
    : { data: null };
  const p = (profile ?? {}) as Record<string, unknown>;
  const phone =
    cashfreePhone((p["phone"] as string | null) ?? null) ?? cashfreePhone(fallback.phone ?? null);
  if (!phone) {
    return {
      error:
        "Add a mobile number to your billing details (the billing WhatsApp number works) — the payment page needs one.",
    };
  }
  return {
    id: cashfreeCustomerId(organizationId),
    name: ((p["full_name"] as string | null) ?? fallback.name ?? null) || null,
    email: ((p["email"] as string | null) ?? fallback.email ?? null) || null,
    phone,
  };
}

/**
 * Creates the Cashfree order for a payments row we just inserted (status
 * 'created') and moves it to 'pending' with the session on it. On a refusal
 * the row is failed with the reason, exactly like a Razorpay link that
 * couldn't be made.
 */
export async function startCashfreeOrder(
  supabase: SupabaseClient,
  config: CashfreeConfig,
  input: {
    paymentId: string;
    /** Rupees incl. GST. */
    gross: number;
    currency: string;
    customer: OrderCustomer;
    note: string;
    /** Where the customer lands after paying (we confirm with GET order there). */
    returnUrl: string;
    /** The figures settlement runs on; merged, never replaced. */
    raw: Record<string, unknown>;
    tags?: Record<string, string>;
    expiresAt?: Date;
  },
): Promise<{ checkout: CheckoutSession; url: string } | { error: string }> {
  const order = await createOrder(config, {
    orderId: input.paymentId,
    amount: input.gross,
    currency: input.currency,
    customer: {
      id: input.customer.id,
      phone: input.customer.phone,
      name: input.customer.name,
      email: input.customer.email,
    },
    returnUrl: input.returnUrl,
    notifyUrl: CASHFREE_WEBHOOK_URL,
    note: input.note,
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  const sessionId =
    typeof order.body["payment_session_id"] === "string"
      ? (order.body["payment_session_id"] as string)
      : "";
  if (!order.ok || !sessionId) {
    const error = order.error ?? "We couldn't start the payment. Please try again.";
    await supabase
      .from("payments")
      .update({ status: "failed", raw: { ...input.raw, error } })
      .eq("id", input.paymentId);
    return { error };
  }
  const cfOrderId = order.body["cf_order_id"];
  await supabase
    .from("payments")
    .update({
      status: "pending",
      ...(cfOrderId !== undefined && cfOrderId !== null
        ? { provider_order_id: String(cfOrderId) }
        : {}),
      raw: {
        ...input.raw,
        ...(input.expiresAt ? { expires_at: input.expiresAt.toISOString() } : {}),
        cashfree: {
          env: config.env,
          order_id: input.paymentId,
          cf_order_id: cfOrderId ?? null,
          payment_session_id: sessionId,
          order_status: order.body["order_status"] ?? null,
          order_expiry_time: order.body["order_expiry_time"] ?? null,
        },
        // The pay page doubles as the "link" older screens show.
        link: { short_url: payPageUrl(input.paymentId) },
      },
    })
    .eq("id", input.paymentId);
  return {
    checkout: { payment_session_id: sessionId, mode: config.env },
    url: payPageUrl(input.paymentId),
  };
}

// ------------------------------------------------------------ confirmation

export type ConfirmResult = { status: "paid" | "pending" | "failed" | "unknown"; reason?: string };

/** A GET order more often than this for the same payment is answered from what we have. */
const CONFIRM_MIN_GAP_MS = 2_500;
/** Per instance; kept off the row so a check never rewrites raw while a settle holds it. */
const lastConfirm = new Map<string, number>();

export function resetConfirmThrottle(): void {
  lastConfirm.clear();
}

/**
 * Our server asks Cashfree whether the order is paid — the redirect back
 * from the checkout is never trusted on its own. A PAID order settles
 * through settlePayment (once, whoever gets there first: this or the webhook).
 */
export async function confirmCashfreePayment(
  supabase: SupabaseClient,
  paymentId: string,
  options: { config?: CashfreeConfig | null; now?: number } = {},
): Promise<ConfirmResult> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, provider, status, raw")
    .eq("id", paymentId)
    .maybeSingle();
  const row = (payment ?? null) as Record<string, unknown> | null;
  if (!row) return { status: "unknown" };
  if (row["status"] === "paid") return { status: "paid" };
  if (row["provider"] !== "cashfree") return { status: "unknown" };

  const now = options.now ?? Date.now();
  const lastChecked = lastConfirm.get(paymentId);
  if (lastChecked !== undefined && now - lastChecked < CONFIRM_MIN_GAP_MS) {
    return { status: row["status"] === "failed" ? "failed" : "pending" };
  }

  const config = options.config === undefined ? cashfreeConfig() : options.config;
  if (!config) return { status: "unknown" };
  lastConfirm.set(paymentId, now);
  if (lastConfirm.size > 5_000) lastConfirm.clear();

  const order = await getOrder(config, paymentId);
  if (!order.ok) return { status: "unknown" };
  const orderStatus = String(order.body["order_status"] ?? "").toUpperCase();

  const payments = await getOrderPayments(config, paymentId);
  const list = payments.ok ? (payments.list ?? []) : [];
  const success = successfulPayment(list);

  if (orderStatus === "PAID" || success) {
    if (!success) return { status: "pending" };
    const { settlePayment } = await import("@/lib/billing.server");
    await settlePayment(
      supabase,
      paymentId,
      String(success["cf_payment_id"] ?? "") || null,
      { provider: "cashfree", source: "get_order", order: order.body, payment: success },
      settleFactsFrom(success, null),
    );
    const { data: after } = await supabase
      .from("payments")
      .select("status")
      .eq("id", paymentId)
      .maybeSingle();
    return {
      status: (after as { status?: string } | null)?.status === "paid" ? "paid" : "pending",
    };
  }

  // An ACTIVE order can still be paid (a failed try can be retried in the
  // same checkout); only an order Cashfree closed fails the payment.
  if (orderStatus === "EXPIRED" || orderStatus === "TERMINATED") {
    const reason = `order ${orderStatus.toLowerCase()}`;
    await markCashfreeFailed(supabase, paymentId, reason, { order_status: orderStatus });
    return { status: "failed", reason };
  }
  if (row["status"] === "failed") return { status: "failed" };
  return { status: "pending" };
}

/**
 * A payment that didn't go through: failed with the reason, never credited.
 * Only an unpaid row moves — a later success on the same order still settles
 * (settlePayment never refuses money that was actually taken).
 */
export async function markCashfreeFailed(
  supabase: SupabaseClient,
  paymentId: string,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { data: payment, error: readError } = await supabase
    .from("payments")
    .select("id, status, raw")
    .eq("id", paymentId)
    .maybeSingle();
  if (readError) {
    const { SettleError } = await import("@/lib/billing.server");
    throw new SettleError(`payment read failed: ${readError.message}`);
  }
  const row = (payment ?? null) as Record<string, unknown> | null;
  if (!row || row["status"] === "paid") return;
  const raw = (row["raw"] ?? {}) as Record<string, unknown>;
  const { error } = await supabase
    .from("payments")
    .update({
      status: "failed",
      raw: { ...raw, failure: { reason, ...detail, at: new Date().toISOString() } },
    })
    .eq("id", paymentId)
    .in("status", ["created", "pending", "failed"]);
  if (error) {
    const { SettleError } = await import("@/lib/billing.server");
    throw new SettleError(`payment failure not recorded: ${error.message}`);
  }
}

// ----------------------------------------------------------------- webhook

type AnyRecord = Record<string, unknown>;

/**
 * The id one delivery is recorded under in webhook_events: the event type and
 * the Cashfree payment (or refund / subscription) it is about. A redelivery
 * of the same event lands on the same row; a success after a failed try on
 * the same order is a different payment, so a different row.
 */
export function cashfreeEventKey(body: AnyRecord): string | null {
  const type = String(body["type"] ?? "");
  const data = (body["data"] ?? {}) as AnyRecord;
  if (!type) return null;
  const payment = (data["payment"] ?? {}) as AnyRecord;
  const refund = (data["refund"] ?? {}) as AnyRecord;
  const subscription = (data["subscription_details"] ?? {}) as AnyRecord;
  const id =
    payment["cf_payment_id"] ??
    (refund["cf_refund_id"] !== undefined
      ? `${String(refund["cf_refund_id"])}:${String(refund["refund_status"] ?? "")}`
      : undefined) ??
    data["cf_payment_id"] ??
    (subscription["cf_subscription_id"] !== undefined ||
    subscription["subscription_id"] !== undefined
      ? `${String(subscription["subscription_id"] ?? subscription["cf_subscription_id"])}:${String(subscription["subscription_status"] ?? "")}:${String(body["event_time"] ?? "")}`
      : undefined);
  if (id === undefined || id === null || String(id) === "") return null;
  return `${type}:${String(id)}`;
}

/** Our order ids are payments.id (a uuid); anything else was not made by AiDwar billing. */
export const OUR_ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One verified Cashfree event, applied. Safe to replay; a failure that must be retried throws SettleError. */
export async function handleCashfreeEvent(
  supabase: SupabaseClient,
  body: AnyRecord,
): Promise<void> {
  const type = String(body["type"] ?? "");
  const data = (body["data"] ?? {}) as AnyRecord;
  const order = (data["order"] ?? {}) as AnyRecord;
  const payment = (data["payment"] ?? {}) as AnyRecord;
  // An order made elsewhere on the account (a dashboard payment link) is
  // recorded with the event and left alone — never looked up against a uuid.
  const orderId =
    typeof order["order_id"] === "string" && OUR_ORDER_ID.test(order["order_id"] as string)
      ? (order["order_id"] as string)
      : null;

  if (type === "PAYMENT_SUCCESS_WEBHOOK") {
    if (!orderId) return;
    const { settlePayment } = await import("@/lib/billing.server");
    await settlePayment(
      supabase,
      orderId,
      payment["cf_payment_id"] !== undefined ? String(payment["cf_payment_id"]) : null,
      body,
      settleFactsFrom(payment, null),
    );
    return;
  }

  if (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
    if (!orderId) return;
    const fallback =
      type === "PAYMENT_USER_DROPPED_WEBHOOK" ? "customer left the checkout" : "payment failed";
    await markCashfreeFailed(
      supabase,
      orderId,
      failureReason(
        { ...payment, error_details: data["error_details"] ?? payment["error_details"] },
        fallback,
      ),
      {
        event: type,
        cf_payment_id: payment["cf_payment_id"] ?? null,
        payment_status: payment["payment_status"] ?? null,
      },
    );
    return;
  }

  if (type === "REFUND_STATUS_WEBHOOK") {
    const { recordRefundStatus } = await import("@/lib/cashfree-refunds.server");
    await recordRefundStatus(supabase, (data["refund"] ?? {}) as AnyRecord);
    return;
  }

  if (type.startsWith("SUBSCRIPTION_")) {
    const { applyCashfreeSubscriptionEvent } = await import("@/lib/subscriptions.server");
    await applyCashfreeSubscriptionEvent(supabase, type, data, body);
  }
}
