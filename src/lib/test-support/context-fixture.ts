import {
  CATEGORY_WORDS,
  INSTRUCTIONS,
  ORG,
  ORG_ROW,
  PRODUCTS,
  productsIn,
  type Case,
  type ReplayShop,
} from "./zoori-replay";

/**
 * Test-only (Batch 29): one Zoori conversation the size of a live one, for
 * measuring what a reply sends the model. 30 earlier messages (the live chats
 * run 20–40; conversationTurns read the last 30), website material the size
 * of real crawl chunks (~1,000–1,400 characters, six matched, similarities
 * spread the way match_knowledge_chunks returns them), and a question that
 * needs both the material and one catalogue search (~0.9 tool calls per
 * reply live).
 */

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    [
      `${topic}: every Zoori piece is BIS-hallmarked and comes with a certificate for its diamonds or gemstones.`,
      "Prices on the website are the price you pay, with no showroom markup, and the same piece costs the same in both showrooms.",
      "Pieces are made in-house in Hyderabad by karigars with decades of experience, and each design is checked twice before it ships.",
      `Section ${i + 1} also explains how to read a certificate, what gross and net weight mean, and how to choose between 14K and 18K gold.`,
    ].join(" "),
  ).join(" ");

const chunk = (
  title: string,
  ref: string,
  lead: string,
  similarity: number,
  topic: string,
  size = 3,
) => ({
  when: /./,
  title,
  ref,
  similarity,
  text: `${lead} ${filler(topic, size)}`,
});

/** Six matched chunks, best first — as the live crawl stores them (long, overlapping). */
export const LONG_CHUNKS: ReplayShop["chunks"] = [
  chunk(
    "Returns & Exchange | MyZoori",
    "https://www.myzoori.com/returns",
    "20-Day Returns: no questions asked — a piece you don't love doesn't belong in your life. Rings can be exchanged for another size within 20 days; resizing after that is part of lifelong free maintenance.",
    0.62,
    "Returns",
  ),
  chunk(
    "About Zoori | Trusted Jewellery & Expert Craftsmanship",
    "https://www.myzoori.com/about-us",
    "3 Key Promises: Lifelong Maintenance Free. Forever. 20-Day Returns. Certified, Real, Always.",
    0.57,
    "About",
  ),
  chunk(
    "The Gilded Chevron || ZLRG-0001",
    "https://www.myzoori.com/products/the-gilded-chevron",
    "The Gilded Chevron ₹19,603.91 Metal: Gold, Diamond Gross weight: 2.10 gm 20-Day Free Returns Free Shipping on All Orders.",
    0.45,
    "Product",
  ),
  chunk(
    "Caring for your gold | MyZoori Journal",
    "https://www.myzoori.com/blog/gold-care",
    "Store each piece separately in a soft pouch; keep away from perfume and chlorine.",
    0.41,
    "Care",
  ),
  chunk(
    "MyZoori | Modern & Elegant Online Jewellery in India",
    "https://www.myzoori.com/",
    "ZERN-0183 ₹46,583.12 The Serpentine Wave ₹18,015.70 ZTNM-0030 ₹33,419.02 Glimmer Medusa ₹23,139.32.",
    0.38,
    "Home",
  ),
  chunk(
    "Contact MyZoori | Get in Touch",
    "https://www.myzoori.com/contact-us",
    "Contact Us — Chat With Us, Send An Email, Call Us +91-1234567890.",
    0.36,
    "Contact",
  ),
];

export const LONG_SHOP: ReplayShop = {
  org: ORG,
  products: PRODUCTS,
  orgRow: { ...ORG_ROW, branding: { category_words: CATEGORY_WORDS } },
  instructions: INSTRUCTIONS,
  chunks: LONG_CHUNKS,
  sourceName: "myzoori.com",
};

const reply = (t: string) => ({ direction: "outbound" as const, body: t });
const ask = (t: string) => ({ direction: "inbound" as const, body: t });

