import { fakeDb, type FakeOp } from "./fake-db";
import { memoryDb, type Row } from "./memory-db";

/**
 * Test-only: Zoori's live set-up, replayed. Org 81c234b2…, read from the live
 * database on 6 Oct 2026: the agent's current instructions (v3, "Priya from
 * Zoori"), a slice of the real catalogue (ids, titles, prices, links and
 * pictures as stored) and real website text. Everything a reply touches runs
 * for real — the answer run, its guards, the catalogue tool, the WhatsApp
 * send path — except the model, which is scripted per case (see CASES).
 *
 * The scripts read only what the run gives them: the system prompt, the
 * tools offered and the tool results. Where the live conversation exists
 * (7230c5b2…, 10:12–10:17 UTC) the model's own words are used verbatim.
 */

export const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
export const CONV = "7230c5b2-0219-41ac-9cde-848657d035af";
const CONTACT = "c-zoori-tester";

export const INSTRUCTIONS = {
  persona_name: "Priya from Zoori",
  tone: "friendly",
  languages: ["en", "hi"],
  escalation_rules:
    "Customer wants to talk to a person, wants to place a custom or bulk order, mentions a damaged or wrong item, asks for a refund, or is upset.",
  handover_message: "Let me get someone from the team to help — they'll reply here shortly.",
  working_hours_behaviour: "always",
  instructions:
    "You are Zoori's assistant on WhatsApp. Zoori is a Hyderabad jewellery brand — rings, pendants, earrings, bracelets, necklaces, chains, tanmaniya/mangalsutra — in certified diamonds, real gemstones and hallmarked gold. Two showrooms: Somajiguda (GF 1, Olbee Centre, Rajbhavan Road, near Skoda showroom, +91 70412 54772) and Bolarum, Secunderabad (GF06 Fairmount Square, Ruby Block, Brundavan Colony, +91 90909 05050).\n\n" +
    "Three promises you can always state: lifelong free maintenance, 20-day no-questions returns, certified stones and real gold. Website prices are the price to pay — no showroom markup.\n\n" +
    "Style: reply in the customer's language (Hindi, Hinglish or English), 2–4 short lines like a WhatsApp chat, never long paragraphs, no citation marks or brackets. End most replies with one helpful question.\n\n" +
    "Showing products: when a customer wants to see, choose or compare, show 2–3 pieces with price and link, then ask about budget, style or occasion. If nothing matches their budget, offer the closest above it or a different type.\n\n" +
    "Buying: when a customer says they want to buy, order or book a piece — congratulate briefly, repeat the name and price, and give two options: (1) order online at the product link, ring size chosen at checkout; (2) the Zoori team confirms size and payment right here on WhatsApp. For rings, ask their ring size; if they don't know it, point them to myzoori.com/size-guide. If they choose option 2 or ask how to pay, fetch a person and state what they want to buy.\n\n" +
    'Never quote a price, delivery time, resizing cost, making charge, EMI, exchange or offer that isn\'t on the website or in your notes — say "let me confirm that for you" and keep helping with the rest. Never promise same-day delivery. Never discuss competitors or other jewellers.',
};

const IMG = "https://myzoori.com/storage/images/products";
const product = (
  r: Partial<Row> & { id: string; title: string; price: number },
  i: number,
): Row => ({
  organization_id: ORG,
  is_visible: true,
  currency: "INR",
  availability: "in_stock",
  source: "crawl",
  external_id: null,
  meta_synced_at: null,
  gender: null,
  description: null,
  image_url: null,
  compare_at_price: null,
  // The live browse order: most recently touched first.
  updated_at: new Date(Date.UTC(2026, 9, 6, 9, 0, 0) - i * 60_000).toISOString(),
  ...r,
});

/**
 * As stored on 6 Oct (a slice of 472 visible products), with the ring genders
 * set on 7 Oct (every ZGRG ring male, every ZLRG ring female — 44 rows).
 */
