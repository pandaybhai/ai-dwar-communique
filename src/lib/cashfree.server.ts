import { outsideFetch } from "@/lib/outside-call.server";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cashfree Payments (PG API) — how AiDwar charges its own merchants: plan
 * fees, credit top-ups and, behind CASHFREE_SUBSCRIPTIONS_ENABLED, auto-pay.
 *
 * Keys come from the environment only (CASHFREE_CLIENT_ID /
 * CASHFREE_CLIENT_SECRET; CASHFREE_ENV picks sandbox or production;
 * CASHFREE_WEBHOOK_SECRET optional). Nothing secret ever reaches a browser:
 * the client gets a payment_session_id and the mode, nothing else.
 *
 * New payments go through here only for a workspace with the cashfree_billing
 * flag on (cashfree-billing.server.ts paymentGateway); everyone else stays on
 * the Razorpay path exactly as before.
 *
 * Not the merchant "Razorpay flow connection": merchants still use their own
 * Razorpay inside flows (flow-connections.server.ts), untouched by this file.
 */

/** Pinned: request and webhook shapes below follow this version. */
export const CASHFREE_API_VERSION = "2025-01-01";

export type CashfreeEnv = "sandbox" | "production";

export type CashfreeConfig = {
  env: CashfreeEnv;
  clientId: string;
  clientSecret: string;
  /**
   * Keys a webhook signature may be made with: the client secret (Cashfree PG
   * signs with it), and CASHFREE_WEBHOOK_SECRET when set and different.
   */
  webhookSecrets: string[];
  baseUrl: string;
};

export const CASHFREE_BASE_URL: Record<CashfreeEnv, string> = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};

type Env = Record<string, string | undefined>;

/** The configured account, or null when the keys aren't set (payments then say so plainly). */
export function cashfreeConfig(env: Env = process.env): CashfreeConfig | null {
  const clientId = (env["CASHFREE_CLIENT_ID"] ?? "").trim();
  const clientSecret = (env["CASHFREE_CLIENT_SECRET"] ?? "").trim();
  if (!clientId || !clientSecret) return null;
  // Anything but an explicit "production" is the sandbox: a typo never moves real money.
  const mode: CashfreeEnv =
    (env["CASHFREE_ENV"] ?? "").trim().toLowerCase() === "production" ? "production" : "sandbox";
  const webhookSecret = (env["CASHFREE_WEBHOOK_SECRET"] ?? "").trim();
  const webhookSecrets =
    webhookSecret && webhookSecret !== clientSecret
      ? [clientSecret, webhookSecret]
      : [clientSecret];
  return { env: mode, clientId, clientSecret, webhookSecrets, baseUrl: CASHFREE_BASE_URL[mode] };
}

/** Cashfree Subscriptions is a separate product: auto-pay runs on it only when switched on. */
export function cashfreeSubscriptionsEnabled(env: Env = process.env): boolean {
  return (env["CASHFREE_SUBSCRIPTIONS_ENABLED"] ?? "").trim().toLowerCase() === "true";
}

export type CashfreeReply = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  list: Record<string, unknown>[] | null;
  error: string | null;
};

