import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import { outputsOf, validateGraph, WHATSAPP_SHOP_REQUIRED, type FlowGraph, type NodeType } from "./flow-graph";
import { simReply, simStart } from "./flow-simulator";
import { NODE_META } from "@/components/flows/v2/node-meta";
import { FEATURES, navFeatures } from "./feature-registry";
import {
  productSourceWords,
  productsSummaryLine,
  whatsappShopState,
  WHATSAPP_SHOP_CONNECTED_STATUSES,
} from "./catalog";
import { whatsappShopConnected } from "./whatsapp-catalog.server";
import {
  extractProduct,
  fillMissingPhotos,
  productPagePhoto,
  saveCrawledProducts,
  type ProductDraft,
} from "./product-extract.server";
import { AI_TOOL_HANDLERS } from "./ai-tools.server";
import { productCaption } from "./product-pictures.server";

/**
 * Batch 9 — Products wording, WhatsApp shop guard, product photos, campaign
 * totals. Wording changes only: node types, routes, tables and API shapes are
 * exactly as before, so every saved flow keeps loading, validating and running.
 * (Publish route, campaign totals and catalogue sync: batch9-server.test.ts.)
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The live published graphs (Oct 2026), as stored. Only the welcome picture's
// address is swapped for a neutral one.
const WELCOME_PNG = "https://cdn.example.com/zoori/welcome.png";
const ZOORI_LIVE: FlowGraph = {
  meta: {},
  edges: [
    { id: "emuuxeb2eo", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux8kg1b" },
    { id: "emuuxeccpp", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux98jqc" },
    { id: "emuuxee0vq", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux9gv4d" },
    { id: "emuuxefjzr", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux9s7xe" },
    { id: "emuuxggbfu", source: "start", target: "nmuux3n080", sourceHandle: "next" },
    { id: "emuuxlzx116", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux5sj23" },
    { id: "emuuxm1hi17", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux6yaf5" },
    { id: "emuuxm3at18", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux72jo6" },
    { id: "emuuxm4zw19", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux78u37" },
    { id: "emuuxme3p1b", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxjy89y" },
    { id: "emuuxmfj31c", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxjztcz" },
    { id: "emuuxmh2n1d", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxk5zx10" },
    { id: "emuuxms1j1e", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "window_closed" },
    { id: "emuuxn2941f", source: "nmuux3n080", target: "nmuuxj5rrv", sourceHandle: "window_closed" },
    { id: "emuuxn5vp1g", source: "nmuux3n080", target: "nmuuxj5rrv", sourceHandle: "next" },
    { id: "emuuxndns1h", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxj5rrw" },
    { id: "emuuxnhio1i", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "window_closed" },
    { id: "emuuxorop1j", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxjsk4x" },
    { id: "emuuxueg81o", source: "nmuuxtp2h1l", target: "end", sourceHandle: "next" },
    { id: "emuuy9xyd1v", source: "nmuuxdr6bn", target: "nmuuy3uxn1p", sourceHandle: "next" },
    { id: "emuuya0kd1w", source: "nmuuxdr6bn", target: "nmuuy3uxn1p", sourceHandle: "window_closed" },
    { id: "emuuyaee21x", source: "nmuuy3uxn1p", target: "nmuuy7ry21t", sourceHandle: "next" },
    { id: "emuuyagdc1y", source: "nmuuy7ry21t", target: "nmuuy6pfy1s", sourceHandle: "next" },
    { id: "emuuyajk51z", source: "nmuuy6pfy1s", target: "nmuuy8mdw1u", sourceHandle: "next" },
    { id: "emuuyan6820", source: "nmuuy8mdw1u", target: "nmuuxtp2h1l", sourceHandle: "next" },
  ],
  nodes: [
    { id: "start", data: { label: "hello, hey, hi" }, type: "start", position: { x: -371, y: -146 } },
    { id: "end", data: {}, type: "end", position: { x: 2045, y: 12 } },
    { id: "nmuux3n080", data: { text: "Hi {{name}} Welcome to Zoori ✨ ", label: "step 1", image_url: WELCOME_PNG }, type: "text", position: { x: -80, y: -224 } },
    {
      id: "nmuux5sj22",
      data: {
        rows: [
          { id: "rmuux5sj23", title: "Diamond" },
          { id: "rmuux6yaf5", title: "Gemstone" },
          { id: "rmuux72jo6", title: "Pearl" },
          { id: "rmuux78u37", title: "Gold" },
        ],
        text: "Which stone are you looking for",
        label: "stone",
        variable: "stones",
        button_text: "Choose",
      },
      type: "list",
      position: { x: 545, y: -227 },
    },
    {
      id: "nmuux8kg1a",
      data: {
        rows: [
          { id: "rmuux8kg1b", title: "Under 25k" },
          { id: "rmuux98jqc", title: "₹25k–50k" },
          { id: "rmuux9gv4d", title: "₹50k–1L" },
          { id: "rmuux9s7xe", title: "Above ₹1L" },
        ],
        text: "What's your budget?",
        label: "Budget",
        variable: "budget",
        button_text: "Choose",
      },
      type: "list",
      position: { x: 868, y: -226 },
    },
    { id: "nmuuxdr6bn", data: { text: "Thank you! Our team will get back to you soon.", label: "end" }, type: "text", position: { x: 1193, y: -186 } },
    {
      id: "nmuuxj5rrv",
      data: {
        rows: [
          { id: "rmuuxj5rrw", title: "Rings" },
          { id: "rmuuxjsk4x", title: "Pendants" },
          { id: "rmuuxjy89y", title: "Tanmaniya" },
          { id: "rmuuxjztcz", title: "Bracelets" },
          { id: "rmuuxk5zx10", title: "Earrings" },
        ],
        text: "What are you looking for?",
        label: "product",
        variable: "product",
        button_text: "Choose",
      },
      type: "list",
      position: { x: 251, y: -236 },
    },
    { id: "nmuuxtp2h1l", data: { label: "assign to team", user_id: "" }, type: "assign", position: { x: 1767, y: -51 } },
    { id: "nmuuy3uxn1p", data: { tag: "WhatsApp lead", label: "zoori", action: "add" }, type: "tag", position: { x: 1434, y: 43 } },
    { id: "nmuuy6pfy1s", data: { field: "interest", label: "interest", value: "{{product}}" }, type: "set_field", position: { x: 1627, y: 294 } },
    { id: "nmuuy7ry21t", data: { field: "budget", value: "{{budget}}" }, type: "set_field", position: { x: 1349, y: 242 } },
    { id: "nmuuy8mdw1u", data: { field: "stone", value: "{{stones}}" }, type: "set_field", position: { x: 1933, y: 208 } },
  ],
};

const AIDWAR_WELCOME: FlowGraph = {
  meta: {},
  edges: [
    { id: "e0", source: "start", target: "menu", sourceHandle: "next" },
    { id: "e1", source: "menu", target: "shop", sourceHandle: "b1" },
    { id: "e2", source: "menu", target: "track", sourceHandle: "b2" },
    { id: "e3", source: "menu", target: "team", sourceHandle: "b3" },
    { id: "e4", source: "shop", target: "end", sourceHandle: "next" },
    { id: "e5", source: "track", target: "end", sourceHandle: "next" },
    { id: "e6", source: "team", target: "end", sourceHandle: "next" },
  ],
  nodes: [
    { id: "start", data: {}, type: "start", position: { x: 80, y: 60 } },
    {
      id: "menu",
      data: {
        text: "Hi {{name}}! How can we help?",
        buttons: [
          { id: "b1", title: "Shop" },
          { id: "b2", title: "Track order" },
          { id: "b3", title: "Talk to us" },
        ],
      },
      type: "buttons",
      position: { x: 380, y: 60 },
    },
    { id: "shop", data: { text: "Browse our latest picks on our website." }, type: "text", position: { x: 680, y: 60 } },
    { id: "track", data: { text: "Please share your order number and we'll check." }, type: "text", position: { x: 80, y: 260 } },
    { id: "team", data: {}, type: "assign", position: { x: 380, y: 260 } },
    { id: "end", data: {}, type: "end", position: { x: 680, y: 260 } },
  ],
};

/** A WhatsApp shop step (internal type "carousel", unchanged) in a small flow. */
const SHOP_FLOW: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "shop", type: "carousel", data: { header: "Our picks", text: "Take a look:", retailer_ids: ["SKU-1"], titles: { "SKU-1": "Ring" } } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "1", source: "start", target: "shop", sourceHandle: "next" },
    { id: "2", source: "shop", target: "end", sourceHandle: "next" },
    { id: "3", source: "shop", target: "end", sourceHandle: "window_closed" },
  ],
};

