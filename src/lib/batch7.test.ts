import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld, MENU_GRAPH } from "./test-support/latency-world";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import {
  imageProblem,
  outputsOf,
  parseBudget,
  productQueryOf,
  validateGraph,
  type FlowGraph,
  type RunContext,
} from "./flow-graph";
import { simReply, simStart } from "./flow-simulator";
import { productCaption, sendProductPictures } from "./product-pictures.server";
import { AI_TOOL_HANDLERS } from "./ai-tools.server";
import { budgetWords, searchArgs } from "./flow-products.server";
import { extractProduct, saveCrawledProducts, type ProductDraft } from "./product-extract.server";

/**
 * Batch 7 — the Zoori flow.
 *  (1) Pictures on Message and Buttons steps: canvas, simulator, engine
 *      (Buttons → interactive header image; Message → image with caption).
 *  (2) "Show products" (no AI): the shelf and budget from the customer's
 *      answers, Aiden's catalogue search and product pictures, the nearest
 *      real option when nothing matches; paths found / none.
 *  (3) The product reader keeps prices, saves the metal/stone lines and a
 *      short description, and infers a missing shelf.
 */

const WELCOME_IMG = "https://cdn.example.com/zoori/welcome.jpg";
const ZOORI: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "welcome", type: "buttons", data: { text: "Welcome to Zoori ✨", image_url: WELCOME_IMG, buttons: [{ id: "b1", title: "Explore" }] } },
    {
      id: "cat",
      type: "list",
      data: {
        text: "What are you looking for?",
        variable: "category",
        button_text: "Choose",
        rows: ["Rings", "Pendants", "Tanmaniya", "Bracelets", "Earrings"].map((title, i) => ({ id: `r${i + 1}`, title })),
      },
    },
    {
      id: "budget",
      type: "list",
      data: {
        text: "Your budget?",
        variable: "budget",
        button_text: "Choose",
        rows: ["Under 25k", "25-50k", "50k-1L", "1L+"].map((title, i) => ({ id: `r${i + 1}`, title })),
      },
    },
    { id: "show", type: "show_products", data: { category: "{{category}}", budget: "{{budget}}", max_items: 5 } },
    { id: "more", type: "text", data: { text: "Tap any link to see more." } },
    { id: "sorry", type: "text", data: { text: "Our team will message you with options." } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e0", source: "start", target: "welcome", sourceHandle: "next" },
    { id: "e1", source: "welcome", target: "cat", sourceHandle: "b1" },
    ...["r1", "r2", "r3", "r4", "r5"].map((h) => ({ id: `c-${h}`, source: "cat", target: "budget", sourceHandle: h })),
    ...["r1", "r2", "r3", "r4"].map((h) => ({ id: `b-${h}`, source: "budget", target: "show", sourceHandle: h })),
    { id: "f", source: "show", target: "more", sourceHandle: "found" },
    { id: "n", source: "show", target: "sorry", sourceHandle: "none" },
    { id: "m", source: "more", target: "end", sourceHandle: "next" },
    { id: "s", source: "sorry", target: "end", sourceHandle: "next" },
  ],
};