export const PRODUCTS: Row[] = [
  {
    id: "8431b39b-3ba1-4171-aaa9-37b758e20651",
    title: "The Gilded Chevron",
    sku: "ZLRG-0001",
    category: "rings",
    gender: "female",
    price: 19603.91,
    product_url: "https://myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a",
    image_url: `${IMG}/a17c9b39-247c-451a-8063-09d9da502d9a/ZLRG%20-%200001.4-1783942115.jpg`,
  },
  {
    id: "277b1cc8-b43d-437c-bd67-ceae339d1483",
    title: "Industrial Sparkle/ The Urban Edge",
    sku: "ZLRG-0003",
    category: "rings",
    gender: "female",
    price: 18325.95,
    product_url: "https://myzoori.com/product-detail/a23fb400-da45-43fa-85da-b03f120a90a6",
    image_url: `${IMG}/a23fb400-da45-43fa-85da-b03f120a90a6/ZLRG-0003.524-1783944994.jpg`,
  },
  {
    id: "7d6cd2bf-25fd-4995-87d7-ad11a630ffb8",
    title: "The Allure Orbit/The Willow Vine",
    sku: "ZLRG-0004",
    category: "rings",
    gender: "female",
    price: 18015.7,
    product_url: "https://myzoori.com/product-detail/a23fcfaf-5a27-43d5-84cf-21c877280f36",
    image_url: `${IMG}/a23fcfaf-5a27-43d5-84cf-21c877280f36/ZLRG-0004.29-1783950907.jpg`,
  },
  {
    id: "8ad60eec-0999-4b14-a740-c085cff464c2",
    title: "The Architect",
    sku: "ZLRG-0005",
    category: "rings",
    gender: "female",
    price: 26446.37,
    product_url: "https://myzoori.com/product-detail/a23fd887-bb4a-4bad-8fe5-d2eb18e1dd42",
    image_url: `${IMG}/a23fd887-bb4a-4bad-8fe5-d2eb18e1dd42/ZLRG%20-%200005%20(4)-1783951165.jpg`,
  },
  {
    id: "3cc64a4d-160a-4b09-ae0c-e2c3cec121b6",
    title: "The Serpentine Wave",
    sku: "ZLRG-0006",
    category: "rings",
    gender: "female",
    price: 18015.7,
    product_url: "https://myzoori.com/product-detail/a23fe7c3-cddf-4c28-ab35-b6e481e62551",
    image_url: `${IMG}/a23fe7c3-cddf-4c28-ab35-b6e481e62551/ZLRG-0006.53-1783953669.jpg`,
  },
  {
    id: "a414727c-9084-4e1c-b4a8-0f47b0724fd4",
    title: "Industrial Sparkle/ The Urban Edge",
    sku: "ZGRG-0003",
    category: "rings",
    gender: "male",
    price: 41920.23,
    product_url: "https://myzoori.com/product-detail/a241b980-d356-496c-98ec-d5d19812b7b4",
    image_url: `${IMG}/a241b980-d356-496c-98ec-d5d19812b7b4/ZGRG-0002.468-1786446085.jpg`,
  },
  {
    id: "9affbcd8-a29b-40df-bd27-70e38a0004db",
    title: "Onyx Skyline",
    sku: "ZGRG-0002",
    category: "rings",
    gender: "male",
    price: 52274.99,
    product_url: "https://myzoori.com/product-detail/a23feb36-bf30-438e-80f0-7185cb470277",
    image_url: `${IMG}/a23feb36-bf30-438e-80f0-7185cb470277/ZGRG-0002.468-1786446015.jpg`,
  },
  {
    id: "4ce446f1-7450-4c35-b7ef-b6c14a145393",
    title: "Tiered Vertex",
    sku: "ZGRG-0005",
    category: "rings",
    gender: "male",
    price: 49196.55,
    description: "Metal: Gold, Diamond. Gross weight: 3.05 gm",
    product_url: "https://www.myzoori.com/product-detail/a27819af-0635-460a-b118-c8d7dba202cd",
    image_url:
      "https://www.myzoori.com/storage/images/products/a27819af-0635-460a-b118-c8d7dba202cd/zgrg-0005.jpg",
  },
  {
    id: "89182ed3-5e21-4c5c-9314-fe48a87ca19e",
    title: "Milgrain Marquise/ The Heritage Band",
    sku: "ZLRG-0002",
    category: "rings",
    gender: "female",
    price: 16805.32,
    description:
      "Metal: Gold, Diamond. Gross weight: 0.85 gm. Milgrain Marquise/ The Heritage Band Yellow Gold 18K",
    product_url: "https://www.myzoori.com/product-detail/a23fb0cc-43b9-404e-a5fd-6ff17ef7d301",
    image_url:
      "https://www.myzoori.com/storage/images/products/a23fb0cc-43b9-404e-a5fd-6ff17ef7d301/zlrg-0002.jpg",
  },
  {
    id: "7235f948-fe4f-4212-812c-11452332a018",
    title: "ZTNM-0030",
    sku: "ZTNM-0030",
    category: "tanmaniya",
    price: 33419.02,
    description: "Metal: Gold, Blue Sap Round, Diamond. Gross weight: 1.83 gm",
    product_url: "https://www.myzoori.com/product-detail/a2d714f5-9e82-4407-a07a-3d75b8c3d766",
    image_url:
      "https://www.myzoori.com/storage/images/products/a2d714f5-9e82-4407-a07a-3d75b8c3d766/ztnm-303747-1790446674.jpg",
  },
  {
    id: "73f76b31-5d35-4e5c-bdd5-d6a414d78659",
    title: "ZTNM-0031",
    sku: "ZTNM-0031",
    category: "tanmaniya",
    price: 58626.03,
    description:
      "Metal: Gold, Diamond, Emerald Marquise, Ruby Pear. Gross weight: 2.80 gm. A graceful expression of traditional elegance, this Tanmaniya features delicate pear-shaped rubies and a marquise-cut emerald, beautifully accented with sparkling round diamonds.",
    product_url: "https://www.myzoori.com/product-detail/a2e679cb-ac13-402a-8f61-1ec4838de41c",
    image_url:
      "https://www.myzoori.com/storage/images/products/a2e679cb-ac13-402a-8f61-1ec4838de41c/ztnm-313761-1791277429.jpg",
  },
  {
    id: "c0c17cce-f8df-41c4-9a1e-1653c8f83e97",
    title: "ZERN-0188",
    sku: "ZERN-0188",
    category: "earrings",
    price: 48640.1,
    description:
      "Metal: Gold, Diamond, Pink Sapphire Pear. Gross weight: 2.80 gm. Discover understated luxury with the Zoori Ruby & Diamond Gold Earrings, where vibrant round rubies meet the delicate sparkle of finely set diamonds.",
    product_url: "https://www.myzoori.com/product-detail/a2e9cd3a-14e2-49be-a883-9de0c1410040",
  },
  {
    id: "26263129-0ae5-41ab-ba9c-aed5fa873571",
    title: "ZERN-0207",
    sku: "ZERN-0207",
    category: "earrings",
    price: 39295.75,
    description:
      "Metal: Gold, Diamond. Gross weight: 0.70 gm. A captivating blend of color and brilliance, the Zoori Ruby & Diamond Gold Earrings feature radiant round rubies surrounded by carefully arranged round diamonds.",
    product_url: "https://www.myzoori.com/product-detail/a2e9ce2f-b437-4559-b6d9-ac1d5d55a084",
  },
].map(product);