// ------------------------------------------------------------ existing flows

describe("existing flows load, validate and run exactly as before", () => {
  const graphs = { "Zoori (live)": ZOORI_LIVE, "Ai Dwar Welcome menu (live)": AIDWAR_WELCOME };

  it.each(Object.entries(graphs))("%s: every step type is still known to the editor, outputs unchanged", (_name, g) => {
    // A saved flow round-trips through JSON and every stored type still has a palette entry.
    const loaded = JSON.parse(JSON.stringify(g)) as FlowGraph;
    expect(loaded).toEqual(g);
    for (const n of loaded.nodes) expect(NODE_META[n.type as NodeType]).toBeDefined();
    expect(outputsOf(loaded.nodes.find((n) => n.type === "assign")!)).toEqual(["next"]);
  });

  it.each(Object.entries(graphs))("%s: validates clean with or without a WhatsApp shop connected", (_name, g) => {
    expect(validateGraph(g)).toEqual([]);
    expect(validateGraph(g, { whatsappShop: false })).toEqual([]);
    expect(validateGraph(g, { whatsappShop: true })).toEqual([]);
  });

  it("unchanged wording on the steps these flows use", () => {
    expect(["text", "buttons", "list", "tag", "set_field", "assign", "end"].map((t) => NODE_META[t as NodeType].label)).toEqual([
      "Message",
      "Buttons",
      "List",
      "Tag",
      "Update field",
      "Assign to team",
      "End",
    ]);
  });

  it("simulator: Zoori hi → product → stone → budget → thank you → done", () => {
    let s = simStart(ZOORI_LIVE, "Asha");
    expect(s.messages[0]).toMatchObject({ from: "bot", image: WELCOME_PNG });
    expect(s.messages.at(-1)).toMatchObject({ text: "What are you looking for?", options: ["Rings", "Pendants", "Tanmaniya", "Bracelets", "Earrings"] });
    s = simReply(ZOORI_LIVE, s, "Rings");
    expect(s.messages.at(-1)).toMatchObject({ text: "Which stone are you looking for" });
    s = simReply(ZOORI_LIVE, s, "Diamond");
    expect(s.messages.at(-1)).toMatchObject({ text: "What's your budget?" });
    s = simReply(ZOORI_LIVE, s, "Under 25k");
    expect(s.messages.some((m) => m.text === "Thank you! Our team will get back to you soon.")).toBe(true);
    expect(s.path).toEqual(["start", "nmuux3n080", "nmuuxj5rrv", "nmuux5sj22", "nmuux8kg1a", "nmuuxdr6bn", "nmuuy3uxn1p", "nmuuy7ry21t", "nmuuy6pfy1s", "nmuuy8mdw1u", "nmuuxtp2h1l", "end"]);
    expect(s.done).toBe(true);
  });

  it("simulator: Ai Dwar Welcome menu → Shop / Talk to us", () => {
    let s = simStart(AIDWAR_WELCOME, "Asha");
    expect(s.messages[0]).toMatchObject({ text: "Hi Asha! How can we help?", options: ["Shop", "Track order", "Talk to us"] });
    s = simReply(AIDWAR_WELCOME, s, "Shop");
    expect(s.messages.some((m) => m.text === "Browse our latest picks on our website.")).toBe(true);
    expect(s.path).toEqual(["start", "menu", "shop", "end"]);
    expect(s.done).toBe(true);
    let t = simStart(AIDWAR_WELCOME, "Asha");
    t = simReply(AIDWAR_WELCOME, t, "Talk to us");
    expect(t.path).toEqual(["start", "menu", "team", "end"]);
  });
});