const ctx = (vars: Record<string, unknown>): RunContext => ({
  vars,
  contact: { name: "Asha", phone: "919800000001", attributes: {} },
  tags: [],
  now: new Date(),
  timezone: "Asia/Kolkata",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ graph

describe("(2) budgets and the Show products query", () => {
  it.each([
    ["Under 25k", { min: null, max: 25000 }],
    ["25-50k", { min: 25000, max: 50000 }],
    ["50k-1L", { min: 50000, max: 100000 }],
    ["1L+", { min: 100000, max: null }],
    ["Under ₹25,000", { min: null, max: 25000 }],
    ["Rs 1.5 lakh and above", { min: 150000, max: null }],
    ["10k to 20k", { min: 10000, max: 20000 }],
  ])("%s → %j", (text, range) => expect(parseBudget(text)).toEqual(range));

  it("a choice without an amount is no budget at all", () => {
    expect(parseBudget("Any budget")).toBeNull();
    expect(parseBudget("")).toBeNull();
  });

  it("reads the customer's answers; explicit prices win; items clamped to 1–10", () => {
    const vars = { category: "Pendants", budget: "25-50k" };
    expect(productQueryOf({ category: "{{category}}", budget: "{{budget}}" }, ctx(vars))).toEqual({ category: "Pendants", minPrice: 25000, maxPrice: 50000, limit: 5 });
    expect(productQueryOf({ category: "Rings", budget: "{{budget}}", max_price: "40,000", max_items: 50 }, ctx(vars))).toEqual({ category: "Rings", minPrice: 25000, maxPrice: 40000, limit: 10 });
    expect(productQueryOf({ category: "", max_items: 0 }, ctx({}))).toEqual({ category: "", minPrice: null, maxPrice: null, limit: 5 });
  });

  it("paths are found / none (+ window closed), both required to publish", () => {
    const node = ZOORI.nodes.find((n) => n.id === "show")!;
    expect(outputsOf(node)).toEqual(["found", "none", "window_closed"]);
    expect(validateGraph(ZOORI)).toEqual([]);
    const noNone = { ...ZOORI, edges: ZOORI.edges.filter((e) => e.id !== "n") };
    expect(validateGraph(noNone).map((p) => p.message)).toContain("Output “none” isn't connected.");
  });

  it("a fixed budget must be readable; a {{variable}} is checked at run time; prices must be numbers", () => {
    const withShow = (data: Record<string, unknown>) => ({ ...ZOORI, nodes: ZOORI.nodes.map((n) => (n.id === "show" ? { ...n, data } : n)) });
    const msgs = (data: Record<string, unknown>) => validateGraph(withShow(data)).map((p) => p.message);
    expect(msgs({ category: "Rings", budget: "whatever" }).some((m) => m.includes("isn't a budget"))).toBe(true);
    expect(msgs({ category: "Rings", budget: "Under 25k" })).toEqual([]);
    expect(msgs({ category: "Rings", min_price: "abc" })).toContain("Prices must be numbers (or a {{variable}}).");
    expect(msgs({ category: "Rings", min_price: "50000", max_price: "20000" })).toContain("The lowest price is above the highest.");
    expect(msgs({ category: "Rings", max_items: 11 })).toContain("Show 1–10 products.");
  });
});

describe("(1) step pictures: validation", () => {
  it("https JPG/PNG (or a link without an ending) is fine; anything else is explained", () => {
    expect(imageProblem("")).toBeNull();
    expect(imageProblem(WELCOME_IMG)).toBeNull();
    expect(imageProblem("https://cdn.example.com/a.PNG?v=2")).toBeNull();
    expect(imageProblem("https://cdn.example.com/render/123")).toBeNull();
    expect(imageProblem("http://cdn.example.com/a.jpg")).toMatch(/https/);
    expect(imageProblem("https://cdn.example.com/a.webp")).toMatch(/JPG or PNG/);
    expect(imageProblem("https://cdn.example.com/a.gif")).toMatch(/JPG or PNG/);
  });

  it("a Message with a picture keeps its words within a caption's 1,024 characters", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "s", type: "start", data: {} },
        { id: "m", type: "text", data: { text: "x".repeat(1025), image_url: WELCOME_IMG } },
        { id: "e", type: "end", data: {} },
      ],
      edges: [
        { id: "1", source: "s", target: "m", sourceHandle: "next" },
        { id: "2", source: "m", target: "e", sourceHandle: "next" },
      ],
    };
    expect(validateGraph(g).map((p) => p.message)).toContain("With a picture, the message is its caption: keep it under 1,024 characters.");
    // Unchanged: the same long message without a picture is fine.
    const plain = { ...g, nodes: g.nodes.map((n) => (n.id === "m" ? { ...n, data: { text: "x".repeat(1025) } } : n)) };
    expect(validateGraph(plain)).toEqual([]);
  });

  it("unchanged: steps without a picture validate exactly as before", () => {
    expect(validateGraph(MENU_GRAPH as unknown as FlowGraph).map((p) => p.message)).toEqual(["Output “b2” isn't connected."]);
  });
});