const byTitle = (title: string, sku?: string) =>
  PRODUCTS.find((p) => p["title"] === title && (!sku || p["sku"] === sku))!;

/** Real website text (knowledge_chunks), retrieved by the words a question uses. */
const CHUNKS: Array<{ when: RegExp; title: string; ref: string; text: string }> = [
  {
    when: /zoori|who|special|about|kya hai zoori/i,
    title: "About Zoori | Trusted Jewellery & Expert Craftsmanship",
    ref: "https://www.myzoori.com/about-us",
    text: "Zoori is a contemporary jewellery brand built on certified diamonds, real gemstones, and gold you can trust. Every piece is BIS-hallmarked, certified, and priced exactly as it costs no showroom markup, no manufactured urgency. The brand operates under 3 Key Promises: Lifelong Maintenance Free, 20-Day Returns, and Certified, Real, Always.",
  },
  {
    when: /return|refund|wapas|exchange|maintenance|deliver|shipping|din\b/i,
    title: "About Zoori | Trusted Jewellery & Expert Craftsmanship",
    ref: "https://www.myzoori.com/about-us",
    text: "3 Key Promises Lifelong Maintenance Free. Forever. No charge, no time limit, no fine print. 20-Day Returns No questions asked — a piece you don't love doesn't belong in your life. Certified, Real, Always Certified real diamonds, real gemstones, and thoughtfully crafted gold — nothing else.",
  },
  {
    when: /return|deliver|shipping|din\b|emi|pay/i,
    title: "ZPND-0127 || ZPND-0127",
    ref: "https://www.myzoori.com/product-detail/a2e9cd3a-zpnd-0127",
    text: "ZPND-0127 ₹36,271.57 Metal: Gold, Diamond Gross weight: 1.74 gm Customize this product Add to Cart 20-Day Free Returns Free Shipping on All Orders Gift Packaging Available Lifelong Maintenance",
  },
  {
    when: /chevron|serpentine/i,
    title: "MyZoori | Modern & Elegant Online Jewellery in India",
    ref: "https://www.myzoori.com/",
    text: "ZERN-0183 ₹46,583.12 The Serpentine Wave ₹18,015.70 ZTNM-0030 ₹33,419.02 The Gilded Chevron ₹19,603.91 ZPND-0064 ₹32,607.78 Glimmer Medusa ₹23,139.32",
  },
  {
    when: /contact|phone|number|call/i,
    title: "Contact MyZoori | Get in Touch With Our Jewellery Team",
    ref: "https://www.myzoori.com/contact-us",
    text: "Contact Us We're here to help. Choose your preferred contact option Chat With Us Send An Email Call Us 📞 +91-1234567890 ✉ myzoori.com",
  },
];

// ------------------------------------------------------------------ model

export type ToolSeen = { name: string; data: unknown };
export type ModelCtx = {
  step: number;
  system: string;
  offers: (tool: string) => boolean;
  /** Every tool result so far, oldest first, parsed. */
  seen: ToolSeen[];
};
export type Turn = {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
};

type Facts = Record<string, unknown>;
/** The products a catalogue result carried, whatever shape this build gives the model. */
export function productsIn(seen: ToolSeen[]): Facts[] {
  for (const s of [...seen].reverse()) {
    if (s.name !== "catalog_search") continue;
    const d = s.data as unknown;
    if (Array.isArray(d)) return d as Facts[];
    const closest = (d as { closest_above?: Facts[] } | null)?.closest_above;
    if (Array.isArray(closest)) return closest;
  }
  return [];
}
const idOf = (f: Facts) => String(f["product_id"] ?? f["id"]);
/** The price string the run gave the model: "₹19,604" in facts, the raw number otherwise. */
const priceOf = (f: Facts) =>
  typeof f["price"] === "string"
    ? (f["price"] as string)
    : `₹${new Intl.NumberFormat("en-IN").format(Number(f["price"]))}`;
const linkOf = (f: Facts) => String(f["link"] ?? f["product_url"] ?? "");
const nameOf = (f: Facts) => String(f["name"] ?? f["title"]);
const lookedUp = (ctx: ModelCtx) => ctx.system.includes("look it up with catalog_search");
/** A caption the way Zoori's instructions ask: name, price and link. */
const caption = (f: Facts) => `${nameOf(f)} — ${priceOf(f)}\n${linkOf(f)}`;
/** The reply-to product the run told the model about, if any. */
function replyProduct(system: string): Facts | null {
  const m = system.match(/means this product: (\{.*\})/);
  return m ? (JSON.parse(m[1]!) as Facts) : null;
}
/** Zoori's "Buying" instructions, answered from the facts the model was given. */
function buyingReply(f: Facts, hinglish = false): string {
  const ring = f["category"] === "rings";
  const lines = hinglish
    ? [
        `Badhiya choice! ${nameOf(f)} ${priceOf(f)} ka hai.`,
        `Aap ise online order kar sakte hain: ${linkOf(f)}${ring ? " (ring size checkout par)" : ""}, ya hamari team yahin WhatsApp par size aur payment confirm kar degi.`,
      ]
    : [
        `Great choice — ${nameOf(f)} is ${priceOf(f)}.`,
        `You can order online at ${linkOf(f)}${ring ? " (ring size chosen at checkout)" : ""}, or our team can confirm size and payment right here on WhatsApp.`,
      ];
  lines.push(
    ring
      ? hinglish
        ? "Aapka ring size kya hai?"
        : "What's your ring size?"
      : hinglish
        ? "Kaunsa option theek rahega?"
        : "Which option suits you?",
  );
  return lines.join("\n");
}
/** Show 2–3 pieces with price and link, then one question (Zoori's "Showing products"). */
function showTurn(ctx: ModelCtx, intro: string, closing: string, count = 3): Turn {
  const found = productsIn(ctx.seen).slice(0, count);
  if (ctx.offers("send_products")) {
    if (!ctx.seen.some((s) => s.name === "send_products")) {
      return {
        text: intro,
        calls: [
          {
            name: "send_products",
            args: { products: found.map((f) => ({ product_id: idOf(f), caption: caption(f) })) },
          },
        ],
      };
    }
    return { text: closing };
  }
  // This build attaches pictures itself; the model only writes the words.
  return {
    text: `${intro}\n${found.map((f) => `• ${nameOf(f)} — ${priceOf(f)}`).join("\n")}\n${closing}`,
  };
}