// The engine, through the real webhook, with the live graphs.
const runUpdates = (w: { ops: FakeOp[] }) => w.ops.filter((o) => o.table === "flow_runs" && o.kind === "update").map((o) => o.payload as Record<string, unknown>);

function liveWorld(org: string, graph: FlowGraph, keyword: string, waiting?: { at: string; vars?: Record<string, unknown> }) {
  return latencyWorld({
    org,
    rttMs: 0,
    graphMs: 0,
    waitingRun: Boolean(waiting),
    override: (op) => {
      if (op.table === "flow_versions") return { data: { id: "ver-1", graph }, error: null };
      if (op.table === "flow_triggers")
        return {
          data: [{ id: "8ea5aa7c-6a2a-4f7d-bb85-000000000009", flow_id: "flow-1", kind: "keyword", config: { keywords: [keyword], match: "exact" }, flows: { whatsapp_account_id: null } }],
          error: null,
        };
      if (op.table === "flow_runs" && op.kind === "select" && waiting)
        return {
          data: [
            {
              id: `run-${org}`,
              organization_id: org,
              flow_id: "flow-1",
              version_id: "ver-1",
              contact_id: "c1",
              conversation_id: "cv1",
              current_node_id: waiting.at,
              variables: waiting.vars ?? {},
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
      return undefined;
    },
  });
}

async function deliver(w: ReturnType<typeof liveWorld>, org: string, msg: Record<string, unknown>) {
  vi.stubGlobal("fetch", w.fetchStub);
  await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload(msg), new Date(Date.now() - 300).toISOString(), { storeMs: 10 });
  return w.graphSends.map((s) => s.body);
}

const listReply = (id: string, title: string) => ({ id: `wamid.${id}`, type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } }, context: { id: "wamid.prompt" } });