describe("(1)+(2) simulator: the Zoori flow end to end", () => {
  it("hi → welcome picture with Explore → category → budget → products", () => {
    let s = simStart(ZOORI);
    expect(s.messages[0]).toMatchObject({ from: "bot", text: "Welcome to Zoori ✨", options: ["Explore"], image: WELCOME_IMG });
    s = simReply(ZOORI, s, "Explore");
    expect(s.messages.at(-1)).toMatchObject({ text: "What are you looking for?", options: ["Rings", "Pendants", "Tanmaniya", "Bracelets", "Earrings"] });
    s = simReply(ZOORI, s, "Pendants");
    expect(s.messages.at(-1)).toMatchObject({ text: "Your budget?", options: ["Under 25k", "25-50k", "50k-1L", "1L+"] });
    s = simReply(ZOORI, s, "Under 25k");
    const shown = s.messages.find((m) => m.kind === "note" && m.text.startsWith("Shows up to"));
    expect(shown?.text).toContain("5 Pendants under ₹25,000");
    expect(s.path).toEqual(["start", "welcome", "cat", "budget", "show", "more", "end"]);
    expect(s.done).toBe(true);
  });

  it("a Message step with a picture shows it; unchanged: without one there is none", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "s", type: "start", data: {} },
        { id: "a", type: "text", data: { text: "Our new collection", image_url: WELCOME_IMG } },
        { id: "b", type: "text", data: { text: "Plain words" } },
        { id: "e", type: "end", data: {} },
      ],
      edges: [
        { id: "1", source: "s", target: "a", sourceHandle: "next" },
        { id: "2", source: "a", target: "b", sourceHandle: "next" },
        { id: "3", source: "b", target: "e", sourceHandle: "next" },
      ],
    };
    const s = simStart(g);
    expect(s.messages[0]).toMatchObject({ text: "Our new collection", image: WELCOME_IMG });
    expect(s.messages[1]).toMatchObject({ text: "Plain words" });
    expect((s.messages[1] as { image?: string }).image).toBeUndefined();
  });
});

// ------------------------------------------------------------------ engine

const RING_ROWS = [
  { id: "p1", title: "Golden Petal", price: 19603.91, currency: "INR", category: "pendants", image_url: "https://www.myzoori.com/storage/p1.jpg", product_url: "https://www.myzoori.com/product-detail/p1", availability: "in_stock" },
  { id: "p2", title: "Pearl Pavilion", price: 23027.9, currency: "INR", category: "pendants", image_url: "https://www.myzoori.com/storage/p2.jpg", product_url: "https://www.myzoori.com/product-detail/p2", availability: "in_stock" },
  { id: "p3", title: "Neon Nectar", price: 24271.86, currency: "INR", category: "pendants", image_url: null, product_url: "https://www.myzoori.com/product-detail/p3", availability: "in_stock" },
];

