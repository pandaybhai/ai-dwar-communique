import { checkRealNumber } from "@/lib/start-qualify";

/**
 * Batch 80: the /999 page (AiDwar Basic, ₹999/month, pay Meta directly) —
 * its words, the live demo's conversations, the zero-markup calculator and
 * the checkout's field rules. Pure: the page, the tests and the server read
 * the same figures.
 *
 * No GST while AiDwar isn't GST-registered (Batch 55): every price on the
 * page is a flat ₹999 and the gateway is charged exactly that (chargeFor).
 * When platform_settings.gst_registered turns true, billing adds GST on its
 * own; this copy (PRICE_LINE, the order summary, the Pay button) then needs
 * its "+ GST" line — listed in the Batch 80 PR.
 */

export const BASIC_PRICE = 999;
export const PRICE_LABEL = "₹999";
export const PER_MONTH = "₹999/month";

export const HERO = {
  kicker: "AiDwar Basic",
  headline: "Your AI salesperson on WhatsApp.",
  sub: "₹999/month. Pay Meta directly — we add zero markup on messages.",
  cta: "Start for ₹999 →",
  small: "7-day money-back · Live in 10 minutes · Cancel anytime",
} as const;

export const STICKY = { price: PER_MONTH, cta: "Start now →" } as const;

/* ------------------------------------------------------------ live demo --- */

export type DemoLine =
  | { from: "customer"; text: string }
  | { from: "aiden"; text: string; card?: { title: string; price: string } };

export type DemoChat = {
  key: string;
  label: string;
  /** The example shop shown in the phone's header (never a real business). */
  shop: string;
  initials: string;
  lines: DemoLine[];
};

/** Six example chats — the chips above the phone switch between them. */
export const DEMO_CHATS: readonly DemoChat[] = [
  {
    key: "jewellery",
    label: "Jewellery",
    shop: "Your Jewellery Store",
    initials: "YJ",
    lines: [
      { from: "customer", text: "Aaj ka 22k gold rate kya hai?" },
      {
        from: "aiden",
        text: "Today's 22k rate is ₹11,950/g 🙏 A 10g chain comes to about ₹1,29,500 with making.",
      },
      { from: "customer", text: "Can you hold one for Saturday?" },
      {
        from: "aiden",
        text: "Done! Held in your name till Saturday 7 pm. See you then ✨",
      },
    ],
  },
  {
    key: "fashion",
    label: "Fashion",
    shop: "Your Boutique",
    initials: "YB",
    lines: [
      { from: "customer", text: "Price of the blue cotton kurta? Size M?" },
      {
        from: "aiden",
        text: "It's ₹1,299 and M is in stock 👗",
        card: { title: "Indigo cotton kurta", price: "₹1,299" },
      },
      { from: "customer", text: "Ok, I'll take it" },
      { from: "aiden", text: "Lovely! Here's your payment link — it ships today 📦" },
    ],
  },
  {
    key: "food",
    label: "Food & café",
    shop: "Your Café",
    initials: "YC",
    lines: [
      { from: "customer", text: "Where is my order? Ordered 20 min back" },
      {
        from: "aiden",
        text: "Your 2 cold coffees and 1 paneer wrap are out for delivery 🛵 About 8 minutes away.",
      },
      { from: "customer", text: "Thanks!" },
      { from: "aiden", text: "Enjoy! ☕" },
    ],
  },
  {
    key: "clinic",
    label: "Clinic & salon",
    shop: "Your Salon",
    initials: "YS",
    lines: [
      { from: "customer", text: "Haircut + spa tomorrow evening possible?" },
      {
        from: "aiden",
        text: "Yes! Tomorrow we have 5:30 pm or 7:00 pm. Which one suits you?",
      },
      { from: "customer", text: "5:30" },
      { from: "aiden", text: "Booked for 5:30 pm tomorrow ✅ I'll remind you an hour before." },
    ],
  },
  {
    key: "education",
    label: "Education",
    shop: "Your Coaching Institute",
    initials: "YI",
    lines: [
      { from: "customer", text: "What is the admission fee for Class 10 batch?" },
      {
        from: "aiden",
        text: "The Class 10 batch is ₹18,000 for the year, payable in 3 instalments 📚",
      },
      { from: "customer", text: "Demo class milega?" },
      { from: "aiden", text: "Haan! Free demo this Sunday 11 am. Shall I book a seat for you?" },
    ],
  },
  {
    key: "store",
    label: "Online store",
    shop: "Your Online Store",
    initials: "YO",
    lines: [
      { from: "customer", text: "Is cash on delivery available in Pune?" },
      {
        from: "aiden",
        text: "Yes, COD is available in Pune 👍 Delivery in 2–3 days.",
      },
      { from: "customer", text: "Great, ordering now" },
      {
        from: "aiden",
        text: "Wonderful! Your order is confirmed. I'll WhatsApp you the tracking.",
      },
    ],
  },
];