describe("engine: the live flows run unchanged (and never look at the WhatsApp shop)", () => {
  it("Zoori: 'hi' → welcome picture, then the product list", async () => {
    const w = liveWorld("o9-zoori-hi", ZOORI_LIVE, "hi");
    const sends = await deliver(w, "o9-zoori-hi", { id: "wamid.hi", type: "text", text: { body: "hi" } });
    expect(sends[0]).toMatchObject({ type: "image", image: { link: WELCOME_PNG } });
    expect(String((sends[0]!["image"] as { caption: string }).caption)).toContain("Welcome to Zoori ✨");
    expect(sends[1]).toMatchObject({ type: "interactive" });
    expect(((sends[1]!["interactive"] as Record<string, unknown>)["body"] as { text: string }).text).toBe("What are you looking for?");
    expect(w.ops.some((o) => o.table === "whatsapp_catalogs")).toBe(false);
  });

  it("Zoori: the budget answer → thank you, tag, three fields, assign, done", async () => {
    const w = liveWorld("o9-zoori-budget", ZOORI_LIVE, "hi", { at: "nmuux8kg1a", vars: { product: "Rings", stones: "Diamond" } });
    const sends = await deliver(w, "o9-zoori-budget", listReply("nmuux8kg1a:rmuux8kg1b", "Under 25k"));
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: "Thank you! Our team will get back to you soon." } }]);
    expect(runUpdates(w).at(-1)).toMatchObject({ status: "done" });
    expect(w.ops.some((o) => o.table === "whatsapp_catalogs")).toBe(false);
  });

  it("Ai Dwar Welcome menu: 'menu' → three buttons; Shop → the shop message", async () => {
    const w = liveWorld("o9-aidwar-menu", AIDWAR_WELCOME, "menu");
    const sends = await deliver(w, "o9-aidwar-menu", { id: "wamid.menu", type: "text", text: { body: "menu" } });
    const interactive = sends[0]!["interactive"] as Record<string, unknown>;
    expect(interactive["type"]).toBe("button");
    expect((interactive["body"] as { text: string }).text).toBe("Hi Asha! How can we help?");
    expect(((interactive["action"] as { buttons: Array<{ reply: { title: string } }> }).buttons).map((b) => b.reply.title)).toEqual(["Shop", "Track order", "Talk to us"]);

    const t = liveWorld("o9-aidwar-shop", AIDWAR_WELCOME, "menu", { at: "menu" });
    const tap = { id: "wamid.tap", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } }, context: { id: "wamid.prompt" } };
    expect(await deliver(t, "o9-aidwar-shop", tap)).toEqual([{ messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: "Browse our latest picks on our website." } }]);
    expect(t.ops.some((o) => o.table === "whatsapp_catalogs")).toBe(false);
  });
});