/** A run of the Zoori flow waiting on `node`, with these answers so far. */
function zooriWorld(org: string, opts: { waitingAt?: string; vars?: Record<string, unknown>; products?: (op: FakeOp) => unknown[]; graph?: FlowGraph }) {
  return latencyWorld({
    org,
    rttMs: 0,
    graphMs: 0,
    waitingRun: Boolean(opts.waitingAt),
    override: (op) => {
      if (op.table === "flow_versions") return { data: { id: "ver-1", graph: opts.graph ?? ZOORI }, error: null };
      if (op.table === "flow_triggers")
        return {
          data: [{ id: "8ea5aa7c-6a2a-4f7d-bb85-000000000001", flow_id: "flow-1", kind: "keyword", config: { keywords: ["hi"], match: "exact" }, flows: { whatsapp_account_id: null } }],
          error: null,
        };
      if (op.table === "flow_runs" && op.kind === "select" && opts.waitingAt)
        return {
          data: [
            {
              id: `run-${org}`,
              organization_id: org,
              flow_id: "flow-1",
              version_id: "ver-1",
              contact_id: "c1",
              conversation_id: "cv1",
              current_node_id: opts.waitingAt,
              variables: opts.vars ?? {},
              status: "waiting",
              waiting_for: "reply",
              wake_at: new Date(Date.now() + 3600_000).toISOString(),
              steps: 4,
              started_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          error: null,
        };
      if (op.table === "products") return { data: opts.products?.(op) ?? [], error: null };
      return undefined;
    },
  });
}

async function deliver(w: ReturnType<typeof zooriWorld>, org: string, msg: Record<string, unknown>) {
  vi.stubGlobal("fetch", w.fetchStub);
  await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload(msg), new Date(Date.now() - 300).toISOString(), { storeMs: 10 });
  return w.graphSends.map((s) => s.body);
}

const listReply = (id: string, title: string) => ({ id: `wamid.${id}`, type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } }, context: { id: "wamid.prompt" } });
const runUpdates = (w: ReturnType<typeof zooriWorld>) => w.ops.filter((o) => o.table === "flow_runs" && o.kind === "update").map((o) => o.payload as Record<string, unknown>);
const filterArgs = (op: FakeOp, name: string) => op.filters.filter(([n]) => n === name).map(([, a]) => a);

describe("(1) engine: pictures on Buttons and Message steps", () => {
  it("'hi' → the welcome buttons go out with the picture as their header", async () => {
    const w = zooriWorld("o7-hi", {});
    const sends = await deliver(w, "o7-hi", { id: "wamid.hi", type: "text", text: { body: "hi" } });
    expect(sends).toHaveLength(1);
    const interactive = sends[0]!["interactive"] as Record<string, unknown>;
    expect(interactive["type"]).toBe("button");
    expect(interactive["header"]).toEqual({ type: "image", image: { link: WELCOME_IMG } });
    expect((interactive["body"] as { text: string }).text).toBe("Welcome to Zoori ✨");
    // Stored as an image message, like any picture.
    expect(w.ops.find((o) => o.table === "messages" && o.kind === "insert")?.payload).toMatchObject({ type: "image", media_url: WELCOME_IMG });
  });

  it("a Message step with a picture is one image message with the words as its caption", async () => {
    const g: FlowGraph = {
      nodes: [
        { id: "start", type: "start", data: {} },
        { id: "m", type: "text", data: { text: "Hi {{name}}, our new collection is here", image_url: WELCOME_IMG } },
        { id: "end", type: "end", data: {} },
      ],
      edges: [
        { id: "1", source: "start", target: "m", sourceHandle: "next" },
        { id: "2", source: "m", target: "end", sourceHandle: "next" },
      ],
    };
    const w = zooriWorld("o7-img", { graph: g });
    const sends = await deliver(w, "o7-img", { id: "wamid.hi2", type: "text", text: { body: "hi" } });
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: "919800000001", type: "image", image: { link: WELCOME_IMG, caption: "Hi Asha, our new collection is here" } }]);
    expect(w.ops.find((o) => o.table === "messages" && o.kind === "insert")?.payload).toMatchObject({ type: "image", metadata: { kind: "flow_v2", node_id: "m" } });
  });

  it("unchanged: steps without a picture send exactly as before", async () => {
    const w = latencyWorld({ org: "o7-plain", rttMs: 0, graphMs: 0, waitingRun: true });
    vi.stubGlobal("fetch", w.fetchStub);
    const tap = { id: "wamid.tap", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } }, context: { id: "wamid.prompt" } };
    await processWebhookPayload(w.supabase, "ev-o7-plain", inboundPayload(tap), new Date().toISOString(), { storeMs: 10 });
    expect(w.graphSends.map((s) => s.body)).toEqual([{ messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: "Browse our latest picks on our website." } }]);

    const k = latencyWorld({ org: "o7-plain-kw", rttMs: 0, graphMs: 0, waitingRun: false });
    vi.stubGlobal("fetch", k.fetchStub);
    await processWebhookPayload(k.supabase, "ev-o7-plain-kw", inboundPayload({ id: "wamid.kw", type: "text", text: { body: "menu" } }), new Date().toISOString(), { storeMs: 10 });
    expect((k.graphSends[0]!.body["interactive"] as Record<string, unknown>)["header"]).toBeUndefined();
  });
});

