import type { Row } from "./memory-db";
import { productsIn, type Case, type ModelCtx, type ReplayShop, type Turn } from "./zoori-replay";

/**
 * Test-only (Batch 20): a shop that sells nothing like jewellery — an
 * apparel store priced in US dollars, with its own categories and its own
 * words for two of them. Every name, number and address here is made up.
 * Run through the same replay world as Zoori (zooriWorld(case, APPAREL)),
 * so product search, the answer guards, captions and prices are checked for
 * a second kind of business.
 */

export const APPAREL_ORG = "0a9e1c55-0000-4000-8000-00000000a9e1";

/** The shop's own words for its categories (organizations.branding.category_words). */
export const APPAREL_WORDS: Record<string, string[]> = {
  "T-Shirts": ["tees", "tee"],
  Sneakers: ["trainers", "kicks"],
};

const product = (r: Partial<Row> & { id: string; title: string; price: number; category: string }, i: number): Row => ({
  organization_id: APPAREL_ORG,
  is_visible: true,
  currency: "USD",
  availability: "in_stock",
  source: "manual",
  external_id: null,
  meta_synced_at: null,
  gender: null,
  description: null,
  compare_at_price: null,
  sku: null,
  image_url: `https://shop.example.com/img/${r.id}.jpg`,
  product_url: `https://shop.example.com/p/${r.id}`,
  updated_at: new Date(Date.UTC(2026, 9, 6, 9, 0, 0) - i * 60_000).toISOString(),
  ...r,
});

export const APPAREL_PRODUCTS: Row[] = [
  { id: "ap-tee-1", title: "Everyday Crew Tee", category: "T-Shirts", price: 24, description: "Material: Organic cotton. Fit: Regular." },
  { id: "ap-tee-2", title: "Striped Boat Neck Tee", category: "T-Shirts", price: 32, description: "Material: Cotton, Linen. Fit: Relaxed." },
  { id: "ap-tee-3", title: "AT-0207", sku: "AT-0207", category: "T-Shirts", price: 19, description: "Material: Organic cotton. Fit: Slim." },
  { id: "ap-jeans-1", title: "Straight Leg Jeans", category: "Jeans", price: 79 },
  { id: "ap-jeans-2", title: "Wide Leg Jeans", category: "Jeans", price: 89 },
  { id: "ap-snk-1", title: "Court Classic Sneakers", category: "Sneakers", price: 95 },
  { id: "ap-snk-2", title: "Trail Runner", category: "Sneakers", price: 140 },
  { id: "ap-jkt-1", title: "Quilted Field Jacket", category: "Men's Jackets", price: 180 },
  { id: "ap-jkt-2", title: "Rain Shell", category: "Women's Jackets", price: 150 },
  // A product whose own category has a word a jeweller would use.
  { id: "ap-ring-1", title: "Ring Light Tote", category: "Bags", price: 45 },
].map((r, i) => product(r, i));

export const APPAREL: ReplayShop = {
  org: APPAREL_ORG,
  products: APPAREL_PRODUCTS,
  orgRow: { id: APPAREL_ORG, branding: { category_words: APPAREL_WORDS } },
  instructions: {
    persona_name: "Sam from Northwind Apparel",
    tone: "friendly",
    languages: ["en"],
    escalation_rules: "Customer wants to talk to a person or asks for a refund.",
    handover_message: "Let me get someone from the team to help.",
    working_hours_behaviour: "always",
    instructions:
      "You are Northwind Apparel's assistant on WhatsApp (a made-up test shop). Reply in 2–3 short lines. When a customer wants to see products, show 2–3 with price and link, then ask one question.",
  },
  chunks: [],
  sourceName: "shop.example.com",
};

const idOf = (f: Record<string, unknown>) => String(f["product_id"] ?? f["id"]);
const caption = (f: Record<string, unknown>) =>
  `${String(f["name"] ?? f["title"])} — ${String(f["price"])}\n${String(f["link"] ?? "")}`;

/** Search, then send what was found with name, price and link, then one question. */
function browse(args: Record<string, unknown>, intro: string, closing: string) {
  return (ctx: ModelCtx): Turn => {
    if (ctx.step === 0) return { calls: [{ name: "catalog_search", args }] };
    const found = productsIn(ctx.seen).slice(0, 3);
    if (!ctx.seen.some((s) => s.name === "send_products") && found.length) {
      return {
        text: intro,
        calls: [{ name: "send_products", args: { products: found.map((f) => ({ product_id: idOf(f), caption: caption(f) })) } }],
      };
    }
    return { text: `${closing}\n{"needs_owner": false}` };
  };
}

export const APPAREL_CASES: Case[] = [
  {
    id: "tees",
    ask: "show me your tees",
    // The shop's own word for T-Shirts.
    model: browse({ category: "tees", limit: 3 }, "Here are a few tees:", "Which size do you wear?"),
  },
  {
    id: "trainers-under-100",
    ask: "trainers under 100",
    model: browse({ category: "trainers", max_price: 100, limit: 3 }, "Trainers under $100:", "Want them in another colour?"),
  },
  {
    id: "jackets-for-him",
    ask: "jackets for him",
    model: browse({ category: "Men's Jackets", gender: "male", limit: 3 }, "Here's what we have:", "What size are you?"),
  },
  {
    id: "necklaces",
    ask: "do you sell necklaces?",
    // Not a category here: the search says so; the model says so too.
    model: (ctx) => {
      if (ctx.step === 0) return { calls: [{ name: "catalog_search", args: { category: "necklaces", limit: 3 } }] };
      return { text: 'We don\'t sell necklaces — we\'re a clothing shop.\nCan I show you some tees?\n{"needs_owner": false}' };
    },
  },
  {
    id: "jeans-under-20",
    ask: "jeans under 20",
    // Nothing that cheap: the closest above. The model also offers sneakers,
    // which nobody asked about and the search never returned.
    model: (ctx) => {
      if (ctx.step === 0) return { calls: [{ name: "catalog_search", args: { category: "Jeans", max_price: 20, limit: 3 } }] };
      const found = productsIn(ctx.seen);
      return {
        text: `Our jeans start at ${String(found[0]?.["price"] ?? "")}. Want to see our sneakers instead?\n{"needs_owner": false}`,
      };
    },
  },
];
