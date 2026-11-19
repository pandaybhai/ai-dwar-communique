import { GET_TILES, ratePaise } from "@/lib/page-999";

/**
 * Batch 82: the /199 page — pay ₹199 for 30 days of AiDwar Basic, and our
 * team calls to set it up and help the buyer choose a plan. Built from /999
 * (its demo, calculator, steps, field rules and helpers are imported from
 * page-999.ts unchanged); only the words about price and what happens next
 * are this page's own. No ₹999 anywhere on it: the price is never
 * contradictory. The charge itself is decided on the server
 * (startPlanPurchase, source landing_199) — nothing here is sent as an amount.
 *
 * No GST while AiDwar isn't GST-registered (Batch 55): the page says ₹199 and
 * the gateway is charged exactly that.
 */

export const OFFER_PRICE = 199;
export const OFFER_LABEL = "₹199";

export const HERO_199 = {
  kicker: "AiDwar Basic",
  headline: "Your AI salesperson on WhatsApp.",
  sub: "Pay Meta directly — we add zero markup on messages.",
  price: "₹199",
  priceLine: "Your first month of AiDwar — and our team sets it up for you on a call.",
  cta: "Start for ₹199",
  small: "7-day money-back · Pay Meta directly — zero markup",
} as const;

/** The compact price + CTA block repeated down the page. */
export const PRICE_BLOCK_199 = {
  title: "₹199 — your first 30 days",
  line: "Our team sets it up with you · 7-day money-back · Pay Meta directly — zero markup",
  cta: "Start for ₹199",
} as const;

/** The sticky bar — price, one real line every 4 s, the button. */
export const STICKY_199 = {
  price: "₹199",
  cta: "Start for ₹199",
  finish: "Finish setup — ₹199",
  proofs: [
    "7-day money-back",
    "Our team sets it up with you",
    "Pay Meta directly — zero markup",
    "Nothing renews automatically",
  ],
  rotateMs: 4000,
} as const;

/** The one honest line about what happens after the 30 days (shown above the FAQ). */
export const AFTER_30_DAYS =
  "After 30 days you choose a plan with our team. Nothing renews automatically.";

/** What you get — /999's tiles, the same plan. */
export const GET_TILES_199 = GET_TILES;

/** The checkout's order summary and button. */
export const ORDER_199 = {
  title: "AiDwar Basic",
  line: "30 days",
  total: "Total today ₹199",
  pay: "Pay ₹199",
} as const;

/** The success screen's first line. */
export const SUCCESS_199 =
  "Done! Our team will call you within 1 hour to set up AiDwar on your WhatsApp.";

/** The server's answer when this number or workspace had its ₹199 already. */
export const OFFER_USED_199 = "You've already used the ₹199 offer — our team will call you";

/** The exit-intent "Your setup is saved" screen, once per session. */
export const EXIT_SEEN_KEY_199 = "aidwar.199.exit_seen";
export const EXIT_199 = {
  title: "Your setup is saved.",
  body: "₹199 for 30 days, with a 7-day money-back — no risk.",
  continue: "Continue to pay",
  close: "Close",
} as const;

/** What the sheet keeps if closed and reopened (2 hours, this browser). */
export const SAVED_KEY_199 = "aidwar.199.checkout";

/** The six questions — /999's, with this page's price and what happens after 30 days. */
export function faq199(rates: { marketing: number; utility: number }) {
  return [
    {
      q: "What's the catch?",
      a: "There isn't one. You pay ₹199 once for 30 days of AiDwar Basic, and our team calls you to set it up. Meta bills your own card for WhatsApp messages at Meta's rate — we add nothing on top. Replies to customers within 24 hours of their message are free from Meta.",
    },
    {
      q: "How much will Meta charge me?",
      a: `Meta charges per message it delivers, by type. In India an offer (marketing) message is about ${ratePaise(rates.marketing)} and an update (utility) about ${ratePaise(rates.utility)}. Replies inside the 24-hour window are free. The calculator above uses Meta's own rates.`,
    },
    {
      q: "Do I need a website?",
      a: "No. Aiden can learn from a photo or PDF of your price list or catalogue, and from a few quick answers on WhatsApp. If you have a website, Aiden reads it too.",
    },
    {
      q: "Can I use my existing number?",
      a: "Yes — the number you use for your business today. While it's connected to AiDwar it runs on the WhatsApp Business Platform, so you chat with customers from the AiDwar inbox instead of the WhatsApp app.",
    },
    {
      q: "What happens after 300 AI answers?",
      a: "Your plan includes 300 AI answers a month. After that, Aiden hands new chats to your inbox and alerts you so you reply yourself — nothing extra is charged.",
    },
    {
      q: "What happens after 30 days?",
      a: "Our team talks to you and you choose a plan — or you stop, and nothing more is charged. Nothing renews automatically. And if it isn't for you, ask within 7 days of paying for a full refund.",
    },
  ];
}
