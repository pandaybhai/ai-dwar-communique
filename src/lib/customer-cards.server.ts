/**
 * Branded picture cards for a merchant's customers.
 *
 * The drawing happens in the `render-card` function on the aidwar backend —
 * this app's runtime can't rasterise ("Wasm code generation disallowed by
 * embedder"), so we ask for a card and hand back a URL, exactly like the
 * day-one onboarding cards. The five customer kinds are platform templates
 * in onboarding_card_templates; render-card v8 drops any <img> whose URL is
 * blank or not https, so a workspace without a logo still renders cleanly.
 *
 * Rule of the house (same as onboarding): a card is decoration. Any failure
 * returns null and the caller sends its words without a picture. A card must
 * never be the reason a message doesn't arrive.
 *
 * Money: rendering costs ₹0.10, charged (via ai_usage, task "card_render")
 * only when the cacheKey misses locally — a repeat of the same card with the
 * same values is free. wallet_apply stays the only ledger writer; this is
 * usage metering, not a wallet debit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const CUSTOMER_CARD_KINDS = [
  "customer_offer",
  "customer_product",
  "customer_order_update",
  "customer_receipt",
  "customer_appointment",
] as const;

export type CustomerCardKind = (typeof CUSTOMER_CARD_KINDS)[number];

export const CUSTOMER_CARD_META: Record<
  CustomerCardKind,
  { title: string; description: string; vars: string[] }
> = {
  customer_offer: {
    title: "Offer",
    description: "A headline offer with a coupon code and validity date.",
    vars: ["headline", "offer", "validity", "code"],
  },
  customer_product: {
    title: "Product",
    description: "One product with its picture, price and a one-line pitch.",
    vars: ["name", "price", "image_url", "one_liner"],
  },
  customer_order_update: {
    title: "Order update",
    description: "Order number, its new status and when it arrives.",
    vars: ["order_no", "status", "eta"],
  },
  customer_receipt: {
    title: "Receipt",
    description: "A tidy receipt — up to four items and the total paid.",
    vars: ["item_1", "item_2", "item_3", "item_4", "total"],
  },
  customer_appointment: {
    title: "Appointment",
    description: "A booking card with the date, time and place.",
    vars: ["date", "time", "place"],
  },
};

const RENDER_TIMEOUT_MS = 6000;
const CARD_RENDER_COST = 0.1; // ₹ per uncached render

/** Short, stable fingerprint of the values a card was drawn with. */
function varsHash(vars: Record<string, string>): string {
  const text = JSON.stringify(vars);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const urlCache = new Map<string, string>();

/** Whether the cards feature is switched on for this workspace. */
export async function cardsEnabled(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { enabledFlags } = await import("@/lib/ai-tools.server");
  return (await enabledFlags(supabase, organizationId)).has("cards");
}

/** Brand paint for one workspace: logo, colours and display name. */
export async function loadCardBranding(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Record<string, string>> {
  const { data } = await supabase
    .from("organizations")
    .select("name, branding")
    .eq("id", organizationId)
    .maybeSingle();
  const row = (data ?? {}) as { name?: string | null; branding?: Record<string, unknown> | null };
  const branding = (row.branding ?? {}) as Record<string, unknown>;
  const pick = (key: string): string => {
    const v = branding[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    brand_logo_url: pick("brand_logo_url") || pick("logo_url"),
    brand_name: pick("brand_name") || (row.name ?? "").trim(),
    brand_primary: pick("brand_primary") || "#10B981",
    brand_accent: pick("brand_accent") || "#0D9488",
  };
}

/**
 * Fill a card's configured values with the message's variables.
 * "{{1}}" in a stored value becomes the first template variable, and so on.
 */
export function fillCardVars(
  configured: Record<string, string>,
  variables: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(configured)) {
    out[key] = String(raw).replace(/\{\{(\d+)\}\}/g, (_, n) => variables[String(n)] ?? "");
  }
  return out;
}

/**
 * Render one customer card and return a public URL, or null when anything
 * gets in the way. Only an uncached render is metered (₹0.10).
 */
export async function renderCustomerCard(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    kind: string;
    vars: Record<string, string>;
    /** Skip the charge — used for live previews the merchant asked for. */
    meter?: boolean;
  },
): Promise<string | null> {
  if (!(CUSTOMER_CARD_KINDS as readonly string[]).includes(args.kind)) return null;

  const branding = await loadCardBranding(supabase, args.organizationId);
  // Brand paint is the default; an explicit value from the caller wins.
  const vars: Record<string, string> = { ...branding, ...args.vars };

  const cacheKey = `org/${args.organizationId}/${args.kind}-${varsHash(vars)}`;
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;

  const baseUrl = process.env["AIDWAR_SUPABASE_URL"];
  const serviceKey = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];

  try {
    if (!baseUrl || !serviceKey) throw new Error("renderer credentials are not configured");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/functions/v1/render-card`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: args.kind, vars, cacheKey }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = (await res.json().catch(() => null)) as
      | { url?: string; error?: string }
      | null;
    if (!res.ok) throw new Error(`render-card ${res.status}: ${payload?.error ?? "no body"}`);
    const url = payload?.url;
    if (!url) throw new Error("render-card returned no url");

    urlCache.set(cacheKey, url);

    if (args.meter !== false) {
      const { meterAiUsage } = await import("@/lib/ai-run.server");
      await meterAiUsage(supabase, args.organizationId, "card_render", {
        costAmount: CARD_RENDER_COST,
        runs: 1,
      });
    }

    return url;
  } catch (error) {
    console.error(
      "[customer-cards]",
      args.kind,
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    );
    return null;
  }
}

/**
 * Send a rendered card to a customer as a picture message, after their
 * text has already gone out. Never throws: any failure is logged and the
 * caller carries on — the words already arrived.
 */
export async function sendCardToContact(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string | null;
    phone: string;
    sender: { phoneNumberId: string; accessToken: string };
    kind: string;
    vars: Record<string, string>;
    caption: string;
  },
): Promise<{ sent: boolean; reason?: string }> {
  try {
    if (!args.contactId) return { sent: false, reason: "no_contact" };

    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", args.organizationId)
      .eq("contact_id", args.contactId)
      .limit(1)
      .maybeSingle();
    const conversationId = (conversation as { id?: string } | null)?.id ?? null;
    if (!conversationId) return { sent: false, reason: "no_conversation" };

    const url = await renderCustomerCard(supabase, {
      organizationId: args.organizationId,
      kind: args.kind,
      vars: args.vars,
    });
    if (!url) return { sent: false, reason: "render_failed" };

    const { sendServiceImage } = await import("@/lib/service-text.server");
    const result = await sendServiceImage(supabase, {
      organizationId: args.organizationId,
      phoneNumberId: args.sender.phoneNumberId,
      accessToken: args.sender.accessToken,
      conversationId,
      to: args.phone,
      imageUrl: url,
      caption: args.caption,
    });
    if (!result.ok) return { sent: false, reason: result.error ?? "send_failed" };

    const { emitEvent } = await import("@/lib/events.server");
    await emitEvent(supabase, "card.sent", {
      organizationId: args.organizationId,
      entityType: "conversation",
      entityId: conversationId,
      properties: { kind: args.kind, contact_id: args.contactId },
    });
    return { sent: true };
  } catch (error) {
    console.error(
      "[customer-cards] send",
      error instanceof Error ? error.message : String(error),
    );
    return { sent: false, reason: "exception" };
  }
}