// ------------------------------------------------------------ wording

describe("(1) wording only: names change, keys and routes don't", () => {
  it("sidebar says Products; the route, key, flag and permission stay 'catalog'", () => {
    const products = FEATURES.find((f) => f.key === "catalog")!;
    expect(products.name).toBe("Products");
    expect(products.nav_path).toBe("/app/catalog");
    expect(products.flag_key).toBe("catalogs");
    expect(products.nav_permission).toBe("catalog.view");
    expect(navFeatures().some((f) => f.name === "Catalogue")).toBe(false);
  });

  it("flow palette: the carousel step is labelled WhatsApp shop; Show products explains itself", () => {
    expect(NODE_META.carousel.label).toBe("WhatsApp shop");
    expect(NODE_META.carousel.hint).toBe("Opens your WhatsApp catalogue with add-to-cart. Needs WhatsApp shop connected.");
    expect(NODE_META.show_products.label).toBe("Show products");
    expect(NODE_META.show_products.hint).toBe("Sends matching products as photos with price and link. Works for every business.");
    // The stored type and its defaults are untouched.
    expect(NODE_META.carousel.defaults()).toEqual({ header: "Our picks", text: "Take a look:", retailer_ids: [] });
    expect(outputsOf(SHOP_FLOW.nodes[1]!)).toEqual(["next", "window_closed"]);
  });

  it("the Products summary line", () => {
    expect(productsSummaryLine({ total: 131, website: 131, store: 0, lastUpdated: null })).toBe("131 products · from your website");
    expect(productsSummaryLine({ total: 1, website: 0, store: 1, lastUpdated: new Date().toISOString() })).toBe("1 product · from your store · updated just now");
    expect(productsSummaryLine({ total: 0, website: 0, store: 0, lastUpdated: null })).toBe("0 products");
    expect(productSourceWords({ website: 2, store: 3 })).toBe("from your website and store");
    expect(productSourceWords({ website: 0, store: 0 })).toBeNull();
  });

  it("WhatsApp shop state: connected only when a catalogue is linked to a number", () => {
    expect(WHATSAPP_SHOP_CONNECTED_STATUSES).toEqual(["linked", "attach_unconfirmed"]);
    expect(whatsappShopState([])).toEqual({ connected: false, row: null, synced: 0, lastSynced: null });
    expect(whatsappShopState([{ waba_id: "w", status: "created", pushed_count: 9, last_sync_at: null }]).connected).toBe(false);
    const at = "2026-10-05T07:00:00Z";
    expect(whatsappShopState([{ waba_id: "w", status: "linked", pushed_count: 42, last_sync_at: at }])).toMatchObject({ connected: true, synced: 42, lastSynced: at });
  });
});

