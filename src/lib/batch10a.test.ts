import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { AIDWAR_WELCOME, ZOORI_LIVE } from "./test-support/live-graphs";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import { CARDS_REQUIRED, cardOfNode, outputsOf, validateGraph, type FlowGraph, type NodeType } from "./flow-graph";
import { simReply, simStart } from "./flow-simulator";
import { NODE_META, paletteTypes } from "@/components/flows/v2/node-meta";
import { cardFallbackText, cleanCardVars, productCardsInAnswers, PRODUCT_CARDS_SETTING } from "./customer-cards";
import { productCardsOn, sendCardOrFallback } from "./customer-cards.server";
import { responsesLine } from "./flow-responses";
import type { RunMedia } from "./ai-run.server";

/**
 * Batch 10A — cards everywhere, opt-in.
 *  - Flows v2 "Send card" step: graph, validation, simulator, engine (card,
 *    plain fallback, failed path; nothing when cards are off).
 *  - The Cards page switch: Aiden's product answers and Show products keep
 *    today's behaviour by default; off sends plain photos.
 *  - Existing flows (Zoori, Welcome menu) load, validate and run unchanged.
 *  - Flows list "N responses · last …" line.
 * (Inbox send, /api/cards, campaigns and send-message: batch10a-routes.test.ts;
 *  hidden UI when cards are off: batch10a-ui.test.tsx.)
 */

const h = vi.hoisted(() => ({
  answer: null as null | { output: string; media: RunMedia[] },
}));
vi.mock("@/lib/ai-tasks.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-tasks.server")>()),
  agentAnswer: async () => ({
    runId: "run-ai",
    status: "ok",
    output: h.answer?.output ?? "",
    media: h.answer?.media ?? [],
    needsOwner: false,
    escalationSignal: null,
    latencyMs: 1,
    toolCalls: [],
  }),
}));

const CARD_URL = "https://render.test/storage/card.png";
const PHOTO = "https://www.myzoori.com/storage/p1.jpg";

beforeEach(() => {
  process.env["AIDWAR_SUPABASE_URL"] = "https://render.test";
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "service-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["AIDWAR_SUPABASE_URL"];
  delete process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];
});

// ------------------------------------------------------------------ graphs

const OFFER_VARS = { headline: "Hi {{name}}", offer: "20% off everything", validity: "", code: "FEST20" };

function cardFlow(opts: { data?: Record<string, unknown>; failedPath?: boolean } = {}): FlowGraph {
  return {
    nodes: [
      { id: "start", type: "start", data: {} },
      {
        id: "card",
        type: "send_card",
        data: { kind: "customer_offer", vars: OFFER_VARS, caption: "Just for you, {{name}}", fallback_text: "Hi {{name}} — 20% off with FEST20", ...opts.data },
      },
      { id: "sorry", type: "text", data: { text: "Our team will share the offer shortly." } },
      { id: "end", type: "end", data: {} },
    ],
    edges: [
      { id: "1", source: "start", target: "card", sourceHandle: "next" },
      { id: "2", source: "card", target: "end", sourceHandle: "next" },
      { id: "4", source: "sorry", target: "end", sourceHandle: "next" },
      ...(opts.failedPath ? [{ id: "3", source: "card", target: "sorry", sourceHandle: "failed" }] : []),
    ],
  };
}

const SHOW_FLOW: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "show", type: "show_products", data: { category: "Pendants", budget: "Under 25k", max_items: 5 } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "1", source: "start", target: "show", sourceHandle: "next" },
    { id: "2", source: "show", target: "end", sourceHandle: "found" },
    { id: "3", source: "show", target: "end", sourceHandle: "none" },
  ],
};

const ROWS = [
  { id: "p1", title: "Golden Petal", price: 19603.91, currency: "INR", category: "pendants", image_url: PHOTO, product_url: "https://www.myzoori.com/product-detail/p1", availability: "in_stock" },
  { id: "p2", title: "Pearl Pavilion", price: 23027.9, currency: "INR", category: "pendants", image_url: "https://www.myzoori.com/storage/p2.jpg", product_url: "https://www.myzoori.com/product-detail/p2", availability: "in_stock" },
];

