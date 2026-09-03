import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Razorpay access. Keys live in the Vault and are read through
 * public.read_vault_secret with the service client — the same path the AI
 * provider credentials use. Only the key id may ever reach a browser.
 */
export type RazorpayKeys = { keyId: string; keySecret: string };

async function vault(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_name: name });
  if (error) return null;
  const value = typeof data === "string" ? data.trim() : "";
  return value.length > 0 ? value : null;
}

export async function razorpayKeys(supabase: SupabaseClient): Promise<RazorpayKeys | null> {
  const [keyId, keySecret] = await Promise.all([
    vault(supabase, "razorpay_key_id"),
    vault(supabase, "razorpay_key_secret"),
  ]);
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export async function razorpayKeyId(supabase: SupabaseClient): Promise<string | null> {
  return vault(supabase, "razorpay_key_id");
}

export const PAYMENTS_NOT_CONFIGURED =
  "Online payments aren't switched on yet. Ask us to add the payment keys, or pay by bank transfer and we'll add the credits.";

type PaymentLinkInput = {
  amount: number;
  currency: string;
  description: string;
  reference: string;
  customer: { name?: string | null; email?: string | null; contact?: string | null };
  callbackUrl: string;
  notes: Record<string, string>;
};

export type PaymentLink = { id: string; short_url: string; raw: Record<string, unknown> };

/** Creates a hosted payment link. Amount is rupees; Razorpay wants paise. */
export async function createPaymentLink(
  keys: RazorpayKeys,
  input: PaymentLinkInput,
): Promise<{ link: PaymentLink | null; error: string | null }> {
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64");
  let res: Response;
  try {
    res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(input.amount * 100),
        currency: input.currency,
        description: input.description.slice(0, 2048),
        reference_id: input.reference,
        customer: {
          name: input.customer.name ?? undefined,
          email: input.customer.email ?? undefined,
          contact: input.customer.contact ?? undefined,
        },
        notify: { sms: false, email: Boolean(input.customer.email) },
        reminder_enable: true,
        callback_url: input.callbackUrl,
        callback_method: "get",
        notes: input.notes,
      }),
    });
  } catch {
    return { link: null, error: "We couldn't reach the payment provider. Please try again." };
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    const description =
      ((body?.["error"] as Record<string, unknown> | undefined)?.["description"] as string) ?? "";
    return {
      link: null,
      error: description
        ? `The payment provider refused this: ${description}`
        : "We couldn't create the payment link. Please try again.",
    };
  }
  return {
    link: {
      id: String(body["id"] ?? ""),
      short_url: String(body["short_url"] ?? ""),
      raw: body,
    },
    error: null,
  };
}

/** Constant-time webhook signature check over the raw request body. */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function razorpayWebhookSecret(supabase: SupabaseClient): Promise<string | null> {
  return vault(supabase, "razorpay_webhook_secret");
}

// ------------------------------------------------------------ subscriptions

async function rzp(
  keys: RazorpayKeys,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; body: Record<string, unknown>; error: string | null }> {
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, body: {}, error: "We couldn't reach the payment provider." };
  }
  const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!res.ok) {
    const description =
      ((body["error"] as Record<string, unknown> | undefined)?.["description"] as string) ?? "";
    return {
      ok: false,
      body,
      error: description
        ? `The payment provider refused this: ${description}`
        : "The payment provider couldn't complete that.",
    };
  }
  return { ok: true, body, error: null };
}

/** A recurring plan at the provider. Amount is rupees INCLUDING GST. */
export async function createPlan(
  keys: RazorpayKeys,
  input: { period: "monthly" | "yearly"; amount: number; name: string; description?: string },
) {
  return rzp(keys, "/plans", {
    method: "POST",
    body: {
      period: input.period,
      interval: 1,
      item: {
        name: input.name.slice(0, 100),
        amount: Math.round(input.amount * 100),
        currency: "INR",
        description: (input.description ?? input.name).slice(0, 255),
      },
    },
  });
}

export async function createSubscription(
  keys: RazorpayKeys,
  input: {
    planId: string;
    cycle: "monthly" | "annual";
    organizationId: string;
    notes?: Record<string, string>;
    customerNotify?: boolean;
  },
) {
  return rzp(keys, "/subscriptions", {
    method: "POST",
    body: {
      plan_id: input.planId,
      total_count: input.cycle === "annual" ? 10 : 120,
      customer_notify: input.customerNotify === true ? 1 : 0,
      notes: { org_id: input.organizationId, ...(input.notes ?? {}) },
    },
  });
}

/** A one-off charge on top of the mandate — how usage overage is collected. */
export async function addAddon(
  keys: RazorpayKeys,
  subscriptionId: string,
  input: { name: string; amount: number; quantity?: number },
) {
  return rzp(keys, `/subscriptions/${subscriptionId}/addons`, {
    method: "POST",
    body: {
      item: {
        name: input.name.slice(0, 100),
        amount: Math.round(input.amount * 100),
        currency: "INR",
      },
      quantity: input.quantity ?? 1,
    },
  });
}

export async function cancelSubscription(
  keys: RazorpayKeys,
  subscriptionId: string,
  atPeriodEnd = true,
) {
  return rzp(keys, `/subscriptions/${subscriptionId}/cancel`, {
    method: "POST",
    body: { cancel_at_cycle_end: atPeriodEnd ? 1 : 0 },
  });
}

export async function fetchSubscription(keys: RazorpayKeys, subscriptionId: string) {
  return rzp(keys, `/subscriptions/${subscriptionId}`);
}
