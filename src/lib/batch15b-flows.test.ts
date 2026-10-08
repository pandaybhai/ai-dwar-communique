import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import { PRODUCTS } from "./test-support/zoori-replay";
import { productQueryOf, validateGraph, type FlowGraph } from "./flow-graph";
import { keywordTsQuery } from "./catalog";
import { NODE_META } from "@/components/flows/v2/node-meta";

/**
 * Batch 15B — the flows "Show products" step's newer settings: photos first,
 * readable names for coded products, a keyword (fixed or {{variable}}) and the
 * order (cheapest / spread across budget / newest). A step saved without them
 * sends exactly what main sent (batch14-1-flows.test.ts pins that byte for
 * byte); these tests pin what each setting changes.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["flows_v2", "catalogs"]),
}));

type Row = Record<string, unknown>;
const ORG = String(PRODUCTS[0]!["organization_id"]);
const IMG = "https://cdn.example.com";

/** Zoori's slice plus two cheap rings that have no photo (the case photos-first fixes). */
const CATALOGUE: Row[] = [
  ...PRODUCTS.map((p, i) => ({ ...p, created_at: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z` })),
  { ...PRODUCTS[0]!, id: "text-ring-1", title: "Plain Band One", sku: "ZLRG-0098", price: 9000, image_url: null, gender: null, created_at: "2026-08-01T00:00:00Z" },
  { ...PRODUCTS[0]!, id: "text-ring-2", title: "Plain Band Two", sku: "ZLRG-0099", price: 9500, image_url: "", gender: null, created_at: "2026-08-02T00:00:00Z" },
];

async function show(data: Record<string, unknown>, vars: Record<string, string> = {}, rows: Row[] = CATALOGUE) {
  const { showProducts } = await import("./flow-products.server");
  const sent: Array<Record<string, unknown>> = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.b15.${++n}` }] }));
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  const db = memoryDb({ products: rows });
  const result = await showProducts(db.supabase, {
    organizationId: ORG,
    contactId: "c1",
    conversationId: "cv1",
    to: "919800000099",
    phoneNumberId: "pn",
    accessToken: "tok",
    windowOpen: true,
    metadata: { kind: "flow_v2", run_id: "run-1", node_id: "n1" },
    query: productQueryOf(data, { vars, contact: {} } as never),
  });
  vi.unstubAllGlobals();
  const images = sent.filter((m) => m["type"] === "image").map((m) => String((m["image"] as Row)["caption"]));
  const texts = sent.filter((m) => m["type"] === "text").map((m) => String((m["text"] as Row)["body"]));
  return { result, sent, images, texts };
}

afterEach(() => vi.unstubAllGlobals());

describe("productQueryOf — newer settings only when set", () => {
  it("a step saved before 15B reads exactly as before (no new keys)", () => {
    expect(productQueryOf({ category: "Rings", budget: "", max_items: 3 }, { vars: {}, contact: {} } as never)).toEqual({
      category: "Rings",
      minPrice: null,
      maxPrice: null,
      limit: 3,
    });
  });
  it("keyword (with {{variable}}), sort and the two switches", () => {
    expect(
      productQueryOf(
        { category: "rings", keyword: "{{stones}}", sort: "spread", photos_first: true, readable_names: true },
        { vars: { stones: "Ruby" }, contact: {} } as never,
      ),
    ).toEqual({ category: "rings", minPrice: null, maxPrice: null, limit: 5, keyword: "Ruby", sort: "spread", photosFirst: true, readableNames: true });
    // "Cheapest first" is the default, so it is not stored as a setting.
    expect(productQueryOf({ sort: "cheapest", keyword: "  " }, { vars: {}, contact: {} } as never)).toEqual({ category: "", minPrice: null, maxPrice: null, limit: 5 });
  });
  it("keyword as a full-text query: commas/“or” are choices, words within one are all needed", () => {
    expect(keywordTsQuery("Ruby")).toBe("(ruby:*)");
    expect(keywordTsQuery("Ruby, Pearl")).toBe("(ruby:*) | (pearl:*)");
    expect(keywordTsQuery("pink sapphire or emerald")).toBe("(pink:* & sapphire:*) | (emerald:*)");
    expect(keywordTsQuery("—")).toBe("");
  });
  it("a new step from the palette starts with photos first and readable names on", () => {
    expect(NODE_META.show_products.defaults()).toMatchObject({ photos_first: true, readable_names: true });
  });
  it("an unset {{variable}} in the keyword is caught on publish", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "s", type: "start", position: { x: 0, y: 0 }, data: {} },
        { id: "p", type: "show_products", position: { x: 0, y: 0 }, data: { keyword: "{{stones}}", max_items: 5 } },
      ],
      edges: [{ id: "e", source: "s", target: "p" }],
    } as never;
    expect(validateGraph(graph).some((p) => p.message.includes("{{stones}}"))).toBe(true);
  });
});