// ------------------------------------------------------------------ worlds

/**
 * A workspace whose flow starts on "hi". `cards` switches the cards flag;
 * `branding` is organizations.branding; `render` decides what the card
 * renderer answers (null = it's down).
 */
function world(org: string, graph: FlowGraph, opts: { cards: boolean; branding?: Record<string, unknown>; render?: "ok" | "down"; products?: unknown[] }) {
  const w = latencyWorld({
    org,
    rttMs: 0,
    graphMs: 0,
    waitingRun: false,
    override: (op: FakeOp) => {
      if (op.table === "feature_flags")
        return { data: [{ key: "flows_v2", default_enabled: true }, { key: "cards", default_enabled: opts.cards }], error: null };
      if (op.table === "organizations") return { data: { name: "Zoori", branding: opts.branding ?? {} }, error: null };
      if (op.table === "flow_versions") return { data: { id: "ver-1", graph }, error: null };
      if (op.table === "flow_triggers")
        return {
          data: [{ id: "8ea5aa7c-6a2a-4f7d-bb85-00000000a10a", flow_id: "flow-1", kind: "keyword", config: { keywords: ["hi"], match: "exact" }, flows: { whatsapp_account_id: null } }],
          error: null,
        };
      if (op.table === "products") return { data: opts.products ?? [], error: null };
      return undefined;
    },
  });
  const renders: Array<Record<string, unknown>> = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/functions/v1/render-card")) {
      renders.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return opts.render === "down"
        ? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
        : new Response(JSON.stringify({ url: CARD_URL }), { status: 200 });
    }
    return w.fetchStub(url, init);
  };
  return { ...w, renders, fetch };
}

async function hi(w: ReturnType<typeof world>, org: string) {
  vi.stubGlobal("fetch", w.fetch);
  await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload({ id: `wamid.${org}`, type: "text", text: { body: "hi" } }), new Date(Date.now() - 300).toISOString(), { storeMs: 10 });
  return w.graphSends.map((s) => s.body);
}

const events = (w: { ops: FakeOp[] }) =>
  w.ops.filter((o) => o.table === "flow_run_events" && o.kind === "insert").map((o) => JSON.stringify(o.payload)).join("\n");
const runUpdates = (w: { ops: FakeOp[] }) => w.ops.filter((o) => o.table === "flow_runs" && o.kind === "update").map((o) => o.payload as Record<string, unknown>);
const TO = "919800000001";
/** Reads of organizations.branding (the Cards page switch or card branding). */
const readsSwitch = (w: { ops: FakeOp[] }) => w.ops.some((o) => o.table === "organizations" && JSON.stringify(o.select ?? []).includes("branding"));

// ------------------------------------------------------------------ graph + editor

