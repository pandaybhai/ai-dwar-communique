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