describe("(2) engine: Show products", () => {
  it("budget 'Under 25k' for Pendants → pictures with name, price and link, then the found path", async () => {
    const w = zooriWorld("o7-found", { waitingAt: "budget", vars: { category: "Pendants" }, products: () => RING_ROWS });
    const sends = await deliver(w, "o7-found", listReply("budget:r1", "Under 25k"));

    // Aiden's catalogue search: visible products, the pendants shelf, ≤ ₹25,000, five at most.
    const search = w.ops.find((o) => o.table === "products")!;
    expect(w.has(search, "eq", "is_visible", true)).toBe(true);
    expect(w.has(search, "ilike", "category", "%pendants%")).toBe(true);
    expect(w.has(search, "lte", "price", 25000)).toBe(true);
    expect(filterArgs(search, "gte")).toEqual([]);
    expect(w.has(search, "limit", 5)).toBe(true);

    expect(sends).toEqual([
      { messaging_product: "whatsapp", to: "919800000001", type: "image", image: { link: RING_ROWS[0]!.image_url, caption: "Golden Petal — ₹19,604\nhttps://www.myzoori.com/product-detail/p1" } },
      { messaging_product: "whatsapp", to: "919800000001", type: "image", image: { link: RING_ROWS[1]!.image_url, caption: "Pearl Pavilion — ₹23,028\nhttps://www.myzoori.com/product-detail/p2" } },
      // No picture: a plain line, never a made-up image.
      { messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: "Neon Nectar — ₹24,271\nhttps://www.myzoori.com/product-detail/p3" } },
      { messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: "Tap any link to see more." } },
    ]);
    const shown = w.ops.find((o) => o.table === "flow_run_events" && JSON.stringify(o.payload).includes("products_shown"));
    expect(JSON.stringify(shown?.payload)).toContain('"found":true');
    expect(runUpdates(w).at(-1)).toMatchObject({ status: "done" });
  });

  it("a range ('50k-1L') searches between both prices", async () => {
    const w = zooriWorld("o7-range", { waitingAt: "budget", vars: { category: "Rings" }, products: () => [] });
    await deliver(w, "o7-range", listReply("budget:r3", "50k-1L"));
    const search = w.ops.find((o) => o.table === "products")!;
    expect(w.has(search, "lte", "price", 100000)).toBe(true);
    expect(w.has(search, "gte", "price", 50000)).toBe(true);
    expect(w.has(search, "ilike", "category", "%rings%")).toBe(true);
  });

  it("nothing in the budget → the real starting price and the closest products, then the none path", async () => {
    const closest = [{ ...RING_ROWS[0]!, title: "Celestial Harmony", price: 27991.37, image_url: "https://www.myzoori.com/storage/c1.jpg", product_url: "https://www.myzoori.com/product-detail/c1" }];
    const w = zooriWorld("o7-none", {
      waitingAt: "budget",
      vars: { category: "Pendants" },
      // The budget search finds nothing; the closest-above search (no budget) finds the real cheapest.
      products: (op) => (op.filters.some(([n]) => n === "lte") ? [] : closest),
    });
    const sends = await deliver(w, "o7-none", listReply("budget:r1", "Under 25k"));
    expect(sends.map((s) => s["text"] ?? s["image"])).toEqual([
      { body: "We don't have pendants under ₹25,000 right now — our pendants start at ₹27,991. Here is the closest one:" },
      { link: "https://www.myzoori.com/storage/c1.jpg", caption: "Celestial Harmony — ₹27,991\nhttps://www.myzoori.com/product-detail/c1" },
      { body: "Our team will message you with options." },
    ]);
  });

  it("nothing on that shelf at all → nothing invented, straight to the none path", async () => {
    const w = zooriWorld("o7-empty", { waitingAt: "budget", vars: { category: "Earrings" }, products: () => [] });
    const sends = await deliver(w, "o7-empty", listReply("budget:r4", "1L+"));
    expect(sends.map((s) => s["text"])).toEqual([{ body: "Our team will message you with options." }]);
    const search = w.ops.find((o) => o.table === "products")!;
    expect(w.has(search, "gte", "price", 100000)).toBe(true);
    expect(filterArgs(search, "lte")).toEqual([]);
  });
});