describe("Send card step: graph and editor", () => {
  it("outputs next / failed; failed is optional", () => {
    const node = cardFlow().nodes[1]!;
    expect(outputsOf(node)).toEqual(["next", "failed"]);
    expect(validateGraph(cardFlow())).toEqual([]);
    expect(validateGraph(cardFlow({ failedPath: true }))).toEqual([]);
  });

  it("is unavailable when cards are off; fine when on or not known", () => {
    expect(validateGraph(cardFlow(), { cards: false })).toEqual([{ nodeId: "card", message: CARDS_REQUIRED }]);
    expect(validateGraph(cardFlow(), { cards: true })).toEqual([]);
  });

  it("asks for a design and at least one detail; a picture needs https", () => {
    const msgs = (data: Record<string, unknown>) => validateGraph(cardFlow({ data })).map((p) => p.message);
    expect(msgs({ kind: "nope" })).toContain("Pick a card design.");
    expect(msgs({ vars: {} })).toContain("Fill in at least one detail on the card.");
    expect(msgs({ kind: "customer_product", vars: { name: "Ring", image_url: "http://x/a.jpg" } })).toContain("The picture needs a full link starting with https://");
    expect(msgs({ kind: "customer_product", vars: { name: "Ring", image_url: "{{photo}}" } })).toEqual(["Variable {{photo}} is never set."]);
  });

  it("palette: Send card in Messages only with cards on; every other step exactly as before", () => {
    expect(NODE_META.send_card).toMatchObject({ label: "Send card", group: "Messages" });
    const before = (Object.keys(NODE_META) as NodeType[]).filter((k) => k !== "start" && k !== "send_card");
    expect(paletteTypes({ cards: false })).toEqual(before);
    expect(paletteTypes({ cards: true })).toEqual([...before.slice(0, before.indexOf("show_products")), "send_card", ...before.slice(before.indexOf("show_products"))]);
  });

  it("fills {{variables}} into the card's details", () => {
    const card = cardOfNode(cardFlow().nodes[1]!.data, { vars: {}, contact: { name: "Asha", phone: TO, attributes: {} }, tags: [], now: new Date(), timezone: "Asia/Kolkata" });
    expect(card).toEqual({ kind: "customer_offer", vars: { headline: "Hi Asha", offer: "20% off everything", validity: "", code: "FEST20" } });
  });

  it("simulator: the card shows with its words, then the flow carries on", () => {
    const s = simStart(cardFlow(), "Asha");
    expect(s.messages[0]).toMatchObject({ from: "bot", text: "Just for you, Asha", card: { kind: "customer_offer", vars: { headline: "Hi Asha", code: "FEST20" } } });
    expect(s.messages[1]!.text).toContain('if it can\'t be drawn, this goes instead: "Hi Asha — 20% off with FEST20"');
    expect(s.path).toEqual(["start", "card", "end"]);
    expect(s.done).toBe(true);
  });

  it("the plain fallback words of a card", () => {
    expect(cardFallbackText("customer_offer", { headline: "This weekend", offer: "20% off", validity: "Till Sunday", code: "FEST20" })).toBe(
      "This weekend\n20% off\nValid till: Till Sunday\nCoupon code: FEST20",
    );
    expect(cardFallbackText("customer_product", { name: "Ring", price: "₹499", image_url: PHOTO, one_liner: "" })).toBe("Ring\nPrice: ₹499");
    expect(cleanCardVars("customer_appointment", { date: " Sat ", time: 4, place: "Bandra", extra: "x" })).toEqual({ date: "Sat", time: "4", place: "Bandra" });
  });
});

// ------------------------------------------------------------------ existing flows

describe("existing flows load, validate and run unchanged", () => {
  const graphs = { "Zoori (live)": ZOORI_LIVE, "Ai Dwar Welcome menu (live)": AIDWAR_WELCOME };

  it.each(Object.entries(graphs))("%s: loads, every type known, validates clean with cards on, off or unknown", (_n, g) => {
    const loaded = JSON.parse(JSON.stringify(g)) as FlowGraph;
    expect(loaded).toEqual(g);
    for (const n of loaded.nodes) expect(NODE_META[n.type as NodeType]).toBeDefined();
    expect(validateGraph(loaded)).toEqual([]);
    expect(validateGraph(loaded, { cards: false })).toEqual([]);
    expect(validateGraph(loaded, { cards: true, whatsappShop: false })).toEqual([]);
  });

  it("simulator: same messages and path as before", () => {
    let s = simStart(AIDWAR_WELCOME, "Asha");
    s = simReply(AIDWAR_WELCOME, s, "Shop");
    expect(s.path).toEqual(["start", "menu", "shop", "end"]);
    expect(s.messages.some((m) => "card" in m && m.card)).toBe(false);
    let z = simStart(ZOORI_LIVE, "Asha");
    for (const r of ["Rings", "Diamond", "Under 25k"]) z = simReply(ZOORI_LIVE, z, r);
    expect(z.done).toBe(true);
    expect(z.messages.some((m) => "card" in m && m.card)).toBe(false);
  });

  it("engine: Welcome menu 'hi' → the same three buttons, cards on, no render, no card read", async () => {
    const graph = { ...AIDWAR_WELCOME };
    const w = world("o10-welcome", graph, { cards: true });
    const sends = await hi(w, "o10-welcome");
    expect(sends).toHaveLength(1);
    expect((sends[0]!["interactive"] as { body: { text: string } }).body.text).toBe("Hi Asha! How can we help?");
    expect(w.renders).toEqual([]);
    expect(readsSwitch(w)).toBe(false);
  });

  it("engine: Zoori 'hi' → welcome picture then the product list, never a card", async () => {
    const w = world("o10-zoori", ZOORI_LIVE, { cards: true });
    const sends = await hi(w, "o10-zoori");
    expect(sends[0]).toMatchObject({ type: "image" });
    expect(sends[1]).toMatchObject({ type: "interactive" });
    expect(w.renders).toEqual([]);
  });
});