// ------------------------------------------------------------ guard

describe("(2) WhatsApp shop step needs a connected shop", () => {
  it("not connected: the step says 'Connect WhatsApp shop first' (first on the node) and publish is blocked", () => {
    const problems = validateGraph(SHOP_FLOW, { whatsappShop: false });
    expect(problems).toEqual([{ nodeId: "shop", message: WHATSAPP_SHOP_REQUIRED }]);
    expect(WHATSAPP_SHOP_REQUIRED).toBe("Connect WhatsApp shop first");
    // Shown first on the step even when the step has other problems.
    const empty = { ...SHOP_FLOW, nodes: SHOP_FLOW.nodes.map((n) => (n.id === "shop" ? { ...n, data: { retailer_ids: [] } } : n)) };
    expect(validateGraph(empty, { whatsappShop: false }).filter((p) => p.nodeId === "shop").map((p) => p.message)).toEqual([WHATSAPP_SHOP_REQUIRED, "Pick 1–10 products."]);
  });

  it("connected, or not checked (older callers): exactly the old checks", () => {
    expect(validateGraph(SHOP_FLOW, { whatsappShop: true })).toEqual([]);
    expect(validateGraph(SHOP_FLOW)).toEqual([]);
  });

  it("whatsappShopConnected reads linked / attach_unconfirmed catalogues of the workspace only", async () => {
    const db = fakeDb((op) => (op.table === "whatsapp_catalogs" ? { data: [{ id: "c1" }], error: null } : undefined));
    expect(await whatsappShopConnected(db.supabase, "org")).toBe(true);
    const q = db.ops[0]!;
    expect(db.has(q, "eq", "organization_id", "org")).toBe(true);
    expect(db.has(q, "in", "status", ["linked", "attach_unconfirmed"])).toBe(true);
    const none = fakeDb((op) => (op.table === "whatsapp_catalogs" ? { data: [], error: null } : undefined));
    expect(await whatsappShopConnected(none.supabase, "org")).toBe(false);
  });
});

// ------------------------------------------------------------ photos