describe("(2) search arguments", () => {
  it("a known shelf filters by category; another word searches by name; budgets pass through", () => {
    expect(searchArgs({ category: "Pendants", minPrice: null, maxPrice: 25000, limit: 5 }, "pendants")).toEqual({ limit: 5, category: "Pendants", max_price: 25000 });
    expect(searchArgs({ category: "Nose pins", minPrice: 1000, maxPrice: null, limit: 3 }, "")).toEqual({ limit: 3, query: "Nose pins", min_price: 1000 });
    expect(searchArgs({ category: "", minPrice: null, maxPrice: null, limit: 5 }, "")).toEqual({ limit: 5 });
    expect(budgetWords({ minPrice: 50000, maxPrice: 100000 })).toBe("between ₹50,000 and ₹1,00,000");
    expect(budgetWords({ minPrice: 100000, maxPrice: null })).toBe("from ₹1,00,000");
  });

  it("unchanged for Aiden: no min_price → no price floor, and the closest-above fallback as before", async () => {
    const db = fakeDb((op) => (op.table === "products" ? { data: [], error: null } : undefined));
    const out = await AI_TOOL_HANDLERS["catalogSearch"]!({ supabase: db.supabase, organizationId: "o", actorUserId: null, initiatedBy: "ai" }, { category: "rings", max_price: 25000 });
    expect(out).toEqual({ ok: true, found: false, data: [] });
    const [first, closest] = db.ops.filter((o) => o.table === "products");
    expect(filterArgs(first!, "gte")).toEqual([]);
    expect(db.has(first!, "lte", "price", 25000)).toBe(true);
    expect(filterArgs(closest!, "lte")).toEqual([]);
    expect(filterArgs(closest!, "gte")).toEqual([]);
  });

  it("with min_price: the floor applies to the search, never to the closest-above fallback", async () => {
    const db = fakeDb((op) => (op.table === "products" ? { data: [], error: null } : undefined));
    await AI_TOOL_HANDLERS["catalogSearch"]!({ supabase: db.supabase, organizationId: "o", actorUserId: null, initiatedBy: "ai" }, { category: "rings", min_price: 100000 });
    const [first, closest] = db.ops.filter((o) => o.table === "products");
    expect(db.has(first!, "gte", "price", 100000)).toBe(true);
    expect(closest).toBeDefined();
    expect(filterArgs(closest!, "gte")).toEqual([]);
  });
});

describe("(2) product pictures shared with Aiden", () => {
  const item = { title: "Solitaire Ring", imageUrl: "https://x.in/r.jpg", price: 1499, currency: "INR", productUrl: "https://x.in/p/r" };

  it("unchanged caption for Aiden (name — price); flows add the link", () => {
    expect(productCaption(item)).toBe("Solitaire Ring — ₹1,499");
    expect(productCaption({ ...item, price: null })).toBe("Solitaire Ring");
    expect(productCaption(item, true)).toBe("Solitaire Ring — ₹1,499\nhttps://x.in/p/r");
  });

  it("unchanged for Aiden: one image per product, failures reported, count returned", async () => {
    const db = fakeDb((op) => (op.table === "conversations" ? { data: { last_customer_message_at: new Date().toISOString() }, error: null } : undefined));
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const fail = (body["image"] as { link: string }).link.endsWith("bad.jpg");
      return new Response(JSON.stringify(fail ? { error: { message: "bad" } } : { messages: [{ id: "w1" }] }), { status: fail ? 400 : 200 });
    });
    const failures: Array<string | null> = [];
    const sent = await sendProductPictures(db.supabase, {
      organizationId: "o",
      contactId: "c",
      conversationId: "cv",
      to: "919800000001",
      phoneNumberId: "pn",
      accessToken: "tok",
      items: [item, { ...item, title: "Band", imageUrl: "https://x.in/bad.jpg", price: 900 }],
      cards: false,
      onFailure: (e) => failures.push(e),
    });
    expect(sent).toBe(1);
    expect(failures).toHaveLength(1);
    expect(bodies.map((b) => b["image"])).toEqual([
      { link: "https://x.in/r.jpg", caption: "Solitaire Ring — ₹1,499" },
      { link: "https://x.in/bad.jpg", caption: "Band — ₹900" },
    ]);
  });
});