// ------------------------------------------------------------------ engine: Send card

describe("engine: Send card step", () => {
  it("cards on → one card picture with its words, card_sent, run done", async () => {
    const w = world("o10-card", cardFlow(), { cards: true });
    const sends = await hi(w, "o10-card");
    expect(w.renders).toHaveLength(1);
    expect(w.renders[0]).toMatchObject({ kind: "customer_offer", vars: { headline: "Hi Asha", code: "FEST20", brand_name: "Zoori" } });
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: TO, type: "image", image: { link: CARD_URL, caption: "Just for you, Asha" } }]);
    expect(w.ops.find((o) => o.table === "messages" && o.kind === "insert")?.payload).toMatchObject({ type: "image", media_url: CARD_URL, metadata: { kind: "flow_v2", node_id: "card", card_kind: "customer_offer" } });
    expect(events(w)).toContain("card_sent");
    expect(runUpdates(w).at(-1)).toMatchObject({ status: "done" });
  });

  it("cards off → no card is drawn or sent; the plain fallback goes and the flow carries on", async () => {
    const w = world("o10-off", cardFlow(), { cards: false });
    const sends = await hi(w, "o10-off");
    expect(w.renders).toEqual([]);
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: TO, type: "text", text: { body: "Hi Asha — 20% off with FEST20" } }]);
    expect(events(w)).toContain("cards_off");
    expect(runUpdates(w).at(-1)).toMatchObject({ status: "done" });
  });

  it("render fails → the plain fallback goes, then the Failed path", async () => {
    const w = world("o10-down", cardFlow({ failedPath: true }), { cards: true, render: "down" });
    const sends = await hi(w, "o10-down");
    expect(w.renders).toHaveLength(1);
    expect(sends).toEqual([
      { messaging_product: "whatsapp", to: TO, type: "text", text: { body: "Hi Asha — 20% off with FEST20" } },
      { messaging_product: "whatsapp", to: TO, type: "text", text: { body: "Our team will share the offer shortly." } },
    ]);
    expect(events(w)).toContain("render_failed");
  });

  it("render fails on a Product card → its photo with the fallback words (like product pictures)", async () => {
    const data = { kind: "customer_product", vars: { name: "Golden Petal", price: "₹19,604", image_url: PHOTO, one_liner: "" }, caption: "", fallback_text: "Golden Petal — ₹19,604" };
    const w = world("o10-prod", cardFlow({ data }), { cards: true, render: "down" });
    const sends = await hi(w, "o10-prod");
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: TO, type: "image", image: { link: PHOTO, caption: "Golden Petal — ₹19,604" } }]);
  });

  it("render fails with no fallback configured → nothing extra is sent, the flow carries on", async () => {
    const w = world("o10-nofb", cardFlow({ data: { fallback_text: "" } }), { cards: true, render: "down" });
    expect(await hi(w, "o10-nofb")).toEqual([]);
    expect(runUpdates(w).at(-1)).toMatchObject({ status: "done" });
  });
});

// ------------------------------------------------------------------ card sender