describe("Show products — photos first", () => {
  it("before: the cheapest rings include text-only ones even though photos exist", async () => {
    const before = await show({ category: "rings", max_items: 3 });
    expect(before.texts.join("\n")).toMatch(/Plain Band One/);
    expect(before.images).toHaveLength(1);
  });
  it("after: three rings with a photo, cheapest first; no text-only ring", async () => {
    const after = await show({ category: "rings", max_items: 3, photos_first: true });
    expect(after.images).toEqual([
      `Milgrain Marquise/ The Heritage Band — ₹16,805\n${String(PRODUCTS.find((p) => p["sku"] === "ZLRG-0002")!["product_url"])}`,
      expect.stringMatching(/^The Allure Orbit\/The Willow Vine — ₹18,016/),
      expect.stringMatching(/^The Serpentine Wave — ₹18,016/),
    ]);
    expect(after.texts).toEqual([]);
    expect(after.result).toEqual({ ok: true, found: true, shown: 3, error: null });
  });
  it("text-only products fill only when there aren't enough with a photo", async () => {
    // Batch 16 (c): Zoori's two earrings are code-only ("ZERN-0207") with no
    // photo — they are never sent now, so the step takes its none path.
    const earrings = await show({ category: "earrings", max_items: 3, photos_first: true });
    expect(earrings.images).toEqual([]);
    expect(earrings.texts).toEqual([]);
    expect(earrings.result).toEqual({ ok: true, found: false, shown: 0, error: null });
    // The fill itself is unchanged: a real-named product without a photo fills a place photos can't.
    const { pickProducts } = await import("./flow-products.server");
    const rows = [
      { title: "Plain Band", image_url: null },
      { title: "Photo Ring", image_url: "https://x/1.jpg" },
    ];
    expect(pickProducts(rows, { category: "", minPrice: null, maxPrice: null, limit: 2, photosFirst: true }).map((r) => r["title"])).toEqual([
      "Photo Ring",
      "Plain Band",
    ]);
  });
});

describe("Show products — readable names", () => {
  it("a coded title is shown name first, then the code", async () => {
    const off = await show({ category: "tanmaniya", max_items: 2 });
    expect(off.images[0]).toMatch(/^ZTNM-0030 — ₹33,419/);
    const on = await show({ category: "tanmaniya", max_items: 2, readable_names: true });
    expect(on.images).toEqual([
      // Batch 20: names built from the shop's own first labelled line.
      expect.stringMatching(/^Gold, Blue Sap Round & Diamond Tanmaniya \(ZTNM-0030\) — ₹33,419/),
      expect.stringMatching(/^Gold, Diamond & Emerald Marquise Tanmaniya \(ZTNM-0031\) — ₹58,626/),
    ]);
    // A real name is never touched.
    const rings = await show({ category: "rings", max_items: 1, readable_names: true });
    expect(rings.texts[0] ?? rings.images[0]).toMatch(/^Plain Band One/);
  });
  it("text-only lines use the readable name too", async () => {
    // Batch 16 (c): a code-only title with no photo is skipped even when a
    // readable name could be made for it (was: "Zoori Ruby & Diamond Gold
    // Earrings (ZERN-0207) — ₹39,295" as a text line).
    const r = await show({ category: "earrings", max_items: 2, readable_names: true });
    expect(r.texts).toEqual([]);
    expect(JSON.stringify(r.sent)).not.toMatch(/ZERN-0207|ZERN-0188/);
  });
});

