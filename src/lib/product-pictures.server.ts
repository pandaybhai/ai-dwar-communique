import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunMedia } from "@/lib/ai-run.server";

/**
 * Product pictures in a customer chat: one image per product with its name
 * and price as the caption (and the product's link, when asked for). Shared by
 * Aiden's catalogue answers and the flows "Show products" step, so a product
 * looks the same however the customer reached it.
 */

export type PictureItem = Pick<RunMedia, "title" | "imageUrl" | "price" | "currency" | "productUrl">;

/** "₹19,604", or "" when the product has no price. */
export function productPrice(item: Pick<RunMedia, "price" | "currency">): string {
  if (item.price === null) return "";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: item.currency || "INR",
    maximumFractionDigits: 0,
  }).format(item.price);
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
    onFailure?: (error: string | null) => void;
  },
): Promise<number> {
  const { sendServiceImage } = await import("@/lib/service-text.server");
  let sent = 0;
  let cardSent = false;
  for (const item of args.items) {
    const caption = productCaption(item, args.withLink);
    if (args.cards && !cardSent) {
      try {
        const { sendCardToContact } = await import("@/lib/customer-cards.server");
        const card = await sendCardToContact(supabase, {
          organizationId: args.organizationId,
          contactId: args.contactId,
          phone: args.to,
          sender: { phoneNumberId: args.phoneNumberId, accessToken: args.accessToken },
          kind: "customer_product",
          vars: { name: item.title, price: productPrice(item), image_url: item.imageUrl, one_liner: "" },
          caption,
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
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
    if (picture.ok) sent += 1;
    else args.onFailure?.(picture.error);
  }
  return sent;
}