/** How long one chat plays before the next chip takes over (with the pause). */
export const DEMO_TIMING = {
  typingMs: 900,
  readMs: 650,
  gapMs: 700,
  holdMs: 2600,
} as const;

/** The order of beats for one chat: who types, then the line lands. Pure. */
export function demoBeats(chat: DemoChat): Array<{ at: number; show: number; typing: boolean }> {
  const beats: Array<{ at: number; show: number; typing: boolean }> = [];
  let t = 300;
  chat.lines.forEach((line, i) => {
    if (line.from === "aiden") {
      beats.push({ at: t, show: i, typing: true });
      t += DEMO_TIMING.typingMs;
    }
    beats.push({ at: t, show: i + 1, typing: false });
    t += line.from === "customer" ? DEMO_TIMING.readMs + DEMO_TIMING.gapMs : DEMO_TIMING.gapMs;
  });
  beats.push({ at: t + DEMO_TIMING.holdMs, show: -1, typing: false });
  return beats;
}

/* ----------------------------------------------------------- calculator --- */

export const CALC = {
  min: 500,
  max: 20000,
  step: 500,
  start: 3000,
  /** What other tools typically add on top of Meta's rate. */
  markupLow: 0.2,
  markupHigh: 0.4,
  metaPricingUrl: "https://developers.facebook.com/docs/whatsapp/pricing/",
} as const;

export type CalcKind = "offers" | "updates";

/** Offers are Meta's marketing messages; updates are utility messages. */
export function calcRate(kind: CalcKind, rates: { marketing: number; utility: number }): number {
  return kind === "offers" ? rates.marketing : rates.utility;
}

/** Rupees, rounded to whole rupees for the page. */
export function calc(
  messages: number,
  kind: CalcKind,
  rates: { marketing: number; utility: number },
): { meta: number; markupLow: number; markupHigh: number; saveAtLeast: number } {
  const n = Math.min(CALC.max, Math.max(CALC.min, Math.round(messages)));
  const meta = n * calcRate(kind, rates);
  const markupLow = meta * CALC.markupLow;
  const markupHigh = meta * CALC.markupHigh;
  return {
    meta: Math.round(meta),
    markupLow: Math.round(markupLow),
    markupHigh: Math.round(markupHigh),
    // Honest: the low end of the range is what we promise.
    saveAtLeast: Math.round(markupLow),
  };
}