describe("sendCardOrFallback", () => {
  const base = {
    organizationId: "o10-direct",
    contactId: "c1",
    conversationId: "cv1",
    phone: TO,
    sender: { phoneNumberId: "pn", accessToken: "tok" },
    kind: "customer_offer",
    vars: { headline: "Sale" },
    caption: "",
    fallback: "Sale",
    windowOpen: true,
  };

  it("cards off never calls the renderer", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ messages: [{ id: "w1" }] }));
    });
    const db = fakeDb(() => undefined);
    const res = await sendCardOrFallback(db.supabase, { ...base, cardsOn: false });
    expect(res).toMatchObject({ card: false, fallback: true, reason: "cards_off" });
    expect(calls.some((u) => u.includes("render-card"))).toBe(false);
  });

  it("window closed: no fallback either (it couldn't go)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ url: CARD_URL })));
    const db = fakeDb((op) => (op.table === "conversations" ? { data: { last_customer_message_at: "2020-01-01T00:00:00Z" }, error: null } : undefined));
    const res = await sendCardOrFallback(db.supabase, { ...base, organizationId: "o10-closed", cardsOn: true, windowOpen: false });
    expect(res.card).toBe(false);
    expect(res.fallback).toBe(false);
  });
});

// ------------------------------------------------------------------ the switch

