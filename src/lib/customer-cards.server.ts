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
 * Reuse: a card is stored by render-card under its cacheKey (workspace +
 * design + a hash of its values, brand paint included). Before asking for a
 * render we look for that stored picture — in this server's memory, then in
 * storage — so a restart or another server never draws the same card twice.
 *
 * Usage: every real render (never a reuse) is recorded on ai_usage — task
 * "card_render" for cards sent to customers, "card_preview" for the
 * merchant's own previews — through the service client (ai_usage is
 * read-only to members). Recording only: nothing here charges the wallet
 * (wallet debits come from ai_runs, never ai_usage) and no price changes.
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
/** How long the stored-card lookup may take before we just render. */
const LOOKUP_TIMEOUT_MS = 2500;
const CARD_RENDER_COST = 0.1; // ₹ per real render — recorded, not charged
/** render-card's bucket (it writes there itself). */
const CARD_BUCKET = "onboarding-cards";

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

/** The key a card is stored under: workspace, design and its values (brand paint included). */
export function cardCacheKey(organizationId: string, kind: string, vars: Record<string, string>): string {
  return `org/${organizationId}/${kind}-${varsHash(vars)}`;
}

/** The public address render-card stores a card at (same cleaning as render-card). */
export function storedCardUrl(baseUrl: string, cacheKey: string): string {
  const path = `${cacheKey.replace(/[^a-zA-Z0-9/_-]/g, "_")}.png`;
  return `${baseUrl.replace(/\/$/, "")}/storage/v1/object/public/${CARD_BUCKET}/${path}`;
}

/**
 * The already-stored picture for a cacheKey, or null. Only a real image
 * counts; a miss, an error or a slow answer is null and the card is drawn.
 */