export type Case = {
  id: string;
  ask: string;
  /** Earlier messages in the chat, oldest first. */
  history?: Array<{
    direction: "inbound" | "outbound";
    type?: string;
    body: string;
    media_url?: string | null;
    meta?: string;
    metadata?: Record<string, unknown> | null;
  }>;
  /** WhatsApp reply-to: the meta id of the message the customer replied to. */
  replyTo?: string;
  model: (ctx: ModelCtx) => Turn;
  /** What this case checks beyond the checks every case gets. */
  checks?: Array<
    | "products_with_links"
    | "ring_size"
    | "guard_fired"
    | "handover"
    | "reply_to_known"
    | "text_before_pictures"
    | "list_markers_kept"
  >;
};

/** The three pictures Aiden sent at 10:13 (live), as stored. */
const LIVE_PICTURES = [
  {
    direction: "outbound" as const,
    body: "What would you like to see: rings, pendants, earrings, or bracelets?\n\nWant a different budget or style?",
  },
  {
    direction: "outbound" as const,
    type: "image",
    body: "The Gilded Chevron — ₹19,604",
    media_url: byTitle("The Gilded Chevron")["image_url"] as string,
    meta: "wamid.live.chevron",
  },
  {
    direction: "outbound" as const,
    type: "image",
    body: "Industrial Sparkle/ The Urban Edge — ₹18,326",
    media_url: byTitle("Industrial Sparkle/ The Urban Edge", "ZLRG-0003")["image_url"] as string,
    meta: "wamid.live.urban",
  },
  {
    direction: "outbound" as const,
    type: "image",
    body: "The Allure Orbit/The Willow Vine — ₹18,016",
    media_url: byTitle("The Allure Orbit/The Willow Vine")["image_url"] as string,
    meta: "wamid.live.allure",
  },
];
const SHOW_ME = [{ direction: "inbound" as const, body: "show me products" }, ...LIVE_PICTURES];

const search = (args: Record<string, unknown>): Turn => ({
  calls: [{ name: "catalog_search", args }],
});