describe("Show products — keyword", () => {
  it("{{stones}} = Ruby → only products whose words say ruby", async () => {
    const r = await show({ category: "", keyword: "{{stones}}", max_items: 5 }, { stones: "Ruby" });
    // The tanmaniya's materials line and both earrings' descriptions name rubies; no ring does.
    expect(r.images).toEqual([expect.stringMatching(/^ZTNM-0031 — ₹58,626/)]);
    // Batch 16 (c): the two code-only earrings without a photo are no longer sent as text.
    expect(r.texts).toEqual([]);
    expect(JSON.stringify(r.sent)).not.toMatch(/Gilded|Onyx|ZTNM-0030/);
  });
  it("several choices: Pink Sapphire, Emerald", async () => {
    const r = await show({ keyword: "Pink Sapphire, Emerald", max_items: 5, readable_names: true });
    expect([...r.images, ...r.texts].join("\n")).toMatch(/ZTNM-0031/);
    // Batch 16 (c): ZERN-0188 matches but is code-only with no photo — skipped.
    expect([...r.images, ...r.texts].join("\n")).not.toMatch(/ZERN-0188/);
    expect([...r.images, ...r.texts].join("\n")).not.toMatch(/ZERN-0207|Gilded/);
  });
  it("nothing has the word → the 'None match' path, nothing sent", async () => {
    const r = await show({ category: "rings", keyword: "Pearl", max_items: 5 });
    expect(r.result).toEqual({ ok: true, found: false, shown: 0, error: null });
    expect(r.sent).toEqual([]);
  });
  it("nothing in the budget → the closest ones still have the word, and the intro says so", async () => {
    const r = await show({ category: "tanmaniya", keyword: "Ruby", budget: "Under 20k", max_items: 3 });
    expect(r.result.found).toBe(false);
    expect(r.texts[0]).toBe("We don't have ruby tanmaniya under ₹20,000 right now — our ruby tanmaniya start at ₹58,626. Here is the closest one:");
    expect(r.images).toEqual([expect.stringMatching(/^ZTNM-0031/)]);
  });
  it("a blank keyword (variable never answered) is today's behaviour", async () => {
    const blank = await show({ category: "rings", keyword: "{{stones}}", max_items: 3 }, { stones: "" });
    const plain = await show({ category: "rings", max_items: 3 });
    expect(blank.sent).toEqual(plain.sent);
  });
});

describe("Show products — order", () => {
  it("spread across budget: cheapest, dearest and between — not the five cheapest", async () => {
    const cheapest = await show({ category: "rings", max_items: 3, photos_first: true });
    const spread = await show({ category: "rings", max_items: 3, photos_first: true, sort: "spread" });
    const price = (c: string) => Number(c.match(/₹([\d,]+)/)![1]!.replace(/,/g, ""));
    // Nine rings with a photo, ₹16,805 … ₹52,275: the 1st, 5th and 9th.
    expect(spread.images.map(price)).toEqual([16805, 19604, 52275]);
    expect(cheapest.images.map(price)).toEqual([16805, 18016, 18016]);
  });
  it("spread inside a budget stays inside it", async () => {
    const r = await show({ category: "rings", max_items: 2, sort: "spread", budget: "15k-30k", photos_first: true });
    const price = (c: string) => Number(c.match(/₹([\d,]+)/)![1]!.replace(/,/g, ""));
    expect(r.images.map(price)).toEqual([16805, 26446]);
  });
  it("newest: the most recently added first", async () => {
    const r = await show({ category: "rings", max_items: 2, sort: "newest", photos_first: true });
    // Milgrain Marquise is the newest ring in the slice, then Tiered Vertex.
    expect(r.images).toEqual([expect.stringMatching(/^Milgrain Marquise/), expect.stringMatching(/^Tiered Vertex/)]);
  });
});

describe("Show products — the search Aiden uses is unchanged", () => {
  it("a default step's search arguments are exactly main's", async () => {
    const { searchArgs } = await import("./flow-products.server");
    expect(searchArgs({ category: "rings", minPrice: null, maxPrice: 20000, limit: 5 }, "rings")).toEqual({
      limit: 5,
      order: "price_asc",
      category: "rings",
      max_price: 20000,
    });
    expect(searchArgs({ category: "for him", minPrice: 30000, maxPrice: null, limit: 3 }, "")).toEqual({
      limit: 3,
      order: "price_asc",
      query: "for him",
      min_price: 30000,
    });
  });
  it("without the flows-only pool the catalogue search still caps at 25 rows", async () => {
    const { AI_TOOL_HANDLERS } = await import("./ai-tools.server");
    const many = Array.from({ length: 60 }, (_, i) => ({ ...PRODUCTS[0]!, id: `r${i}`, title: `Ring ${i}`, price: 1000 + i }));
    const db = memoryDb({ products: many });
    const ctx = { supabase: db.supabase, organizationId: ORG, actorUserId: null, initiatedBy: "ai" } as never;
    const capped = await AI_TOOL_HANDLERS["catalogSearch"]!(ctx, { limit: 60, category: "rings" });
    expect((capped.data as unknown[]).length).toBe(25);
    const pooled = await AI_TOOL_HANDLERS["catalogSearch"]!(ctx, { limit: 60, category: "rings", pool: true });
    expect((pooled.data as unknown[]).length).toBe(60);
  });
});