async function lookUpStoredCard(baseUrl: string, cacheKey: string): Promise<string | null> {
  const url = storedCardUrl(baseUrl, cacheKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    const type = res.headers.get("content-type") ?? "";
    return res.ok && type.startsWith("image/") ? url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Card values with the workspace's brand paint under them (an explicit value wins). */
async function paintedVars(
  supabase: SupabaseClient,
  organizationId: string,
  vars: Record<string, string>,
): Promise<Record<string, string>> {
  const branding = await loadCardBranding(supabase, organizationId);
  return { ...branding, ...vars };
}

/**
 * The card already drawn for these values, without drawing anything: memory,
 * then storage. Used by the Cards page to show each design's last preview.
 */
export async function findStoredCustomerCard(
  supabase: SupabaseClient,
  args: { organizationId: string; kind: string; vars: Record<string, string> },
): Promise<string | null> {
  if (!(CUSTOMER_CARD_KINDS as readonly string[]).includes(args.kind)) return null;
  const vars = await paintedVars(supabase, args.organizationId, args.vars);
  const cacheKey = cardCacheKey(args.organizationId, args.kind, vars);
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;
  const baseUrl = process.env["AIDWAR_SUPABASE_URL"];
  if (!baseUrl) return null;
  const stored = await lookUpStoredCard(baseUrl, cacheKey);
  if (stored) urlCache.set(cacheKey, stored);
  return stored;
}

/**
 * Records one real render on ai_usage. Written with the service client:
 * members can only read ai_usage, so the caller's client would be refused
 * (that is why no card_render row was ever written). Never throws.
 */
async function recordCardRender(organizationId: string, task: "card_render" | "card_preview"): Promise<void> {
  try {
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const { meterAiUsage } = await import("@/lib/ai-run.server");
    const service = getServiceClient();
    await meterAiUsage(service, organizationId, task, { costAmount: CARD_RENDER_COST, runs: 1 });
    // Past 5,000 renders this month the platform owner is told, once. Off the
    // card's path: the check never delays or blocks a message.
    if (task === "card_render") {
      void import("@/lib/card-usage-alert.server")
        .then(({ checkCardUsageAlarm }) => checkCardUsageAlarm(service, organizationId))
        .catch(() => false);
    }
  } catch (error) {
    console.error("[customer-cards] usage not recorded", error instanceof Error ? error.message : String(error));
  }
}

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
 * gets in the way. A card already stored for the same values is reused;
 * only a real render is recorded on ai_usage.
 */
export async function renderCustomerCard(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    kind: string;
    vars: Record<string, string>;
    /** false: a preview the merchant asked for (recorded as "card_preview", not "card_render"). */
    meter?: boolean;
  },
): Promise<string | null> {
  if (!(CUSTOMER_CARD_KINDS as readonly string[]).includes(args.kind)) return null;

  // Brand paint is the default; an explicit value from the caller wins.
  const vars = await paintedVars(supabase, args.organizationId, args.vars);

  const cacheKey = cardCacheKey(args.organizationId, args.kind, vars);
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;
  // The same card already being drawn (Aiden draws a reply's first card
  // while it is still writing): wait for that one — never draw it twice.
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;
  const drawing = drawCard(args, vars, cacheKey);
  inFlight.set(cacheKey, drawing);
  try {
    return await drawing;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/** Cards being drawn right now in this worker, by cacheKey. */
const inFlight = new Map<string, Promise<string | null>>();

async function drawCard(
  args: { organizationId: string; kind: string; meter?: boolean },
  vars: Record<string, string>,
  cacheKey: string,
): Promise<string | null> {

  const baseUrl = process.env["AIDWAR_SUPABASE_URL"];
  const serviceKey = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];

  try {
    if (!baseUrl || !serviceKey) throw new Error("renderer credentials are not configured");

    // Drawn before (by this server or another, before a restart): reuse it.
    const stored = await lookUpStoredCard(baseUrl, cacheKey);
    if (stored) {
      urlCache.set(cacheKey, stored);
      return stored;
    }

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
      | { url?: string; error?: string; cached?: boolean }
      | null;
    if (!res.ok) throw new Error(`render-card ${res.status}: ${payload?.error ?? "no body"}`);
    const url = payload?.url;
    if (!url) throw new Error("render-card returned no url");

    urlCache.set(cacheKey, url);

    // render-card found it stored after all: a reuse, not a render.
    if (payload?.cached !== true) await recordCardRender(args.organizationId, args.meter === false ? "card_preview" : "card_render");

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
    /** The thread to send into; left out, the contact's first conversation is used (as before). */
    conversationId?: string;
    /** The caller read the 24-hour window in this request. */
    windowOpen?: boolean;
    /** Stored on the message row. */
    metadata?: Record<string, unknown>;
    /** The teammate who sent it from the inbox. */
    sentBy?: string;
    /** The webhook's reply timer (Aiden's first card); left out, nothing is timed. */
    timer?: import("@/lib/reply-timing").ReplyTimer;
    /**
     * Batch 16: how long the card may take to be ready. Past it the call
     * returns { sent: false, reason: "card_not_ready" } at once (the caller
     * sends the plain photo) while the card keeps drawing for next time.
     * Left out, it waits as before.
     */
    waitMs?: number;
    /** Keeps the background drawing alive past the reply (the webhook's later()). */
    background?: (work: Promise<unknown>) => void;
  },
): Promise<{ sent: boolean; reason?: string; messageId?: string | null }> {
  try {
    if (!args.contactId) return { sent: false, reason: "no_contact" };

    let conversationId = args.conversationId ?? null;
    if (!conversationId) {
      const { data: conversation } = await supabase
        .from("conversations")
        .select("id")
        .eq("organization_id", args.organizationId)
        .eq("contact_id", args.contactId)
        .limit(1)
        .maybeSingle();
      conversationId = (conversation as { id?: string } | null)?.id ?? null;
    }
    if (!conversationId) return { sent: false, reason: "no_conversation" };

    const drawing = renderCustomerCard(supabase, {
      organizationId: args.organizationId,
      kind: args.kind,
      vars: args.vars,
    });
    let url: string | null;
    if (args.waitMs !== undefined) {
      const late = Symbol("late");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race([
        drawing,
        new Promise<typeof late>((resolve) => {
          timer = setTimeout(() => resolve(late), Math.max(0, args.waitMs!));
        }),
      ]);
      clearTimeout(timer);
      if (raced === late) {
        // Not ready in time: the plain photo goes now; the card finishes
        // drawing (and is stored) for the next customer who sees it.
        const finishing = drawing.catch(() => null);
        args.background?.(finishing);
        return { sent: false, reason: "card_not_ready" };
      }
      url = raced;
    } else {
      url = await drawing;
    }
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
      ...(args.windowOpen ? { windowOpen: true } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
      ...(args.sentBy ? { sentBy: args.sentBy } : {}),
      ...(args.timer ? { timer: args.timer } : {}),
    });
    if (!result.ok) {
      // The 24-hour rule deserves plain words, not a code.
      const closed =
        typeof result.error === "string" && result.error.includes("service_window_closed");
      return {
        sent: false,
        reason: closed
          ? "Outside the 24-hour window — send a template first."
          : result.error ?? "send_failed",
      };
    }

    const { emitEvent } = await import("@/lib/events.server");
    await emitEvent(supabase, "card.sent", {
      organizationId: args.organizationId,
      entityType: "conversation",
      entityId: conversationId,
      properties: { kind: args.kind, contact_id: args.contactId },
    });
    return { sent: true, messageId: result.messageId };
  } catch (error) {
    console.error(
      "[customer-cards] send",
      error instanceof Error ? error.message : String(error),
    );
    return { sent: false, reason: "exception" };
  }
}

/** Why a card didn't go that a plain message couldn't fix either. */
const NO_FALLBACK = new Set(["no_contact", "no_conversation"]);
const WINDOW_CLOSED = "Outside the 24-hour window — send a template first.";

export type CardOrFallbackResult = {
  /** The branded card went out. */
  card: boolean;
  /** The plain photo/text went out instead. */
  fallback: boolean;
  reason?: string;
  messageId?: string | null;
};

/**
 * Sends a card the merchant chose (inbox, a flow's Send card step). When the
 * card can't go — cards switched off, the renderer down, the picture rejected —
 * the plain words go instead, the same way product-pictures.server.ts falls
 * back to the plain photo: a Product card's photo with the words as its
 * caption, otherwise a text. An empty `fallback` sends nothing extra.
 * Never throws.
 */
export async function sendCardOrFallback(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string | null;
    conversationId: string;
    phone: string;
    sender: { phoneNumberId: string; accessToken: string };
    kind: string;
    vars: Record<string, string>;
    caption: string;
    fallback: string;
    /** The workspace has the cards flag on; false never draws a card. */
    cardsOn: boolean;
    windowOpen?: boolean;
    metadata?: Record<string, unknown>;
    sentBy?: string;
  },
): Promise<CardOrFallbackResult> {
  let reason = "cards_off";
  if (args.cardsOn) {
    const card = await sendCardToContact(supabase, {
      organizationId: args.organizationId,
      contactId: args.contactId,
      phone: args.phone,
      sender: args.sender,
      kind: args.kind,
      vars: args.vars,
      caption: args.caption,
      conversationId: args.conversationId,
      ...(args.windowOpen ? { windowOpen: true } : {}),
      ...(args.metadata ? { metadata: { ...args.metadata, card_kind: args.kind } } : {}),
      ...(args.sentBy ? { sentBy: args.sentBy } : {}),
    });
    if (card.sent) return { card: true, fallback: false, messageId: card.messageId ?? null };
    reason = card.reason ?? "send_failed";
    if (NO_FALLBACK.has(reason) || reason === WINDOW_CLOSED) return { card: false, fallback: false, reason };
  }

  const text = args.fallback.trim();
  if (!text) return { card: false, fallback: false, reason };
  try {
    const { sendServiceImage, sendServiceText } = await import("@/lib/service-text.server");
    const base = {
      organizationId: args.organizationId,
      phoneNumberId: args.sender.phoneNumberId,
      accessToken: args.sender.accessToken,
      conversationId: args.conversationId,
      to: args.phone,
      ...(args.windowOpen ? { windowOpen: true } : {}),
      ...(args.metadata ? { metadata: { ...args.metadata, card_fallback: reason } } : {}),
      ...(args.sentBy ? { sentBy: args.sentBy } : {}),
    };
    const photo = String(args.vars["image_url"] ?? "").trim();
    const res = /^https:\/\/\S+$/i.test(photo)
      ? await sendServiceImage(supabase, { ...base, imageUrl: photo, caption: text })
      : await sendServiceText(supabase, { ...base, body: text });
    if (res.ok) return { card: false, fallback: true, reason, messageId: res.messageId };
    const closed = typeof res.error === "string" && res.error.includes("service_window_closed");
    return { card: false, fallback: false, reason: closed ? WINDOW_CLOSED : res.error ?? reason };
  } catch (error) {
    console.error("[customer-cards] fallback", error instanceof Error ? error.message : String(error));
    return { card: false, fallback: false, reason };
  }
}

/**
 * Whether Aiden's product answers and the Show products step send their first
 * product as a card: the cards flag, and the Cards page switch (on unless the
 * merchant turned it off). Workspaces without the flag never read anything.
 */
export async function productCardsOn(
  supabase: SupabaseClient,
  organizationId: string,
  flags: Set<string>,
): Promise<boolean> {
  if (!flags.has("cards")) return false;
  try {
    const { productCardsInAnswers } = await import("@/lib/customer-cards");
    const { data } = await supabase.from("organizations").select("branding").eq("id", organizationId).maybeSingle();
    return productCardsInAnswers(true, (data as { branding?: Record<string, unknown> | null } | null)?.branding ?? null);
  } catch {
    // Can't read the switch: keep today's behaviour.
    return true;
  }
}