export const CASES: Case[] = [
  {
    id: "what-is-zoori",
    ask: "what is zoori",
    // Live (gpt-5.4, 10:12): the answer, then "Item 6." — kept even when told not to.
    model: () => ({
      text: 'Zoori is a Hyderabad jewellery brand with two showrooms and an online store. It offers rings, pendants, earrings, bracelets, necklaces, chains and mangalsutra in BIS-hallmarked gold with certified diamonds and gemstones. Item 6.\n{"needs_owner": false}',
    }),
  },
  {
    id: "show-me-products",
    ask: "show me products",
    // Live on main (10:13): it searched, then asked instead of showing.
    model: (ctx) => {
      if (ctx.step === 0) return search({ limit: 5, category: "" });
      if (!ctx.offers("send_products"))
        return {
          text: 'What would you like to see: rings, pendants, earrings, or bracelets?\n\nLet me confirm that for you.\n{"needs_owner": false}',
        };
      return showTurn(
        ctx,
        "Here are a few pieces from Zoori:",
        "Do you have a budget, style or occasion in mind?",
      );
    },
    checks: ["products_with_links", "text_before_pictures"],
  },
  {
    id: "i-like-this",
    ask: "I like this",
    history: SHOW_ME,
    // Live (10:16): no reply-to, so it asks which one.
    model: () => ({
      text: 'Which one did you like — The Gilded Chevron, Industrial Sparkle, The Urban Edge, or The Allure Orbit/The Willow Vine?\n{"needs_owner": false}',
    }),
  },
  {
    id: "i-like-this-reply-to",
    ask: "I like this",
    history: SHOW_ME,
    replyTo: "wamid.live.chevron",
    model: (ctx) => {
      const p = replyProduct(ctx.system);
      if (!p)
        return {
          text: 'Which one did you like — The Gilded Chevron, Industrial Sparkle, The Urban Edge, or The Allure Orbit/The Willow Vine?\n{"needs_owner": false}',
        };
      return { text: `${buyingReply(p)}\n{"needs_owner": false}` };
    },
    checks: ["reply_to_known", "ring_size"],
  },
  {
    id: "the-gilded-chevron",
    ask: "The Gilded Chevron — ₹19,604",
    history: SHOW_ME,
    model: (ctx) => {
      if (lookedUp(ctx) && ctx.step === 0) return search({ query: "The Gilded Chevron" });
      const f = productsIn(ctx.seen)[0];
      if (f) return { text: `${buyingReply(f)}\n{"needs_owner": false}` };
      // Live (10:17): no lookup; price from the home page, ring size guessed at.
      return {
        text: 'Great choice — The Gilded Chevron is ₹19,603.91. You can order online, or our team can help you buy it here on WhatsApp. If it’s a ring, please share your ring size.\nhttps://www.myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a\n{"needs_owner": false}',
      };
    },
    checks: ["ring_size"],
  },
  {
    id: "gents-ring-under-50k",
    ask: "gents ring under 50k dikhao",
    model: (ctx) => {
      if (ctx.step === 0)
        return search({ category: "rings", gender: "male", max_price: 50000, limit: 5 });
      return showTurn(
        ctx,
        "Ye rahe 50k ke andar gents rings:",
        "Kis occasion ke liye dekh rahe hain?",
      );
    },
    checks: ["products_with_links", "text_before_pictures"],
  },
  {
    id: "return-policy-hinglish",
    ask: "return policy kya hai",
    model: () => ({
      text: 'Zoori par 20-day no-questions returns hain, aur lifelong free maintenance bhi milta hai.\nKya main aapko kuch pieces dikhaun?\n{"needs_owner": false}',
    }),
  },
  {
    id: "delivery-kitne-din",
    ask: "delivery kitne din mein hoti hai",
    // An invented delivery time: the policy check must block it.
    model: () => ({
      text: 'Shipping sabhi orders par free hai. Delivery usually 5-7 working days mein ho jaati hai.\nKya aap koi piece dekh rahe hain?\n{"needs_owner": false}',
    }),
    checks: ["guard_fired"],
  },
  {
    id: "showroom-timing",
    ask: "showroom timing?",
    model: () => ({
      text: 'We have two showrooms — Somajiguda (GF 1, Olbee Centre, Rajbhavan Road) and Bolarum, Secunderabad (GF06 Fairmount Square). The timings — let me confirm that for you.\nWhich one is closer to you?\n{"needs_owner": true}',
    }),
  },
  {
    id: "emi-hai",
    ask: "EMI hai?",
    // A guessed EMI figure: the number guard must take it out.
    model: () => ({
      text: 'Haan, EMI available hai — ₹2,000/month se shuru.\nAap kaunsa piece dekh rahe hain?\n{"needs_owner": false}',
    }),
    checks: ["guard_fired"],
  },
  {
    id: "emi-milega",
    ask: "EMI milega kya?",
    // A guessed EMI policy with no figure: the policy check must block it.
    model: () => ({
      text: 'Haan, sabhi orders par no-cost EMI milta hai.\n{"needs_owner": false}',
    }),
    checks: ["guard_fired", "handover"],
  },
  {
    id: "who-are-you",
    ask: "who are you",
    model: () => ({
      text: 'I\'m Priya from Zoori 😊 I help you find the right jewellery and answer questions about our pieces.\nWhat are you shopping for today?\n{"needs_owner": false}',
    }),
  },
  {
    id: "hindi-rings",
    ask: "मुझे सोने की अंगूठी दिखाइए",
    model: (ctx) => {
      if (ctx.step === 0) return search({ category: "rings", limit: 3 });
      return showTurn(ctx, "ये रहीं हमारी कुछ अंगूठियाँ:", "आपका बजट क्या है?", 2);
    },
    checks: ["products_with_links", "text_before_pictures"],
  },
  {
    id: "price-not-in-data",
    ask: "Petal Band ka price kya hai?",
    model: (ctx) => {
      if (ctx.step === 0) return search({ query: "Petal Band" });
      return { text: 'Petal Band ₹12,500 ka hai.\n{"needs_owner": false}' };
    },
    checks: ["guard_fired", "handover"],
  },
  {
    id: "buy-tiered-vertex",
    ask: "Tiered Vertex lena hai",
    model: (ctx) => {
      if (ctx.step === 0) return search({ query: "Tiered Vertex" });
      const f = productsIn(ctx.seen)[0]!;
      return { text: `${buyingReply(f, true)}\n{"needs_owner": false}` };
    },
    checks: ["ring_size"],
  },
  {
    id: "buy-allure-orbit-options",
    ask: "I want to buy The Allure Orbit",
    model: (ctx) => {
      if (ctx.step === 0) return search({ query: "Allure Orbit" });
      const f = productsIn(ctx.seen)[0]!;
      return {
        text: `Lovely pick — ${nameOf(f)} is ${priceOf(f)}.\n(1) Order online at ${linkOf(f)} — ring size is chosen at checkout.\n(2) Our team confirms size and payment right here on WhatsApp.\nWhat's your ring size?\n{"needs_owner": false}`,
      };
    },
    checks: ["ring_size", "list_markers_kept"],
  },
  {
    id: "earrings-no-photos",
    ask: "earrings dikhao",
    model: (ctx) => {
      if (ctx.step === 0) return search({ category: "earrings", limit: 3 });
      return showTurn(ctx, "Ye rahe kuch earrings:", "Kis budget mein dekh rahe hain?", 2);
    },
    checks: ["products_with_links"],
  },
  {
    id: "earrings-live-args",
    ask: "earrings dikhao",
    // Live, 6 Oct 11:18 (run 4f97dcee…): gpt-5.4 sent these exact arguments —
    // a gender and a stock filter nobody asked for. Every Zoori earring is
    // untagged for gender and has no photo.
    model: (ctx) => {
      if (ctx.step === 0)
        return search({
          limit: 3,
          query: "",
          gender: "female",
          category: "earrings",
          max_price: null,
          availability: "in_stock",
        });
      if (productsIn(ctx.seen).length === 0)
        return {
          text: "I’m not seeing earrings in the catalogue right now. A colleague will follow up with options for you.",
        };
      return showTurn(ctx, "Ye rahe kuch earrings:", "Kis budget mein dekh rahe hain?", 2);
    },
    checks: ["products_with_links"],
  },
  {
    id: "rings-dikhao",
    ask: "rings dikhao",
    // A wide ring browse: the shelf match "%rings%" also matched "earrings".
    // The model names everything it was given, so a stray earring shows.
    model: (ctx) => {
      if (ctx.step === 0) return search({ category: "rings", limit: 10 });
      const found = productsIn(ctx.seen);
      return {
        text: `Hamare rings: ${found.map((f) => nameOf(f)).join(", ")}.\nKaunsa pasand aaya?\n{"needs_owner": false}`,
      };
    },
  },
  {
    id: "tanmaniya-under-20k",
    ask: "tanmaniya under 20k",
    model: (ctx) => {
      if (ctx.step === 0) return search({ category: "tanmaniya", max_price: 20000, limit: 3 });
      const closest = productsIn(ctx.seen);
      if (ctx.offers("send_products")) {
        if (!ctx.seen.some((s) => s.name === "send_products")) {
          const from = (ctx.seen.at(-1)!.data as { lowest_price?: string }).lowest_price;
          return {
            text: `We don't have tanmaniya under ₹20,000 right now — ours start at ${from}. Here are the closest:`,
            calls: [
              {
                name: "send_products",
                args: {
                  products: closest
                    .slice(0, 2)
                    .map((f) => ({ product_id: idOf(f), caption: caption(f) })),
                },
              },
            ],
          };
        }
        return {
          text: 'Would you like to see these, or a different budget?\n{"needs_owner": false}',
        };
      }
      return {
        text: 'I don\'t have tanmaniya under ₹20,000 right now. Want to see the closest ones?\n{"needs_owner": false}',
      };
    },
    checks: ["products_with_links", "text_before_pictures"],
  },
  {
    id: "caption-price-and-link-checked",
    ask: "ladies ring 30k ke andar",
    // A sloppy model: paise in one caption, a wrong price and a wrong link in another.
    model: (ctx) => {
      if (ctx.step === 0)
        return search({ category: "rings", gender: "female", max_price: 30000, limit: 5 });
      const found = productsIn(ctx.seen);
      const architect = found.find((f) => String(f["title"]) === "The Architect")!;
      const chevron = found.find((f) => String(f["title"]) === "The Gilded Chevron")!;
      if (ctx.offers("send_products")) {
        if (!ctx.seen.some((s) => s.name === "send_products")) {
          return {
            text: "Ye rahe 30k ke andar ladies rings:",
            calls: [
              {
                name: "send_products",
                args: {
                  products: [
                    {
                      product_id: idOf(chevron),
                      caption: `The Gilded Chevron — ₹19,603.91\n${linkOf(chevron)}`,
                    },
                    {
                      product_id: idOf(architect),
                      caption:
                        "The Architect — ₹26,000\nhttps://myzoori.com/products/the-architect",
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: 'Kaunsa design pasand aaya?\n{"needs_owner": false}' };
      }
      return {
        text: `Ye rahe 30k ke andar ladies rings:\n• The Gilded Chevron — ₹19,603.91\n• The Architect — ₹26,000\nKaunsa design pasand aaya?\n{"needs_owner": false}`,
      };
    },
    checks: ["products_with_links"],
  },
  {
    id: "citations-leak",
    ask: "what makes zoori special?",
    model: () => ({
      text: 'Every piece is BIS-hallmarked with certified diamonds [1], and there\'s no showroom markup (Source: About Zoori).\nWant to see some rings?\n{"needs_owner": false}',
    }),
  },
  {
    id: "flow-picture-reply-to",
    ask: "is this available in white gold?",
    // The customer replied to a picture the "Show products" flow sent (no product id stored on it).
    history: [
      { direction: "inbound", body: "rings" },
      {
        direction: "outbound",
        type: "image",
        body: "Tiered Vertex — ₹49,197\nhttps://www.myzoori.com/product-detail/a27819af-0635-460a-b118-c8d7dba202cd",
        media_url: byTitle("Tiered Vertex")["image_url"] as string,
        meta: "wamid.flow.tiered",
        metadata: { kind: "flow_v2", run_id: "run-x", node_id: "n2" },
      },
    ],
    replyTo: "wamid.flow.tiered",
    model: (ctx) => {
      const p = replyProduct(ctx.system);
      if (!p)
        return {
          text: 'Which piece do you mean? Could you share its name?\n{"needs_owner": false}',
        };
      return {
        text: `${nameOf(p)} is in ${String(p["metal"] ?? "gold")} with ${String((p["stones"] as string[] | undefined)?.join(", ") ?? "diamonds").toLowerCase()}, ${String(p["weight"] ?? "")}. For white gold, let me confirm that for you.\nWould you like to see similar rings meanwhile?\n{"needs_owner": true}`,
      };
    },
    checks: ["reply_to_known"],
  },
];

// ------------------------------------------------------------------ world

export type Sent = { type: string; text: string; link?: string | null };
export type Replay = {
  sent: Sent[];
  status: string | null;
  escalation: string | null;
  error?: string;
  gapFiled: boolean;
  /** What the model was told (system prompt), per call, for the checks. */
  systems: string[];
  toolsOffered: string[];
  /** The answer run's metadata.tools (Batch 14.1), when the build writes it. */
  toolsMeta?: unknown;
};

const POLICY_CHECK = "You check whether sentences";

/** A tool result as the model got it; a view cut short (main cuts at 6,000 characters) reads as nothing. */
function parseToolView(content: string): unknown {
  try {
    return (JSON.parse(content) as { data?: unknown }).data;
  } catch {
    return { unreadable: content.length };
  }
}

/** The policy model check: "yes" only when most of a sentence's words are in the sources. */
function judge(body: { messages: Array<{ content: unknown }> }): string {
  const input = String(body.messages.at(-1)?.content ?? "");
  const sources = (input.split("SENTENCES:")[0] ?? "").toLowerCase();
  const sentences = (input.split("SENTENCES:")[1] ?? "")
    .split("\n")
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => l.replace(/^\d+\. /, ""));
  const answers = sentences.map((s) => {
    const words = s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4);
    const hit = words.filter((w) => sources.includes(w)).length;
    return words.length && hit / words.length >= 0.7 ? "yes" : "no";
  });
  return JSON.stringify({ answers });
}

/**
 * One customer message through runAgentOnInbound against the Zoori world.
 * `fetch` must be stubbed by the caller with the returned `fetchStub`.
 */
export function zooriWorld(c: Case) {
  const now = Date.UTC(2026, 9, 6, 10, 20, 0);
  const messages: Row[] = [];
  const at = (i: number) => new Date(now - (100 - i) * 1000).toISOString();
  (c.history ?? []).forEach((m, i) =>
    messages.push({
      id: `m${i}`,
      organization_id: ORG,
      conversation_id: CONV,
      direction: m.direction,
      type: m.type ?? "text",
      body: m.body,
      media_url: m.media_url ?? null,
      meta_message_id: m.meta ?? `wamid.h${i}`,
      metadata: m.metadata ?? null,
      created_at: at(i),
    }),
  );
  messages.push({
    id: "m-ask",
    organization_id: ORG,
    conversation_id: CONV,
    direction: "inbound",
    type: "text",
    body: c.ask,
    meta_message_id: "wamid.ask",
    created_at: at(99),
  });
  const mem = memoryDb({ products: PRODUCTS, messages });

  let lastEmbedded = "";
  const runs: Row[] = [];
  let gapFiled = false;
  const reply = (op: FakeOp) => {
    const t = op.table;
    if (t === "ai_agents") return { data: { id: "agent-zoori", mode: "replying" }, error: null };
    // The AI role's permissions, for runs that use the real tool broker (the speed bench).
    if (t === "role_permissions")
      return { data: [{ permission_key: "ai.use" }, { permission_key: "catalog.view" }], error: null };
    if (t === "organization_ai_settings")
      return {
        data: {
          ai_enabled: true,
          ai_monthly_cap_amount: 1000,
          currency: "INR",
          ai_markup_multiplier: 3,
          agent_role: "ai_agent",
        },
        error: null,
      };
    if (t === "platform_settings")
      return {
        data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 },
        error: null,
      };
    if (t === "conversations")
      return {
        data: {
          id: CONV,
          contact_id: CONTACT,
          assigned_to: null,
          needs_human: false,
          status: "open",
          last_customer_message_at: new Date(now).toISOString(),
          contacts: { name: "Tester" },
        },
        error: null,
      };
    if (t === "ai_instructions") return { data: INSTRUCTIONS, error: null };
    if (t === "ai_tiers")
      return {
        data: {
          key: "careful",
          display_name: "Careful",
          provider: "lovable",
          model_id: "google/gemini-3.6-flash",
          is_active: true,
        },
        error: null,
      };
    if (t === "ai_models")
      return {
        data: { supports_tools: true, is_available: true, is_deprecated: false },
        error: null,
      };
    if (t === "ai_runs" && op.kind === "insert") {
      runs.push(op.payload as Row);
      return { data: { id: `run-${runs.length}` }, error: null };
    }
    if (t === "ai_runs") return { data: [], error: null };
    if (t === "pending_owner_replies" && op.kind === "insert") {
      gapFiled = true;
      return { data: { id: "gap-1" }, error: null };
    }
    return undefined;
  };
  const fake = fakeDb(reply, (call) => {
    if (call.name === "match_knowledge_chunks") {
      const rows = CHUNKS.filter((k) => k.when.test(lastEmbedded)).map((k, i) => ({
        document_id: `doc-${i}`,
        source_type: "website",
        source_name: "myzoori.com",
        source_ref: k.ref,
        title: k.title,
        text: k.text,
        similarity: 0.6 - i * 0.01,
      }));
      return { data: rows, error: null };
    }
    if (call.name === "record_ai_tool_calls")
      return { data: (call.args["p_calls"] as unknown[]).length, error: null };
    if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend")
      return { data: 0, error: null };
    return undefined;
  });
  const MEMORY = new Set(["products", "messages"]);
  const supabase = {
    from: (t: string) => (MEMORY.has(t) ? mem.supabase.from(t) : fake.supabase.from(t)),
    rpc: (n: string, a: Record<string, unknown>) => fake.supabase.rpc(n, a),
  } as unknown as typeof mem.supabase;

  const sent: Sent[] = [];
  const systems: string[] = [];
  let toolsOffered: string[] = [];
  let out = 0;
  const fetchStub = async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/embeddings")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] | string };
      lastEmbedded = Array.isArray(body.input) ? body.input.join(" ") : String(body.input ?? "");
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    }
    if (u.includes("graph.facebook.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        Record<string, unknown> | string
      >;
      const type = String(body["type"]);
      if (type === "text")
        sent.push({ type, text: String((body["text"] as Record<string, unknown>)["body"]) });
      else if (type === "image") {
        const image = body["image"] as Record<string, unknown>;
        sent.push({ type, text: String(image["caption"] ?? ""), link: String(image["link"]) });
      } else sent.push({ type, text: JSON.stringify(body[type] ?? {}) });
      out += 1;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${out}` }] }));
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{
        role: string;
        content: unknown;
        tool_call_id?: string;
        tool_calls?: Array<{ id: string; function: { name: string } }>;
      }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const system = String(body.messages[0]?.content ?? "");
    if (system.startsWith(POLICY_CHECK))
      return new Response(JSON.stringify({ choices: [{ message: { content: judge(body) } }] }));
    toolsOffered = (body.tools ?? []).map((t) => t.function.name);
    systems.push(system);
    // The tool results so far, in order, matched to the calls that asked for them.
    const names = new Map<string, string>();
    for (const m of body.messages)
      for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name);
    const seen: ToolSeen[] = body.messages
      .filter((m) => m.role === "tool")
      .map((m) => ({
        name: names.get(m.tool_call_id ?? "") ?? "",
        data: parseToolView(String(m.content)),
      }));
    const step = body.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    const turn = c.model({ step, system, offers: (n) => toolsOffered.includes(n), seen });
    const toolCalls = (turn.calls ?? []).map((call, i) => ({
      id: `call-${step}-${i}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: turn.text ?? "",
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
      }),
    );
  };

  const result = (): Replay => {
    const run = runs.find((r) => !(r["metadata"] as Record<string, unknown> | null)?.["purpose"]);
    return {
      sent,
      status: (run?.["status"] as string | undefined) ?? null,
      escalation: (run?.["escalation_signal"] as string | undefined) ?? null,
      ...(run?.["error"] ? { error: String(run["error"]) } : {}),
      gapFiled,
      systems,
      toolsOffered,
      ...((run?.["metadata"] as Record<string, unknown> | null)?.["tools"]
        ? { toolsMeta: (run!["metadata"] as Record<string, unknown>)["tools"] }
        : {}),
    };
  };
  return {
    supabase,
    fetchStub,
    result,
    args: {
      organizationId: ORG,
      conversationId: CONV,
      contactId: CONTACT,
      phoneNumberId: "pn-zoori",
      accessToken: "token",
      waId: "917981223192",
      body: c.ask,
      alreadyHandled: false,
      optedOut: false,
      ...(c.replyTo ? { replyToMetaId: c.replyTo } : {}),
    },
  };
}

