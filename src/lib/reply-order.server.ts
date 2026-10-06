import type { RunResult } from "@/lib/ai-run.server";
import { productCaption } from "@/lib/product-pictures.server";
import type { SendStep } from "@/lib/reply-order";

export type { SendStep };

/** As many pictures as the reply path sends after a reply without parts. */
const LEGACY_PICTURES = 3;

/**
 * A reply as the customer would get it, message by message, for the admin
 * Test tab and Compare — never sent. It follows the customer reply path
 * (ai-agent.server.ts) step for step:
 *   - with parts (send_products): each text part, then that part's products
 *     in the model's order — a product with a photo as its picture with the
 *     model's caption, one without as its caption in a text message;
 *   - without parts: the answer, then up to three product pictures with name
 *     and price (productCaption, no link).
 * With the WhatsApp shop on, products go as catalogue cards instead; the
 * order is the same.
 */
export function replySendOrder(run: Pick<RunResult, "output" | "media" | "parts">): SendStep[] {
  const steps: SendStep[] = [];
  const text = (t: string) => {
    if (t.trim()) steps.push({ kind: "text", text: t });
  };
  if (run.parts && run.parts.length > 0) {
    for (const part of run.parts) {
      if (part.kind === "text") {
        text(part.text);
        continue;
      }
      for (const item of part.items) {
        if (!item.hasPhoto) {
          text(item.caption);
          continue;
        }
        steps.push({
          kind: "picture",
          title: item.title,
          image_url: item.imageUrl,
          caption: item.caption,
          price: item.price,
          currency: item.currency,
        });
      }
    }
    return steps;
  }
  text(run.output.trim());
  // The reply path sends pictures only after words went out.
  if (steps.length === 0) return steps;
  for (const m of run.media.slice(0, LEGACY_PICTURES))
    steps.push({
      kind: "picture",
      title: m.title,
      image_url: m.imageUrl,
      caption: productCaption(m),
      price: m.price,
      currency: m.currency,
    });
  return steps;
}
