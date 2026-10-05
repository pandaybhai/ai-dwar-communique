/**
 * The five customer card designs, described for the browser.
 *
 * Kept apart from customer-cards.server.ts so a page or dialog can show the
 * choices without pulling server-only code into the browser bundle.
 */

export const CUSTOMER_CARD_KINDS = [
  "customer_offer",
  "customer_product",
  "customer_order_update",
  "customer_receipt",
  "customer_appointment",
] as const;

export type CustomerCardKind = (typeof CUSTOMER_CARD_KINDS)[number];

export type CustomerCardVar = { key: string; label: string; placeholder: string };

export const CUSTOMER_CARD_DESIGNS: Array<{
  kind: CustomerCardKind;
  title: string;
  blurb: string;
  vars: CustomerCardVar[];
}> = [
  {
    kind: "customer_offer",
    title: "Offer",
    blurb: "A headline offer with a coupon code and validity date.",
    vars: [
      { key: "headline", label: "Headline", placeholder: "This weekend only" },
      { key: "offer", label: "The offer", placeholder: "20% off everything" },
      { key: "validity", label: "Valid till", placeholder: "Till Sunday" },
      { key: "code", label: "Coupon code", placeholder: "FEST20" },
    ],
  },
  {
    kind: "customer_product",
    title: "Product",
    blurb: "One product with its picture, price and a one-line pitch.",
    vars: [
      { key: "name", label: "Product name", placeholder: "Cold Brew Concentrate" },
      { key: "price", label: "Price", placeholder: "₹499" },
      { key: "image_url", label: "Picture link (https)", placeholder: "https://…/photo.jpg" },
      { key: "one_liner", label: "One line about it", placeholder: "Makes 8 glasses" },
    ],
  },
  {
    kind: "customer_order_update",
    title: "Order update",
    blurb: "Order number, its new status and when it arrives.",
    vars: [
      { key: "order_no", label: "Order number", placeholder: "{{1}}" },
      { key: "status", label: "Status", placeholder: "Out for delivery" },
      { key: "eta", label: "Arriving", placeholder: "Today by 7 pm" },
    ],
  },
  {
    kind: "customer_receipt",
    title: "Receipt",
    blurb: "A tidy receipt — up to four items and the total paid.",
    vars: [
      { key: "item_1", label: "Item 1", placeholder: "Cold Brew — ₹499" },
      { key: "item_2", label: "Item 2", placeholder: "" },
      { key: "item_3", label: "Item 3", placeholder: "" },
      { key: "item_4", label: "Item 4", placeholder: "" },
      { key: "total", label: "Total paid", placeholder: "₹698" },
    ],
  },
  {
    kind: "customer_appointment",
    title: "Appointment",
    blurb: "A booking card with the date, time and place.",
    vars: [
      { key: "date", label: "Date", placeholder: "Saturday, 12 July" },
      { key: "time", label: "Time", placeholder: "4:00 pm" },
      { key: "place", label: "Place", placeholder: "Bandra studio" },
    ],
  },
];

export type CardAttachment = { kind: CustomerCardKind; vars: Record<string, string> };

export function isCardKind(kind: unknown): kind is CustomerCardKind {
  return (CUSTOMER_CARD_KINDS as readonly string[]).includes(String(kind ?? ""));
}

export function cardDesign(kind: unknown) {
  return CUSTOMER_CARD_DESIGNS.find((d) => d.kind === kind) ?? null;
}

/** Only the design's own fields, as trimmed strings (anything else is dropped). */
export function cleanCardVars(kind: CustomerCardKind, raw: unknown, maxLen = 300): Record<string, string> {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const v of cardDesign(kind)?.vars ?? []) {
    const value = input[v.key];
    out[v.key] = typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, maxLen) : "";
  }
  return out;
}

/**
 * The card's words as a plain message — what goes out instead when a card
 * can't be drawn, so the customer still gets the details.
 */
export function cardFallbackText(kind: CustomerCardKind, vars: Record<string, string>): string {
  const design = cardDesign(kind);
  if (!design) return "";
  const lines: string[] = [];
  for (const v of design.vars) {
    if (v.key === "image_url") continue;
    const value = String(vars[v.key] ?? "").trim();
    if (!value) continue;
    // Headline-ish fields read best on their own; the rest keep their label.
    if (["headline", "name", "offer", "one_liner"].includes(v.key) || v.key.startsWith("item_")) lines.push(value);
    else lines.push(`${v.label}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * Key on organizations.branding for the Cards page switch "Use product cards
 * in Aiden's answers and Show products". Only an explicit `false` turns the
 * product card off — a workspace that never touched the switch keeps today's
 * behaviour (a card whenever the cards flag is on).
 */
export const PRODUCT_CARDS_SETTING = "product_cards_in_answers";

export function productCardsInAnswers(cardsFlagOn: boolean, branding: Record<string, unknown> | null | undefined): boolean {
  if (!cardsFlagOn) return false;
  return (branding ?? {})[PRODUCT_CARDS_SETTING] !== false;
}

/** The Cards page "Where cards are used" examples. */
export const CARD_USES: Array<{ key: string; title: string; how: string; example: string }> = [
  {
    key: "inbox",
    title: "Inbox",
    how: "Tap the card button next to the message box and pick a design. Only inside the 24-hour window.",
    example: "A customer asks about their booking — send an Appointment card with the date, time and place.",
  },
  {
    key: "flows",
    title: "Flows",
    how: "Add a “Send card” step from the Messages group. Fill it with {{variables}} from earlier answers.",
    example: "After a customer picks a slot, send an Appointment card with {{date}} and {{time}}.",
  },
  {
    key: "campaigns",
    title: "Campaigns",
    how: "Pick a card on the Schedule step. It goes right after the template, to every contact.",
    example: "Festive sale template, followed by an Offer card with the coupon code FEST20.",
  },
  {
    key: "aiden",
    title: "Aiden product answers",
    how: "When Aiden or a Show products step answers with products, the first one can go as a Product card.",
    example: "“Do you have gold earrings under ₹5,000?” — the first match arrives as a branded Product card.",
  },
  {
    key: "orders",
    title: "Order updates",
    how: "Use the Order update or Receipt design from the inbox or a flow step when an order moves.",
    example: "“Out for delivery — arriving today by 7 pm” as an Order update card.",
  },
];