// ------------------------------------------------------------------ reader

/** Shaped like a real myzoori.com product page (trimmed). */
function zooriPage(opts: { name: string; code: string; price: string; jsonSku?: boolean; description?: string; image?: string }) {
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        name: opts.name,
        image: [opts.image ?? ""],
        description: opts.description ?? "Sort Description",
        ...(opts.jsonSku === false ? {} : { sku: opts.code }),
        brand: { "@type": "Brand", name: "MyZoori" },
      },
    ],
  };
  return `<!doctype html><html><head><title>
    ${opts.name} || ${opts.code}
</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<meta name="description" content="">
</head><body>
<ul class="menu"><li><a href="https://www.myzoori.com/listing?categories=rings">Rings</a></li></ul>
<div class="breadcrumb-block"><a href="/">Home</a> / <span>${opts.name}</span></div>
<div class="right-content-box">
  <h1 class="main-title aboretoregular text-uppercase mb-0">
      ${opts.name}</h1>
  <p class="description-block mobile-hide m-0"></p>
  <h3 class="price-block" id="selected-metal-price">
      ${opts.price}
  </h3>
  <p class="alexandrialight metal-text">Metal:
      <span id="selected-metal-text">
          Gold, Diamond
      </span>
  </p>
  <div class="carat-block"><p class="carat-weight-text">Gross weight:<span id="gross-weight-display">
      1.13 gm</span></p></div>
  <span class="diamond-text">DIAMOND :</span><div id="diamond-quality-radios"></div>
  <select name="metal_type_id[]">${'<option data-category="SI GH" value="4">Diamond Round</option>'.repeat(20)}</select>
</div>
<section><h4>Product Short</h4><p>Description</p><p>Sort Description</p><h4>Metals</h4><p>Metal Description</p></section>
<footer>as little as ₹3001 today</footer>
</body></html>`;
}

