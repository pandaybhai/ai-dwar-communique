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