/** 30 earlier messages: a customer browsing, comparing and asking, as live chats go. */
export const LONG_HISTORY: NonNullable<Case["history"]> = [
  ask("hi"),
  reply(
    "Hi! I'm Priya from Zoori 😊 We make certified-diamond and real-gold jewellery in Hyderabad. What are you looking for today — rings, pendants, earrings or bracelets?",
  ),
  ask("rings"),
  reply(
    "Lovely! Here are a few rings customers love right now. Is this for yourself or a gift, and do you have a budget in mind?",
  ),
  {
    direction: "outbound",
    type: "image",
    body: "The Gilded Chevron — ₹19,604\nhttps://www.myzoori.com/products/the-gilded-chevron",
  },
  {
    direction: "outbound",
    type: "image",
    body: "Industrial Sparkle/ The Urban Edge — ₹18,326\nhttps://www.myzoori.com/products/the-urban-edge",
  },
  {
    direction: "outbound",
    type: "image",
    body: "The Allure Orbit/The Willow Vine — ₹18,016\nhttps://www.myzoori.com/products/the-allure-orbit",
  },
  ask("its for my wife, our anniversary is next month"),
  reply(
    "How special — happy anniversary in advance! 💛 For an anniversary, many couples choose a solitaire-style ring or a band with a row of diamonds. Would you like something classic or more modern?",
  ),
  ask("classic. but not too heavy, she wears it daily"),
  reply(
    "Got it — a light, classic piece for everyday wear. Our lighter rings are 1.5–2.5 gm in 18K gold, comfortable all day. Do you know her ring size? If not, our size guide helps: myzoori.com/size-guide",
  ),
  ask("i dont know her size"),
  reply(
    "No problem at all — most people don't! You can check one of her rings against our size guide at myzoori.com/size-guide, or choose any size now and exchange it within 20 days. Shall I show you a few classic everyday rings?",
  ),
  ask("yes"),
  reply("Here are three classic everyday rings in 18K gold with certified diamonds:"),
  {
    direction: "outbound",
    type: "image",
    body: "The Serpentine Wave — ₹18,016\nhttps://www.myzoori.com/products/the-serpentine-wave",
  },
  {
    direction: "outbound",
    type: "image",
    body: "Glimmer Medusa — ₹23,139\nhttps://www.myzoori.com/products/glimmer-medusa",
  },
  ask("the serpentine one is nice. is it real diamond?"),
  reply(
    "Yes — every Zoori diamond is certified and real, set in BIS-hallmarked gold. The Serpentine Wave is ₹18,016 and comes with its certificate. Would you like to see it in person at our Somajiguda or Bolarum showroom?",
  ),
  ask("where is somajiguda showroom"),
  reply(
    "Our Somajiguda showroom is at GF 1, Olbee Centre, Rajbhavan Road, near the Skoda showroom (+91 98000 00011). We also have Bolarum, Secunderabad: GF06 Fairmount Square, Ruby Block. Which is closer for you?",
  ),
  ask("somajiguda is close. what time do you open"),
  reply(
    "Let me confirm the exact timings for you — I'll have the team share them here. Meanwhile, would you like me to keep the Serpentine Wave aside for you to see?",
  ),
  ask("ok"),
  reply(
    "Done! I've noted the Serpentine Wave for you. Anything else you'd like to see — maybe a matching pendant or earrings?",
  ),
  ask("maybe earrings later"),
  reply(
    "Sure, whenever you're ready! Our studs start around ₹15,000 and pair beautifully with the Serpentine Wave.",
  ),
  ask("ok thanks"),
  reply("You're welcome! I'm right here if you have any questions 😊"),
  ask("one more thing"),
];

export const LONG_CASE: Case = {
  id: "long-chat-returns-and-rings",
  ask: "what if the ring doesnt fit her, can i return or exchange? also show me some under 20k",
  history: LONG_HISTORY,
  model: (ctx) => {
    if (ctx.step === 0)
      return {
        calls: [
          { name: "catalog_search", args: { category: "rings", max_price: 20000, limit: 3 } },
        ],
      };
    const found = productsIn(ctx.seen).slice(0, 2);
    return {
      text:
        "Rings can be exchanged for another size within 20 days; resizing after that is part of lifelong free maintenance.\n" +
        `Under 20k: ${found.map((f) => String(f["name"] ?? f["title"])).join(", ")}.\nShall I send pictures?\n{"needs_owner": false}`,
    };
  },
};

/** Roughly four characters per token (the same estimate estimateBriefCost uses). */
export const tokensOf = (chars: number) => Math.round(chars / 4);

/** What one reply sent the answer model: every request's messages and tools. */
export function inputOf(requests: string[]): {
  calls: number;
  tokens: number;
  perCall: number[];
  systemTokens: number[];
} {
  const perCall = requests.map((r) => tokensOf(r.length));
  const systemTokens = requests.map((r) => {
    const body = JSON.parse(r) as { messages?: Array<{ role: string; content: unknown }> };
    return tokensOf(String(body.messages?.find((m) => m.role === "system")?.content ?? "").length);
  });
  return {
    calls: requests.length,
    tokens: perCall.reduce((a, b) => a + b, 0),
    perCall,
    systemTokens,
  };
}