describe("(3) the product reader on Zoori's pages", () => {
  const url = "https://myzoori.com/product-detail/a243f24d";

  it("structured data without a price: the price beside the product's heading is kept", () => {
    const draft = extractProduct(zooriPage({ name: "Golden Petal", code: "ZERN-0004", price: "₹24,662.21" }), url)!;
    expect(draft).toMatchObject({ title: "Golden Petal", price: 24662.21, imageUrl: null, sku: "ZERN-0004", category: "earrings" });
  });

  it("saves the metal / weight lines; the theme's placeholder text is never a description", () => {
    const draft = extractProduct(zooriPage({ name: "Golden Petal", code: "ZERN-0004", price: "₹24,662.21" }), url)!;
    expect(draft.description).toBe("Metal: Gold, Diamond. Gross weight: 1.13 gm");
    const real = extractProduct(
      zooriPage({ name: "The Gilded Chevron", code: "ZLRG-0001", price: "₹19,603.91", description: "Band. ZLRG-0001 yellow Gold &nbsp;Description sort", image: "https://www.myzoori.com/storage/images/products/x/ZLRG.jpg" }),
      url,
    )!;
    expect(real.description).toBe("Metal: Gold, Diamond. Gross weight: 1.13 gm. Band. yellow Gold");
    expect(real).toMatchObject({ price: 19603.91, category: "rings", imageUrl: "https://www.myzoori.com/storage/images/products/x/ZLRG.jpg" });
  });

  it.each([
    ["ZERN-0021", "earrings"],
    ["ZNEK-0003", "necklaces"],
    ["ZPND-0019", "pendants"],
    ["ZLRG-0025", "rings"],
  ])("a missing shelf comes from the item code in the page title (%s → %s)", (code, shelf) => {
    const draft = extractProduct(zooriPage({ name: "Azure Evil Eye", code, price: "₹1,03,662.68", jsonSku: false }), url)!;
    expect(draft.sku).toBeNull();
    expect(draft.category).toBe(shelf);
  });

  it("…or from the product's own name when it names one ('Curved Orbit Studs' → earrings)", () => {
    const draft = extractProduct(zooriPage({ name: "Curved Orbit Studs", code: "X-1", price: "₹45,863.63", jsonSku: false }), url)!;
    expect(draft.category).toBe("earrings");
  });

  it("unchanged: a page with a priced offer and its own category reads exactly as before (no description invented)", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Classic Band",
      category: "Rings",
      sku: "CB-1",
      image: "https://shop.in/img/cb.jpg",
      offers: { price: "1499", priceCurrency: "INR", availability: "https://schema.org/InStock" },
    })}</script></head><body>${"<p>Lovely jewellery for everyone.</p>".repeat(10)}</body></html>`;
    expect(extractProduct(html, "https://shop.in/products/cb")).toEqual({
      externalId: "https://shop.in/products/cb",
      title: "Classic Band",
      price: 1499,
      currency: "INR",
      imageUrl: "https://shop.in/img/cb.jpg",
      productUrl: "https://shop.in/products/cb",
      category: "rings",
      gender: null,
      availability: "in_stock",
      sku: "CB-1",
      brand: null,
      description: null,
    });
  });
});

describe("(3) saving what the reader found", () => {
  const draft = (patch: Partial<ProductDraft>): ProductDraft => ({
    externalId: "https://myzoori.com/product-detail/x",
    title: "Golden Petal",
    price: 24662.21,
    currency: "INR",
    imageUrl: null,
    productUrl: "https://myzoori.com/product-detail/x",
    category: "earrings",
    gender: null,
    availability: "in_stock",
    sku: "ZERN-0004",
    brand: "MyZoori",
    description: "Metal: Gold, Diamond",
    ...patch,
  });

  it("a new product is saved with its description", async () => {
    const db = fakeDb(() => undefined);
    expect(await saveCrawledProducts(db.supabase, "org", [draft({})])).toBe(1);
    expect(db.ops.find((o) => o.kind === "insert")?.payload).toMatchObject({ description: "Metal: Gold, Diamond", category: "earrings", price: 24662.21 });
  });

  it("a read that can't see a price, shelf or description keeps what the last read found", async () => {
    const db = fakeDb((op) => (op.table === "products" && op.kind === "select" ? { data: { id: "p1", source: "crawl" }, error: null } : undefined));
    await saveCrawledProducts(db.supabase, "org", [draft({ price: null, category: null, description: null })]);
    const update = db.ops.find((o) => o.kind === "update")!.payload as Record<string, unknown>;
    expect("price" in update || "category" in update || "description" in update).toBe(false);
    expect(update).toMatchObject({ title: "Golden Petal", image_url: null, sku: "ZERN-0004" });
  });

  it("unchanged: values that were read replace the old ones; shop-platform products are never touched", async () => {
    const db = fakeDb((op) => (op.table === "products" && op.kind === "select" ? { data: { id: "p1", source: "crawl" }, error: null } : undefined));
    await saveCrawledProducts(db.supabase, "org", [draft({})]);
    expect(db.ops.find((o) => o.kind === "update")!.payload).toMatchObject({ price: 24662.21, category: "earrings", description: "Metal: Gold, Diamond" });
    const shop = fakeDb((op) => (op.table === "products" && op.kind === "select" ? { data: { id: "p1", source: "shopify" }, error: null } : undefined));
    expect(await saveCrawledProducts(shop.supabase, "org", [draft({})])).toBe(0);
    expect(shop.ops.some((o) => o.kind === "update" || o.kind === "insert")).toBe(false);
  });
});