const PAGE = "https://www.myzoori.com/product-detail/a2b48ec6-487a-48ed-aed2-8f36b3d9ad85";
const OTHER = "https://www.myzoori.com/storage/images/products/a2d0e015-060e-4668-a160-cda775a9709c/zpnds-0036e2948.jpg";
const OWN = "https://www.myzoori.com/storage/images/products/a2b48ec6-487a-48ed-aed2-8f36b3d9ad85/ZPND-0040.1-1790180094.jpg";
const page = (head: string, body: string) => `<!doctype html><html><head><title>ZPND-0040</title>${head}</head><body>${body}${" ".repeat(200)}</body></html>`;
const ld = (image: unknown) =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: "ZPND-0040", image, sku: "ZPND-0040", brand: { "@type": "Brand", name: "MyZoori" } }] })}</script>`;
/** What Zoori's photo-less pages look like today: an empty image, empty galleries, other products' photos below. */
const ZOORI_NO_PHOTO = page(
  ld([""]),
  `<h1>ZPND-0040</h1><p>₹ 28,860.09</p>
   <option data-images='[]' data-videos='[]' selected>Yellow</option>
   <img src="\${img}" class="zoom-img main-swiper-image">
   <img src="https://www.myzoori.com/assets/frontend/assets/images/menulogobig.png">
   <h3>You may also like</h3><img src="${OTHER}">`,
);

describe("(3) product photo from the product page", () => {
  it("og:image first", () => {
    const html = page(`<meta property="og:image" content="https://cdn.shop.in/p/ring.jpg">${ld(["https://cdn.shop.in/ld.jpg"])}`, "");
    expect(productPagePhoto(html, PAGE)).toBe("https://cdn.shop.in/p/ring.jpg");
  });

  it("then the product's JSON-LD image (string, list or ImageObject)", () => {
    expect(productPagePhoto(page(ld([OWN]), ""), PAGE)).toBe(OWN);
    expect(productPagePhoto(page(ld(OWN), ""), PAGE)).toBe(OWN);
    expect(productPagePhoto(page(ld({ "@type": "ImageObject", url: OWN }), ""), PAGE)).toBe(OWN);
  });

  it("then the main gallery picture that names this product", () => {
    const html = page(ld([""]), `<option data-images='["${OWN.replace(/\//g, "\\/")}"]' selected>Yellow</option><img src="${OTHER}">`);
    expect(productPagePhoto(html, PAGE)).toBe(OWN);
    const bySku = page("", `<img src="https://cdn.shop.in/files/zpnd-0040-front.jpg"><img src="${OTHER}">`);
    expect(productPagePhoto(bySku, PAGE, "ZPND-0040")).toBe("https://cdn.shop.in/files/zpnd-0040-front.jpg");
    const marked = page("", `<img class="wp-post-image" src="https://cdn.shop.in/uploads/front.jpg"><h2>Related products</h2><img src="https://cdn.shop.in/uploads/other.jpg">`);
    expect(productPagePhoto(marked, "https://shop.in/p/ring")).toBe("https://cdn.shop.in/uploads/front.jpg");
  });

  it("never another product's photo, a script slot, a logo or a marked picture under 'related'", () => {
    expect(productPagePhoto(ZOORI_NO_PHOTO, PAGE, "ZPND-0040")).toBeNull();
    const below = page("", `<h2>Related products</h2><img class="wp-post-image" src="https://cdn.shop.in/uploads/other.jpg">`);
    expect(productPagePhoto(below, "https://shop.in/p/ring")).toBeNull();
  });

  it("extractProduct: a body-only page (no head) now keeps its gallery photo; pages with a photo read as before", () => {
    const bodyOnly = `<h1>ZPND-0040</h1><p>₹ 28,860.09</p><option data-images='["${OWN}"]' selected>Yellow</option>${" ".repeat(300)}`;
    expect(extractProduct(bodyOnly, PAGE)?.imageUrl).toBe(OWN);
    const withLd = page(ld([OWN]), `<h1>ZPND-0040</h1><p>₹ 28,860.09</p><img src="${OTHER}">`);
    expect(extractProduct(withLd, PAGE)?.imageUrl).toBe(OWN);
  });

  const draft = (patch: Partial<ProductDraft>): ProductDraft => ({
    externalId: PAGE,
    title: "ZPND-0040",
    price: 28860.09,
    currency: "INR",
    imageUrl: null,
    productUrl: PAGE,
    category: "pendants",
    gender: null,
    availability: "in_stock",
    sku: "ZPND-0040",
    brand: "MyZoori",
    description: null,
    ...patch,
  });

  it("fillMissingPhotos opens only pages whose product has no photo yet and isn't a shop platform's", async () => {
    const rows = [
      { external_id: "https://s.in/p/has-photo", source: "crawl", image_url: "https://s.in/kept.jpg" },
      { external_id: "https://s.in/p/shopify", source: "shopify", image_url: null },
      { external_id: "https://s.in/p/known-empty", source: "crawl", image_url: null },
    ];
    const db = fakeDb((op) => (op.table === "products" && op.kind === "select" ? { data: rows, error: null } : undefined));
    const fetched: string[] = [];
    const drafts = [
      draft({ externalId: "https://s.in/p/new" }),
      draft({ externalId: "https://s.in/p/has-photo" }),
      draft({ externalId: "https://s.in/p/shopify" }),
      draft({ externalId: "https://s.in/p/known-empty" }),
      draft({ externalId: "https://s.in/p/read-with-photo", imageUrl: "https://s.in/already.jpg" }),
    ];
    const filled = await fillMissingPhotos(db.supabase, "org", drafts, {
      fetchHtml: async (url) => {
        fetched.push(url);
        return url.endsWith("/new") ? page(`<meta property="og:image" content="https://s.in/new.jpg">`, "") : ZOORI_NO_PHOTO;
      },
    });
    expect(fetched.sort()).toEqual(["https://s.in/p/known-empty", "https://s.in/p/new"]);
    expect(filled).toBe(1);
    expect(drafts.map((d) => d.imageUrl)).toEqual(["https://s.in/new.jpg", null, null, null, "https://s.in/already.jpg"]);
    // Read-only towards the products table: it only looks.
    expect(db.ops.every((o) => o.kind === "select")).toBe(true);
  });

  it("fillMissingPhotos is bounded per read and never throws on a bad page", async () => {
    const db = fakeDb(() => ({ data: [], error: null }));
    const many = Array.from({ length: 10 }, (_, i) => draft({ externalId: `https://s.in/p/${i}` }));
    let calls = 0;
    await fillMissingPhotos(db.supabase, "org", many, {
      maxPages: 3,
      fetchHtml: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    expect(calls).toBe(3);
    expect(await fillMissingPhotos(db.supabase, "org", [draft({ imageUrl: "https://s.in/x.jpg" })])).toBe(0);
  });

  it("saving never overwrites or wipes a photo the product already has", async () => {
    const withPhoto = fakeDb((op) => (op.table === "products" && op.kind === "select" ? { data: { id: "p1", source: "crawl", image_url: "https://s.in/kept.jpg" }, error: null } : undefined));
    await saveCrawledProducts(withPhoto.supabase, "org", [draft({ imageUrl: "https://s.in/new.jpg" })]);
    await saveCrawledProducts(withPhoto.supabase, "org", [draft({ imageUrl: null })]);
    for (const u of withPhoto.ops.filter((o) => o.kind === "update")) expect("image_url" in (u.payload as Record<string, unknown>)).toBe(false);

    const empty = fakeDb((op) => (op.table === "products" && op.kind === "select" ? { data: { id: "p1", source: "crawl", image_url: null }, error: null } : undefined));
    await saveCrawledProducts(empty.supabase, "org", [draft({ imageUrl: OWN })]);
    expect(empty.ops.find((o) => o.kind === "update")!.payload).toMatchObject({ image_url: OWN, price: 28860.09 });

    const fresh = fakeDb(() => undefined);
    await saveCrawledProducts(fresh.supabase, "org", [draft({ imageUrl: OWN })]);
    expect(fresh.ops.find((o) => o.kind === "insert")!.payload).toMatchObject({ image_url: OWN, source: "crawl" });
  });
});