/** ₹12,345 (Indian grouping, whole rupees). */
export function rupees(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

/** ₹0.86 — a per-message rate. */
export function ratePaise(value: number): string {
  return `₹${value.toFixed(2)}`;
}

/* -------------------------------------------------------- what you get --- */

export const GET_TILES = [
  {
    key: "number",
    title: "1 WhatsApp number",
    body: "Your own business number — customers see your name.",
  },
  {
    key: "aiden",
    title: "Aiden replies 24×7",
    body: "300 AI answers a month from your prices, products and policies — in Hindi, Hinglish or English.",
  },
  {
    key: "inbox",
    title: "Shared inbox",
    body: "You and a teammate see every chat and can take over anytime.",
  },
  {
    key: "campaigns",
    title: "Campaigns & templates",
    body: "Send offers and updates to your customer list in a few taps.",
  },
  {
    key: "meta",
    title: "Pay Meta directly",
    body: "Zero markup. Meta bills your card for messages at its own rate.",
  },
] as const;

export const STEPS = [
  {
    key: "connect",
    title: "Connect your WhatsApp number",
    body: "Log in with Facebook and pick your number. About 3 minutes.",
  },
  {
    key: "learn",
    title: "Aiden reads your website or price list",
    body: "No website? Send a photo or PDF of your price list on WhatsApp.",
  },
  {
    key: "live",
    title: "Go live",
    body: "Aiden starts answering your customers — you watch from the inbox.",
  },
] as const;

/** The six questions; Meta's two rates come from the same data as the calculator. */
export function faq(rates: { marketing: number; utility: number }) {
  return FAQ_BASE.map((f) =>
    f.q === "How much will Meta charge me?"
      ? {
          q: f.q,
          a: `Meta charges per message it delivers, by type. In India an offer (marketing) message is about ${ratePaise(rates.marketing)} and an update (utility) about ${ratePaise(rates.utility)}. Replies inside the 24-hour window are free. The calculator above uses Meta's own rates.`,
        }
      : f,
  );
}

const FAQ_BASE = [
  {
    q: "What's the catch?",
    a: "There isn't one. You pay ₹999 a month for AiDwar, and Meta bills your own card for WhatsApp messages at Meta's rate — we add nothing on top. Replies to customers within 24 hours of their message are free from Meta.",
  },
  {
    q: "How much will Meta charge me?",
    a: "Meta charges per message it delivers, by type. In India an offer (marketing) message is about ₹0.86 and an update (utility) about ₹0.12. Replies inside the 24-hour window are free. The calculator above uses Meta's own rates.",
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
    a: "Your plan includes 300 AI answers a month. After that, Aiden hands new chats to your inbox and alerts you so you reply yourself — nothing extra is charged. It resets on the 1st, and you can move to a bigger plan anytime.",
  },
  {
    q: "How do I cancel?",
    a: "From Billing in your workspace, anytime. Your plan stays on till the end of the month you paid for. And if it isn't for you, ask within 7 days of your first payment for a full refund.",
  },
] as const;

/* --------------------------------------------------------- sticky bar --- */

/**
 * The bar shows once the hero's button has scrolled away, and hides while
 * the checkout is open or the final call-to-action is on screen. Pure.
 */
export function stickyVisible(s: {
  heroCtaVisible: boolean;
  finalCtaVisible: boolean;
  checkoutOpen: boolean;
}): boolean {
  return !s.heroCtaVisible && !s.finalCtaVisible && !s.checkoutOpen;
}

/* ------------------------------------------------------------ checkout --- */

export const ORDER = {
  title: "AiDwar Basic",
  line: PER_MONTH,
  total: "Total today ₹999",
  pay: "Pay ₹999 →",
} as const;

export type CheckoutField = "phone" | "name" | "business_name" | "email" | "password";
export const FIELD_ORDER: readonly CheckoutField[] = [
  "phone",
  "name",
  "business_name",
  "email",
  "password",
];

export type CheckoutValues = Record<CheckoutField, string>;
export const EMPTY_VALUES: CheckoutValues = {
  phone: "",
  name: "",
  business_name: "",
  email: "",
  password: "",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** One field's problem, or null. `signedIn` skips email and password. Pure. */
export function fieldError(
  field: CheckoutField,
  values: CheckoutValues,
  opts: { signedIn?: boolean } = {},
): string | null {
  const v = values[field].trim();
  switch (field) {
    case "phone": {
      if (!v) return "Enter your WhatsApp number";
      const r = checkRealNumber(v);
      return r.ok ? null : r.error;
    }
    case "name":
      return v.replace(/\s+/g, " ").length >= 2 ? null : "Enter your name";
    case "business_name":
      return v.replace(/\s+/g, " ").length >= 2 ? null : "Enter your business name";
    case "email":
      if (opts.signedIn) return null;
      return EMAIL.test(v) ? null : "Enter a valid email";
    case "password":
      if (opts.signedIn) return null;
      return values.password.length >= 8 ? null : "Use at least 8 characters";
  }
}

export function allErrors(
  values: CheckoutValues,
  opts: { signedIn?: boolean } = {},
): Partial<Record<CheckoutField, string>> {
  const out: Partial<Record<CheckoutField, string>> = {};
  for (const f of FIELD_ORDER) {
    const e = fieldError(f, values, opts);
    if (e) out[f] = e;
  }
  return out;
}

/** "Weak" / "Okay" / "Strong" for the password hint. Pure. */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length < 8) return { score: 0, label: "At least 8 characters" };
  let kinds = 0;
  if (/[a-z]/.test(pw)) kinds++;
  if (/[A-Z]/.test(pw)) kinds++;
  if (/\d/.test(pw)) kinds++;
  if (/[^A-Za-z0-9]/.test(pw)) kinds++;
  if (pw.length >= 12 && kinds >= 3) return { score: 3, label: "Strong" };
  if (pw.length >= 10 || kinds >= 3) return { score: 2, label: "Good" };
  return { score: 1, label: "Okay — longer is stronger" };
}

/** The first name for the celebration ("Asha Rao" → "Asha"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Supabase's answer when the email already has an account (sign-up, confirmations off). */
export function isExistingAccountError(message: string | null | undefined): boolean {
  return /already (been )?registered|already exists|user_already_exists/i.test(
    String(message ?? ""),
  );
}

/** What the sheet keeps if it is closed and reopened (session only — never the password). */
export const SAVED_KEY = "aidwar.999.checkout";
export function savedSubset(values: CheckoutValues): Omit<CheckoutValues, "password"> {
  const { password: _password, ...rest } = values;
  void _password;
  return rest;
}