async function cf(
  config: CashfreeConfig,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<CashfreeReply> {
  let res: Response;
  try {
    res = await outsideFetch("cashfree", `${config.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-api-version": CASHFREE_API_VERSION,
        "x-client-id": config.clientId,
        "x-client-secret": config.clientSecret,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.idempotencyKey ? { "x-idempotency-key": init.idempotencyKey } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      body: {},
      list: null,
      error: "We couldn't reach the payment provider. Please try again.",
    };
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  const body = (!list && parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (!res.ok) {
    const message = typeof body["message"] === "string" ? (body["message"] as string) : "";
    return {
      ok: false,
      status: res.status,
      body,
      list,
      error: message
        ? `The payment provider refused this: ${message}`
        : "The payment provider couldn't complete that.",
    };
  }
  return { ok: true, status: res.status, body, list, error: null };
}

// ------------------------------------------------------------------ orders

export type CashfreeCustomer = {
  /** 3–50 letters/digits/underscores/hyphens. */
  id: string;
  phone: string;
  name?: string | null;
  email?: string | null;
};

/** Cashfree wants 10 digits for an Indian number, or "+<digits>" for anything else. */
export function cashfreePhone(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** A customer_id Cashfree accepts, derived from our own id. */
export function cashfreeCustomerId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  return cleaned.length >= 3 ? cleaned : `org_${cleaned}`.slice(0, 50);
}

export type CreateOrderInput = {
  /** Our payments.id — the order is ours, so one payment row is one order. */
  orderId: string;
  /** Rupees, GST included: what the customer pays. */
  amount: number;
  currency: string;
  customer: CashfreeCustomer;
  returnUrl: string;
  notifyUrl: string;
  note?: string;
  tags?: Record<string, string>;
  expiresAt?: Date;
};

export async function createOrder(
  config: CashfreeConfig,
  input: CreateOrderInput,
): Promise<CashfreeReply> {
  const note = (input.note ?? "").trim();
  return cf(config, "/orders", {
    method: "POST",
    // A retried create (network drop after Cashfree took it) is the same order.
    idempotencyKey: input.orderId,
    body: {
      order_id: input.orderId,
      order_amount: Math.round(input.amount * 100) / 100,
      order_currency: input.currency,
      customer_details: {
        customer_id: input.customer.id,
        customer_phone: input.customer.phone,
        ...(input.customer.name && input.customer.name.trim().length >= 3
          ? { customer_name: input.customer.name.trim().slice(0, 100) }
          : {}),
        ...(input.customer.email ? { customer_email: input.customer.email.slice(0, 100) } : {}),
      },
      order_meta: {
        return_url: input.returnUrl.slice(0, 250),
        notify_url: input.notifyUrl.slice(0, 250),
      },
      ...(note.length >= 3 ? { order_note: note.slice(0, 200) } : {}),
      ...(input.tags ? { order_tags: input.tags } : {}),
      ...(input.expiresAt ? { order_expiry_time: input.expiresAt.toISOString() } : {}),
    },
  });
}

export async function getOrder(config: CashfreeConfig, orderId: string): Promise<CashfreeReply> {
  return cf(config, `/orders/${encodeURIComponent(orderId)}`);
}

export async function getOrderPayments(
  config: CashfreeConfig,
  orderId: string,
): Promise<CashfreeReply> {
  return cf(config, `/orders/${encodeURIComponent(orderId)}/payments`);
}

// ----------------------------------------------------------------- refunds

export async function createRefund(
  config: CashfreeConfig,
  orderId: string,
  input: { refundId: string; amount: number; note: string },
): Promise<CashfreeReply> {
  const note = input.note.trim();
  return cf(config, `/orders/${encodeURIComponent(orderId)}/refunds`, {
    method: "POST",
    idempotencyKey: input.refundId,
    body: {
      refund_id: input.refundId,
      refund_amount: Math.round(input.amount * 100) / 100,
      ...(note.length >= 3 ? { refund_note: note.slice(0, 100) } : {}),
    },
  });
}

// ----------------------------------------------------------- subscriptions

export type CreateSubscriptionInput = {
  /** Our own id for the mandate. */
  subscriptionId: string;
  customer: { phone: string; email: string; name?: string | null };
  planName: string;
  /** Rupees incl. GST, charged every period. */
  amount: number;
  /** The mandate's ceiling — subscriptions.mandate_max_amount. */
  maxAmount: number;
  intervalType: "MONTH" | "YEAR";
  /** First charge (a trial's end); absent = Cashfree's default schedule. */
  firstChargeAt?: Date | null;
  returnUrl: string;
  tags?: Record<string, string>;
};

export async function createSubscription(
  config: CashfreeConfig,
  input: CreateSubscriptionInput,
): Promise<CashfreeReply> {
  return cf(config, "/subscriptions", {
    method: "POST",
    idempotencyKey: input.subscriptionId,
    body: {
      subscription_id: input.subscriptionId,
      customer_details: {
        customer_phone: input.customer.phone,
        customer_email: input.customer.email,
        ...(input.customer.name ? { customer_name: input.customer.name.slice(0, 100) } : {}),
      },
      plan_details: {
        plan_name: input.planName.slice(0, 40),
        plan_type: "PERIODIC",
        plan_amount: Math.round(input.amount * 100) / 100,
        plan_max_amount: Math.round(input.maxAmount * 100) / 100,
        plan_interval_type: input.intervalType,
        plan_intervals: 1,
        plan_currency: "INR",
      },
      subscription_meta: { return_url: input.returnUrl.slice(0, 250) },
      ...(input.firstChargeAt
        ? { subscription_first_charge_time: input.firstChargeAt.toISOString() }
        : {}),
      ...(input.tags ? { subscription_tags: input.tags } : {}),
    },
  });
}

export async function getSubscription(
  config: CashfreeConfig,
  subscriptionId: string,
): Promise<CashfreeReply> {
  return cf(config, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/** Cancels a mandate at Cashfree. Nothing already charged is touched. */
export async function cancelSubscription(
  config: CashfreeConfig,
  subscriptionId: string,
): Promise<CashfreeReply> {
  return cf(config, `/subscriptions/${encodeURIComponent(subscriptionId)}/manage`, {
    method: "POST",
    body: { subscription_id: subscriptionId, action: "CANCEL" },
  });
}

// ----------------------------------------------------------------- webhook

/** A webhook older (or further in the future) than this is refused: a replayed capture. */
export const CASHFREE_WEBHOOK_MAX_AGE_MS = 5 * 60_000;

function sameSignature(expected: string, signature: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function cashfreeSignature(
  rawBody: string,
  timestamp: string,
  secret: string,
  separator = "",
): string {
  return createHmac("sha256", secret).update(`${timestamp}${separator}${rawBody}`).digest("base64");
}

/**
 * x-webhook-signature = base64(HMAC-SHA256(x-webhook-timestamp + raw body,
 * key)), compared in constant time over the raw body exactly as received.
 * Keys: CASHFREE_CLIENT_SECRET, and CASHFREE_WEBHOOK_SECRET when set and
 * different — a match with either is accepted. Cashfree's pseudocode puts a
 * "." between timestamp and body while its Node/Python samples don't: the
 * no-separator form is the primary one, the "." form is also accepted.
 */
export function verifyCashfreeSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secrets: string | readonly string[],
): boolean {
  return matchCashfreeSignature(rawBody, timestamp, signature, secrets) !== null;
}

export type SignatureMatch = {
  /** Which key signed it: CASHFREE_CLIENT_SECRET or CASHFREE_WEBHOOK_SECRET. */
  key: "client_secret" | "webhook_secret";
  /** "plain" = timestamp + body (the primary form), "dot" = timestamp + "." + body. */
  form: "plain" | "dot";
};

/** Which key and form a valid signature matched (never the key itself), or null. */
export function matchCashfreeSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secrets: string | readonly string[],
): SignatureMatch | null {
  const keys = (typeof secrets === "string" ? [secrets] : [...secrets]).filter((k) => k.length > 0);
  if (!rawBody || !timestamp || !signature || keys.length === 0) return null;
  let match: SignatureMatch | null = null;
  // Every candidate is computed (no early exit on a match).
  keys.forEach((key, index) => {
    for (const [separator, form] of [
      ["", "plain"],
      [".", "dot"],
    ] as const) {
      if (
        sameSignature(cashfreeSignature(rawBody, timestamp, key, separator), signature) &&
        !match
      ) {
        match = { key: index === 0 ? "client_secret" : "webhook_secret", form };
      }
    }
  });
  return match;
}

/** The timestamp header is milliseconds; a 10-digit value is read as seconds. */
export function webhookTimestampFresh(
  timestamp: string,
  now: number = Date.now(),
  maxAgeMs: number = CASHFREE_WEBHOOK_MAX_AGE_MS,
): boolean {
  if (!/^\d{9,14}$/.test(timestamp.trim())) return false;
  const value = Number(timestamp);
  const ms = value < 1e12 ? value * 1000 : value;
  return Math.abs(now - ms) <= maxAgeMs;
}

// ------------------------------------------------------- reading payments

export type CashfreePayment = Record<string, unknown>;

/** The successful payment on an order, if any (an order is paid by at most one). */
export function successfulPayment(
  payments: CashfreePayment[] | null | undefined,
): CashfreePayment | null {
  return (
    (payments ?? []).find((p) => String(p["payment_status"] ?? "").toUpperCase() === "SUCCESS") ??
    null
  );
}

/** What settlePayment needs to know about a payment, from Cashfree's own record of it. */
export type SettleFacts = {
  paise: number | null;
  /** "captured" for a SUCCESS payment — the word settlePayment's amount check expects. */
  status: string | null;
  currency: string | null;
  method: string | null;
  methodDetail: string | null;
  orderId: string | null;
};

export function settleFactsFrom(payment: CashfreePayment, orderId: string | null): SettleFacts {
  const amount = Number(payment["payment_amount"] ?? Number.NaN);
  const status = String(payment["payment_status"] ?? "").toUpperCase();
  const methods = (payment["payment_method"] ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const detail =
    (methods["upi"]?.["upi_id"] as string | undefined) ??
    (methods["app"]?.["provider"] as string | undefined) ??
    (methods["netbanking"]?.["netbanking_bank_name"] as string | undefined) ??
    (methods["card"]?.["card_network"] as string | undefined) ??
    null;
  return {
    paise: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null,
    status: status === "SUCCESS" ? "captured" : status ? status.toLowerCase() : null,
    currency: (payment["payment_currency"] as string | undefined) ?? null,
    method: (payment["payment_group"] as string | undefined) ?? null,
    methodDetail: detail,
    orderId,
  };
}

/** Why a payment didn't go through, in a line an admin can read. */
export function failureReason(payment: CashfreePayment, fallback: string): string {
  const details = (payment["error_details"] ?? {}) as Record<string, unknown>;
  const reason =
    (details["error_description"] as string | undefined) ??
    (details["error_reason"] as string | undefined) ??
    (payment["payment_message"] as string | undefined) ??
    "";
  return (reason || fallback).slice(0, 300);
}