// ------------------------------------------------------------------ checks

/** Every customer-visible text of one reply: messages and captions, the handover included. */
export const textsOf = (r: Replay) => r.sent.map((s) => s.text);

const withoutLinks = (t: string) => t.replace(/https?:\/\/\S+/g, " ");

/** A source reference a customer should never see. "(1) Order online…" list items are not references. */
export function referenceLeaks(text: string): string[] {
  const t = withoutLinks(text);
  const out: string[] = [];
  for (const re of [
    /\[\d{1,3}(?:[^\]\n]{0,20})?\]/g,
    /【\d+[^】]*】/g,
    /\bitems? #?\d{1,3}\b/gi,
    /\b(?:sources?|references?)\s*:/gi,
    /\(\d{1,2}\)(?=\s*(?:[.,;:!?]|$))/gm,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  ]) {
    out.push(...(t.match(re) ?? []));
  }
  return out;
}

/** Text code used to write into Aiden's replies (main @ b7f5670). */
export const FIXED_TEXTS: RegExp[] = [
  /Want a different budget or style\?/i,
  /^Our [\w ]+ start at ₹[\d,]+\.$/m,
  /^The closest we have starts at ₹[\d,]+\.$/m,
];

export const fixedTexts = (r: Replay) =>
  textsOf(r).flatMap((t) => FIXED_TEXTS.filter((re) => re.test(t)).map(String));

