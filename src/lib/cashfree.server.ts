import { outsideFetch } from "@/lib/outside-call.server";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cashfree access (API v2026-01-01). Platform keys live in the Vault and are
 * read through public.read_vault_secret with the service client — the same
 * path the Razorpay and AI credentials use — with the CASHFREE_* environment
 * variables as a fallback. Only whether payments are configured may ever
 * reach a browser, never the keys.
 *
 * Cashfree replaces Razorpay behind the cashfree_billing flag: a workspace
 * with the flag on (and Cashfree keys present) pays through Cashfree; every
 * other workspace stays on Razorpay exactly as before.
 */

export type CashfreeKeys = {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "production";
};

const API_VERSION = "2026-01-01";

async function vault(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_name: name });
  if (error) return null;
  const value = typeof data === "string" ? data.trim() : "";
  return value.length > 0 ? value : null;
}

export async function cashfreeKeys(supabase: SupabaseClient): Promise<CashfreeKeys | null> {
  const [clientId, clientSecret, env] = await Promise.all([
    vault(supabase, "cashfree_client_id"),
    vault(supabase, "cashfree_client_secret"),
    vault(supabase, "cashfree_env"),
  ]);
  const id = clientId ?? process.env["CASHFREE_CLIENT_ID"] ?? "";
  const secret = clientSecret ?? process.env["CASHFREE_CLIENT_SECRET"] ?? "";
  if (!id || !secret) return null;
  const which = (env ?? process.env["CASHFREE_ENV"] ?? "sandbox").trim().toLowerCase();
  return { clientId: id, clientSecret: secret, env: which === "production" ? "production" : "sandbox" };
}

export async function cashfreeWebhookSecret(supabase: SupabaseClient): Promise<string | null> {
  return (await vault(supabase, "cashfree_webhook_secret")) ?? process.env["CASHFREE_WEBHOOK_SECRET"] ?? null;
}

/**
 * Which provider takes a workspace's NEW platform payments. Cashfree only
 * when the workspace's cashfree_billing flag is on and keys exist; anything
 * else (flag off, flag row missing, keys missing) stays on Razorpay.
 */