// ------------------------------------------------------------ Aiden

describe("unchanged: Aiden's product answers", () => {
  it("catalogSearch returns the same rows and the same pictures captions", async () => {
    const row = { id: "p1", title: "Golden Petal", price: 19603.91, currency: "INR", category: "pendants", image_url: "https://x.in/p1.jpg", product_url: "https://x.in/p/p1", availability: "in_stock" };
    const db = fakeDb((op) => (op.table === "products" ? { data: [row], error: null } : undefined));
    const out = await AI_TOOL_HANDLERS["catalogSearch"]!({ supabase: db.supabase, organizationId: "o", actorUserId: null, initiatedBy: "ai" }, { category: "pendants", max_price: 25000 });
    expect(out.ok).toBe(true);
    expect(out.found).toBe(true);
    expect(JSON.stringify(out.data)).toContain("https://x.in/p1.jpg");
    const search = db.ops.find((o) => o.table === "products")!;
    expect(db.has(search, "eq", "is_visible", true)).toBe(true);
    expect(db.has(search, "lte", "price", 25000)).toBe(true);
    expect(productCaption({ title: "Golden Petal", imageUrl: "https://x.in/p1.jpg", price: 19603.91, currency: "INR", productUrl: "https://x.in/p/p1" })).toBe("Golden Petal — ₹19,604");
  });
});
