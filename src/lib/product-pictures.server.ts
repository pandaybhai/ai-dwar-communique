import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunMedia } from "@/lib/ai-run.server";
import type { ReplyTimer } from "@/lib/reply-timing";

/**
 * Product pictures in a customer chat: one image per product. The flows
 * "Show products" step captions each with its name and price (and link, when
 * asked for); Aiden sends the caption the model wrote (send_products). One
 * sender, so a product picture goes out the same way however it was chosen.
 */

export type PictureItem = Pick<RunMedia, "title" | "imageUrl" | "price" | "currency" | "productUrl"> & {
  /** The caption Aiden wrote for this product (send_products); absent: name and price, as always. */
  caption?: string;
  /** Stored on this picture's message row, over the call's own metadata. */
  metadata?: Record<string, unknown>;
};

/** "₹19,604", or "" when the product has no price. */
export function productPrice(item: Pick<RunMedia, "price" | "currency">): string {
  if (item.price === null) return "";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: item.currency || "INR",
    maximumFractionDigits: 0,
  }).format(item.price);
}

/**
 * The values a product's branded card is drawn from. One place, so a card
 * drawn ahead of time (Aiden's prewarm) is the very card the send reuses
 * (same cacheKey in customer-cards.server.ts).
 */
export function productCardVars(item: PictureItem): Record<string, string> {
  return { name: item.title, price: productPrice(item), image_url: item.imageUrl, one_liner: "" };
}

/** "Name — ₹19,604", plus the product's link on its own line when withLink. */
export function productCaption(item: PictureItem, withLink = false): string {
  const price = productPrice(item);
  const link = withLink && item.productUrl ? `\n${item.productUrl}` : "";
  return `${item.title}${price ? ` — ${price}` : ""}${link}`;
}

/**
 * Sends the pictures in order. With branded cards on, the first product goes
 * out as a card; any card failure falls back to the plain picture. Returns how
 * many went out.
 */
/** How long a product's branded card may take before its plain photo goes instead (Batch 16). */
export const CARD_WAIT_MS = 1000;

export async function sendProductPictures(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string | null;
    conversationId: string;
    to: string;
    phoneNumberId: string;
    accessToken: string;
    items: PictureItem[];
    cards: boolean;
    withLink?: boolean;
    /** The caller read the 24-hour window in this request. */
    windowOpen?: boolean;
    metadata?: Record<string, unknown>;
    /** The webhook's reply timer (Aiden's sends); left out, nothing is timed. */
    timer?: ReplyTimer;
    onFailure?: (error: string | null) => void;
    /** Keeps a card still drawing after its ~1 s wait alive past the reply (the webhook's later()). */
    background?: (work: Promise<unknown>) => void;
  },
): Promise<number> {
  const { sendServiceImage } = await import("@/lib/service-text.server");
  let sent = 0;
  let cardSent = false;
  for (const item of args.items) {
    const caption = typeof item.caption === "string" ? item.caption : productCaption(item, args.withLink);
    const metadata = item.metadata ? { ...(args.metadata ?? {}), ...item.metadata } : args.metadata;
    if (args.cards && !cardSent) {
      try {
        const { sendCardToContact } = await import("@/lib/customer-cards.server");
        const card = await sendCardToContact(supabase, {
          organizationId: args.organizationId,
          contactId: args.contactId,
          phone: args.to,
          sender: { phoneNumberId: args.phoneNumberId, accessToken: args.accessToken },
          kind: "customer_product",
          vars: productCardVars(item),
          caption,
          ...(item.metadata ? { metadata } : {}),
          ...(args.timer ? { timer: args.timer } : {}),
          // Batch 16: a card not ready within ~1 s never holds the reply —
          // the plain photo goes with the same caption (below) and the card
          // is drawn in the background for next time.
          waitMs: CARD_WAIT_MS,
          ...(args.background ? { background: args.background } : {}),
        });
        if (card.sent) {
          cardSent = true;
          sent += 1;
          continue;
        }
      } catch {
        // fall through to the plain picture
      }
    }
    const picture = await sendServiceImage(supabase, {
      organizationId: args.organizationId,
      phoneNumberId: args.phoneNumberId,
      accessToken: args.accessToken,
      conversationId: args.conversationId,
      to: args.to,
      imageUrl: item.imageUrl,
      caption,
      ...(args.windowOpen ? { windowOpen: true } : {}),
      ...(metadata ? { metadata } : {}),
      ...(args.timer ? { timer: args.timer } : {}),
    });
    if (picture.ok) sent += 1;
    else args.onFailure?.(picture.error);
  }
  return sent;
}