export async function platformPaymentProvider(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<"cashfree" | "razorpay"> {
  const { data } = await supabase.rpc("org_flag_enabled", {
    p_org: organizationId,
    p_flag: "cashfree_billing",
  });
  if (data !== true) return "razorpay";
  return (await cashfreeKeys(supabase)) ? "cashfree" : "razorpay";
}

function baseUrl(keys: CashfreeKeys): string {
  return keys.env === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
}

async function cf(
  keys: CashfreeKeys,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; body: Record<string, unknown>; error: string | null }> {
  let res: Response;
  try {
    res = await outsideFetch("cashfree", `${baseUrl(keys)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-client-id": keys.clientId,
        "x-client-secret": keys.clientSecret,
        "x-api-version": API_VERSION,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, body: {}, error: "We couldn't reach the payment provider." };
  }
  const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!res.ok) {
    const message = (body["message"] as string | undefined) ?? "";
    return {
      ok: false,
      body,
      error: message
        ? `The payment provider refused this: ${message}`
        : "The payment provider couldn't complete that.",
    };
  }
  return { ok: true, body, error: null };
}

// ------------------------------------------------------------ payment links

type PaymentLinkInput = {
  amount: number;
  currency: string;
  description: string;
  /** Our internal id for the payment — becomes Cashfree's link_id. */
  reference: string;
  customer: { name?: string | null; email?: string | null; contact?: string | null };
  /** Where the customer lands after paying; omitted for flow payment links. */
  callbackUrl?: string;
  /** Where Cashfree posts the paid event (link_meta.notify_url). */
  notifyUrl: string;
  notes: Record<string, string>;
  /** Unix seconds after which the link stops working. */
  expireBy?: number;
};

export type PaymentLink = { id: string; short_url: string; raw: Record<string, unknown> };

/** Creates a hosted payment link. Amount is rupees; Cashfree takes rupees. */
export async function createPaymentLink(
  keys: CashfreeKeys,
  input: PaymentLinkInput,
): Promise<{ link: PaymentLink | null; error: string | null }> {
  const phone = (input.customer.contact ?? "").replace(/\D/g, "");
  const result = await cf(keys, "/links", {
    method: "POST",
    body: {
      // Cashfree link_id: letters, numbers, - and _ only (our payment ids are UUIDs).
      link_id: input.reference.replace(/[^A-Za-z0-9_-]/g, ""),
      link_amount: Math.round(input.amount * 100) / 100,
      link_currency: input.currency,
      link_purpose: input.description.slice(0, 500),
      customer_details: {
        ...(input.customer.name ? { customer_name: input.customer.name } : {}),
        ...(input.customer.email ? { customer_email: input.customer.email } : {}),
        ...(phone ? { customer_phone: phone.slice(-10) } : {}),
      },
      link_notify: { send_sms: false, send_email: Boolean(input.customer.email) },
      link_auto_reminders: true,
      link_notes: input.notes,
      link_meta: {
        notify_url: input.notifyUrl,
        ...(input.callbackUrl ? { return_url: input.callbackUrl } : {}),
      },
      ...(input.expireBy
        ? { link_expiry_time: new Date(input.expireBy * 1000).toISOString() }
        : {}),
    },
  });
  if (!result.ok) return { link: null, error: result.error };
  const url = String(result.body["link_url"] ?? "");
  const id = String(result.body["cf_link_id"] ?? result.body["link_id"] ?? "");
  if (!url || !id) return { link: null, error: "The payment provider didn't return a payment link. Please try again." };
  return { link: { id, short_url: url, raw: result.body }, error: null };
}

// ------------------------------------------------------------ webhooks

/**
 * Cashfree signs `timestamp + rawBody` with HMAC-SHA256 and sends it base64
 * in x-webhook-signature. Constant-time compare.
 */
export function verifyWebhookSignature(
  timestamp: string,
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(`${timestamp}${rawBody}`, "utf8").digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ------------------------------------------------------------ subscriptions

/** A recurring plan at the provider. Amount is rupees INCLUDING GST. */
export async function createPlan(
  keys: CashfreeKeys,
  input: { period: "monthly" | "yearly"; amount: number; name: string; description?: string },
) {
  return cf(keys, "/plans", {
    method: "POST",
    body: {
      plan_name: input.name.slice(0, 100),
      type: "PERIODIC",
      amount: Math.round(input.amount * 100) / 100,
      interval_type: input.period === "yearly" ? "YEAR" : "MONTH",
      intervals: 1,
      description: (input.description ?? input.name).slice(0, 255),
    },
  });
}

/**
 * Creates a subscription mandate. The customer authorises it through the
 * auth link in the response. firstChargeAt (Unix seconds) keeps a trial's
 * remaining days, like Razorpay's start_at.
 */
export async function createSubscription(
  keys: CashfreeKeys,
  input: {
    planId: string;
    cycle: "monthly" | "annual";
    organizationId: string;
    customer: { name?: string | null; email?: string | null; contact?: string | null };
    returnUrl: string;
    firstChargeAt?: number | null;
  },
) {
  const phone = (input.customer.contact ?? "").replace(/\D/g, "");
  return cf(keys, "/subscriptions", {
    method: "POST",
    body: {
      plan_id: input.planId,
      customer_details: {
        ...(input.customer.name ? { customer_name: input.customer.name } : {}),
        ...(input.customer.email ? { customer_email: input.customer.email } : {}),
        ...(phone ? { customer_phone: phone.slice(-10) } : {}),
      },
      authorization_details: {
        authorization_amount: 1,
        payment_methods: ["upi", "card", "enach"],
      },
      subscription_meta: { return_url: input.returnUrl },
      subscription_note: `aidwar_org:${input.organizationId}`,
      ...(input.firstChargeAt
        ? { subscription_first_charge_date: new Date(input.firstChargeAt * 1000).toISOString().slice(0, 10) }
        : {}),
      subscription_expiry: new Date(
        Date.now() + (input.cycle === "annual" ? 10 : 10) * 365 * 864e5,
      )
        .toISOString()
        .slice(0, 10),
    },
  });
}

export async function cancelSubscription(keys: CashfreeKeys, subscriptionId: string) {
  // Cashfree cancels immediately; the period-end grace is ours to keep, so
  // the caller marks cancel_at_period_end and a sweep cancels at period end.
  return cf(keys, `/subscriptions/${encodeURIComponent(subscriptionId)}/manage`, {
    method: "POST",
    body: { action: "CANCEL", sub_reference_id: subscriptionId },
  });
}

export async function fetchSubscription(keys: CashfreeKeys, subscriptionId: string) {
  return cf(keys, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/**
 * Cashfree mandates can't be moved onto another plan: always reports failure
 * so the caller falls back to cancel-at-period-end + a fresh mandate.
 */
export async function updateSubscriptionPlan(
  _keys: CashfreeKeys,
  _subscriptionId: string,
  _planId: string,
) {
  return { ok: false, body: {}, error: "This provider can't move a mandate to another plan." };
}

/** A cheap authenticated read: 200 means the keys are good. */
export async function verifyCashfreeKeys(clientId: string, clientSecret: string, env: "sandbox" | "production"): Promise<boolean> {
  const keys: CashfreeKeys = { clientId, clientSecret, env };
  const result = await cf(keys, "/orders?limit=1");
  return result.ok;
}