/** Questions in one reply (every message and caption it sent), links ignored. */
export const questionCount = (r: Replay) =>
  textsOf(r).reduce((n, t) => n + (withoutLinks(t).match(/\?/g) ?? []).length, 0);

/** Amounts in rupees that are not a real price (product, rounded or exact) or a figure the material states. */
export function inventedAmounts(r: Replay): string[] {
  const known = new Set<number>();
  for (const p of PRODUCTS) {
    known.add(Math.round(Number(p["price"])));
    known.add(Number(p["price"]));
  }
  for (const k of CHUNKS)
    for (const m of k.text.match(/₹[\d,]+(?:\.\d+)?/g) ?? [])
      known.add(Number(m.replace(/[₹,]/g, "")));
  known.add(20000);
  known.add(30000);
  known.add(50000);
  return textsOf(r).flatMap((t) =>
    (withoutLinks(t).match(/₹\s?[\d,]+(?:\.\d+)?/g) ?? []).filter(
      (m) => !known.has(Number(m.replace(/[₹,\s]/g, ""))),
    ),
  );
}

/** Prices written with paise ("₹19,603.91"). */
export const paisePrices = (r: Replay) =>
  textsOf(r).flatMap((t) => withoutLinks(t).match(/₹\s?[\d,]+\.\d{1,2}\b/g) ?? []);

export const productLinks = new Map(PRODUCTS.map((p) => [String(p["product_url"]), p]));