describe("Cards page switch: Aiden's product answers and Show products", () => {
  it("default equals today's behaviour: on exactly when the cards flag is on", () => {
    expect(productCardsInAnswers(true, null)).toBe(true);
    expect(productCardsInAnswers(true, { brand_name: "Zoori" })).toBe(true);
    expect(productCardsInAnswers(false, null)).toBe(false);
    expect(productCardsInAnswers(false, { [PRODUCT_CARDS_SETTING]: true })).toBe(false);
    expect(productCardsInAnswers(true, { [PRODUCT_CARDS_SETTING]: false })).toBe(false);
  });

  it("cards flag off: nothing is read", async () => {
    const db = fakeDb(() => undefined);
    expect(await productCardsOn(db.supabase, "o", new Set(["ai_features"]))).toBe(false);
    expect(db.ops).toEqual([]);
  });

  it("can't read the switch: keeps today's behaviour", async () => {
    const db = fakeDb((op) => (op.table === "organizations" ? { data: null, error: { message: "down" } } : undefined));
    expect(await productCardsOn(db.supabase, "o", new Set(["cards"]))).toBe(true);
  });

  const pictures = (sends: Array<Record<string, unknown>>) => sends.map((s) => (s["image"] as { link: string } | undefined)?.link ?? null);

  it("Show products, cards on, switch untouched → first product as a card (as today)", async () => {
    const w = world("o10-show-on", SHOW_FLOW, { cards: true, products: ROWS });
    const sends = await hi(w, "o10-show-on");
    expect(pictures(sends)).toEqual([CARD_URL, ROWS[1]!.image_url]);
    expect(w.renders[0]).toMatchObject({ kind: "customer_product", vars: { name: "Golden Petal", price: "₹19,604", image_url: PHOTO } });
    expect((sends[0]!["image"] as { caption: string }).caption).toBe("Golden Petal — ₹19,604\nhttps://www.myzoori.com/product-detail/p1");
  });

  it("Show products, cards off → plain photos exactly as before, no renderer, no switch read", async () => {
    const w = world("o10-show-off", SHOW_FLOW, { cards: false, products: ROWS });
    const sends = await hi(w, "o10-show-off");
    expect(sends).toEqual([
      { messaging_product: "whatsapp", to: TO, type: "image", image: { link: PHOTO, caption: "Golden Petal — ₹19,604\nhttps://www.myzoori.com/product-detail/p1" } },
      { messaging_product: "whatsapp", to: TO, type: "image", image: { link: ROWS[1]!.image_url, caption: "Pearl Pavilion — ₹23,028\nhttps://www.myzoori.com/product-detail/p2" } },
    ]);
    expect(w.renders).toEqual([]);
    expect(readsSwitch(w)).toBe(false);
  });

  it("Show products, cards on, switch turned off → plain photos", async () => {
    const w = world("o10-show-sw", SHOW_FLOW, { cards: true, products: ROWS, branding: { [PRODUCT_CARDS_SETTING]: false } });
    const sends = await hi(w, "o10-show-sw");
    expect(pictures(sends)).toEqual([PHOTO, ROWS[1]!.image_url]);
    expect(w.renders).toEqual([]);
  });

  it("Show products, card render fails → the plain photo goes instead", async () => {
    const w = world("o10-show-down", SHOW_FLOW, { cards: true, products: ROWS, render: "down" });
    const sends = await hi(w, "o10-show-down");
    expect(pictures(sends)).toEqual([PHOTO, ROWS[1]!.image_url]);
  });

  // Aiden's reply path: runAgentOnInbound with a stubbed answer carrying products.
  async function aiden(org: string, flags: string[], branding: Record<string, unknown> = {}, render: "ok" | "down" = "ok") {
    const { runAgentOnInbound } = await import("./ai-agent.server");
    h.answer = {
      output: "Here are pendants under ₹25,000.",
      media: ROWS.map((r) => ({ title: r.title, imageUrl: r.image_url, price: r.price, currency: r.currency, productUrl: r.product_url, retailerId: null, category: r.category, inCatalog: false })),
    };
    const w = world(org, SHOW_FLOW, { cards: flags.includes("cards"), branding, render });
    vi.stubGlobal("fetch", w.fetch);
    const out = await runAgentOnInbound(w.supabase, {
      organizationId: org,
      conversationId: "cv1",
      contactId: "c1",
      phoneNumberId: "pn",
      accessToken: "tok",
      waId: TO,
      body: "pendants under 25k?",
      alreadyHandled: false,
      optedOut: false,
      prepared: Promise.resolve({ agentRow: { id: "agent-1", mode: "replying" }, flags: new Set(flags), aiEnabled: true, prelude: null }),
      gate: Promise.resolve({ assigned_to: null, needs_human: false, last_customer_message_at: new Date().toISOString() }),
    });
    return { w, out, sends: w.graphSends.map((s) => s.body) };
  }

  it("Aiden, cards on, switch untouched → first product as a card (as today)", async () => {
    const { w, sends, out } = await aiden("o10-aiden-on", ["ai_features", "cards"]);
    expect(out).toMatchObject({ acted: true, sent: true });
    expect(sends[0]).toMatchObject({ type: "text" });
    expect(pictures(sends.slice(1))).toEqual([CARD_URL, ROWS[1]!.image_url]);
    expect(w.renders).toHaveLength(1);
  });

  it("Aiden, cards off → plain photos, no renderer, no switch read", async () => {
    const { w, sends } = await aiden("o10-aiden-off", ["ai_features"]);
    expect(pictures(sends.slice(1))).toEqual([PHOTO, ROWS[1]!.image_url]);
    expect(w.renders).toEqual([]);
    expect(readsSwitch(w)).toBe(false);
  });

  it("Aiden, switch off → plain photos; render failure → plain photo instead of the card", async () => {
    const off = await aiden("o10-aiden-sw", ["ai_features", "cards"], { [PRODUCT_CARDS_SETTING]: false });
    expect(pictures(off.sends.slice(1))).toEqual([PHOTO, ROWS[1]!.image_url]);
    expect(off.w.renders).toEqual([]);
    const down = await aiden("o10-aiden-down", ["ai_features", "cards"], {}, "down");
    expect(pictures(down.sends.slice(1))).toEqual([PHOTO, ROWS[1]!.image_url]);
  });
});

// ------------------------------------------------------------------ flows list

describe("flows list: responses line", () => {
  it("count and the newest run's relative time", () => {
    const rel = () => "3 hr ago";
    expect(responsesLine({ count: 0, last: null }, rel)).toBe("No responses yet");
    expect(responsesLine({ count: 1, last: "2026-10-05T07:00:00Z" }, rel)).toBe("1 response · last 3 hr ago");
    expect(responsesLine({ count: 12500, last: "2026-10-05T07:00:00Z" }, rel)).toBe("12,500 responses · last 3 hr ago");
  });
});
