/**
 * Batch 49: extra fake data for Automate (Aiden, Flows, Automations) and Shop
 * (Catalogue, Collections), layered over fake-backend.mjs without changing
 * it. Requests these screens make are answered here; everything else goes to
 * the shared fake backend. Fictional data only; nothing leaves the browser.
 */
import { BACKEND, createBackend } from "./fake-backend.mjs";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function parse(url) {
  const u = new URL(url);
  const table = u.pathname.replace(/^\/rest\/v1\//, "");
  const filters = {};
  for (const [k, v] of u.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(k) || k.includes(".")) continue;
    const m = /^(eq|neq|in|is|like|ilike|gte|lte|gt|lt)\.(.*)$/.exec(v);
    if (m) filters[k] = { op: m[1], value: m[2] };
  }
  return { table, filters, params: u.searchParams };
}

function applyFilters(rows, filters) {
  return rows.filter((r) =>
    Object.entries(filters).every(([k, f]) => {
      if (!(k in r)) return true;
      const v = r[k];
      if (f.op === "eq") return String(v) === f.value;
      if (f.op === "neq") return String(v) !== f.value;
      if (f.op === "in") return f.value.replace(/[()"]/g, "").split(",").includes(String(v));
      if (f.op === "is") return f.value === "null" ? v === null : String(v) === f.value;
      if (f.op === "like") return new RegExp(`^${f.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(String(v));
      return true;
    }),
  );
}

/* ---------- Aiden ---------- */

const SOURCES = [
  { id: "s1", type: "website", name: "kesar.example", status: "ready", item_count: 126, last_synced_at: ago(2 * DAY), last_error: null, config: { url: "https://kesar.example" }, reading: { unread: 0, plan_cap: 200, paid: false, tonight: 0, refresh_days: 0, auto_refresh: false, can_read_more: false, changes_available_at: null } },
  { id: "s2", type: "pdf", name: "Return policy.pdf", status: "ready", item_count: 14, last_synced_at: ago(9 * DAY), last_error: null },
  { id: "s3", type: "spreadsheet", name: "Ring sizes.xlsx", status: "ready", item_count: 6, last_synced_at: ago(20 * DAY), last_error: null },
  { id: "s4", type: "manual_qa", name: "Your answers", status: "ready", item_count: 9, last_synced_at: ago(DAY), last_error: null },
];

function overview(mode, aiEnabled) {
  return {
    agent: { id: "ag1", name: "Aiden", avatar: null, mode },
    settings: { ai_enabled: aiEnabled, ai_monthly_cap_amount: 2000, currency: "INR", brain_choice: "recommended" },
    spend_this_month: 412.6,
    tiers: [
      { key: "fast", display_name: "Quick", plain_description: "Short, fast answers.", speed_text: "Fastest", quality_text: "Good", relative_cost_text: "Lowest cost" },
      { key: "careful", display_name: "Careful", plain_description: "Reads more before answering.", speed_text: "A little slower", quality_text: "Best", relative_cost_text: "Higher cost" },
    ],
    task_models: [],
    instructions: [
      {
        id: "i1", persona_name: "Aiden", tone: "Warm and short", instructions: "Help customers find jewellery and track orders.",
        escalation_rules: "Discounts and custom orders go to Riya.", handover_message: "Let me check with the team and get back to you.",
        languages: ["English", "Hindi"], working_hours_behaviour: "reply", version: 3, is_current: true, updated_at: ago(5 * DAY), origin: "owner",
      },
    ],
    sources: SOURCES,
    tools: [
      { name: "catalog_search", description: "Find products in your catalogue", access: "read", feature: "catalogs", available: true, reason: null },
      { name: "order_status", description: "Look up a Shopify order", access: "read", feature: "shopify", available: true, reason: null },
    ],
    week: { answered: 284, passed: 17, refused: 3 },
    tested_recently: true,
    can_configure: true,
  };
}

const QUESTIONS = [
  "Is the Meenakari set available in red?",
  "Do you ship to Dubai?",
  "What is the price of the temple jhumkas?",
];

const GAPS = [
  { id: "g1", question: "Do you ship to Dubai?", status: "pending", source: "customer", conversation_id: uuid(1003), created_at: ago(2 * HOUR) },
  { id: "g2", question: "Can you make the bangles in 22 carat instead of 18?", status: "pending", source: "customer", conversation_id: uuid(1005), created_at: ago(7 * HOUR) },
  { id: "g3", question: "Is there a discount on two sets for a wedding?", status: "pending", source: "customer", conversation_id: uuid(1007), created_at: ago(DAY) },
];

const WORK = [
  { id: "w1", task: "agent_reply", tier: null, status: "escalated", escalation_signal: "merchant_rule", billed_amount: 0.4, cost_source: "platform", latency_ms: 1800, input_summary: "Can I get ₹2,000 off if I take both earrings today?", output: "Let me check with the team and get back to you.", sources: [], created_at: ago(3 * HOUR) },
  { id: "w2", task: "agent_reply", tier: null, status: "ok", escalation_signal: null, billed_amount: 0.3, cost_source: "platform", latency_ms: 1400, input_summary: "What are your store timings on Sunday?", output: "We're open 11 am to 8 pm on Sundays.", sources: [], created_at: ago(4 * HOUR) },
  { id: "w3", task: "agent_reply", tier: null, status: "refused", escalation_signal: "no_source", billed_amount: 0, cost_source: "platform", latency_ms: 900, input_summary: "Do you buy back old gold?", output: "", sources: [], created_at: ago(DAY + 2 * HOUR) },
];

function playground(question) {
  const ring = `${BACKEND}/media/ring.svg`;
  const shop = /meenakari|red|set|price|jhumka/i.test(question);
  return {
    runId: "pg1",
    status: "ok",
    output: shop
      ? "Yes! The Meenakari set comes in red and green. The red one is ₹24,500 and ships in 2 days. Shall I keep one for you?"
      : "We deliver across India in 3 to 5 days. For other countries I'll check with the team.",
    sources: [{ kind: "knowledge", label: "kesar.example/meenakari" }],
    toolCalls: [],
    media: shop ? [{ imageUrl: ring, title: "Meenakari bridal set, red", price: 24500, currency: "INR" }] : [],
    escalationSignal: null,
    billedAmount: 0.42,
    billedCurrency: "INR",
    costKnown: true,
    latencyMs: 1700,
    tier: "default",
    brainName: "Careful",
  };
}

/* ---------- Flows ---------- */

const F_WELCOME = uuid(8001);
const F_ORDER = uuid(8002);
const F_FESTIVE = uuid(8003);
const F_DELETED = uuid(8004);

const node = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data });
const edge = (source, target, sourceHandle = "next") => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

const GRAPHS = {
  [F_WELCOME]: {
    nodes: [
      node("start", "start", 40, 160),
      node("menu", "buttons", 340, 140, { text: "Hi {{name}}! How can we help today?", buttons: [{ id: "b1", title: "Browse jewellery" }, { id: "b2", title: "Order status" }, { id: "b3", title: "Talk to us" }] }),
      node("shop", "show_products", 680, 20, { category: "Earrings", max_items: 5 }),
      node("ask", "ask", 680, 220, { text: "Please send your order number.", variable: "order_no", label: "Order number" }),
      node("team", "assign", 680, 420, { mode: "round_robin" }),
      node("end", "end", 1000, 220),
    ],
    edges: [edge("start", "menu"), edge("menu", "shop", "b1"), edge("menu", "ask", "b2"), edge("menu", "team", "b3"), edge("ask", "end")],
  },
  [F_ORDER]: {
    nodes: [
      node("start", "start", 40, 120),
      node("ask", "ask", 340, 100, { text: "What's your order number?", variable: "order_no", label: "Order number" }),
      node("check", "http", 640, 100, { method: "GET", url: "https://kesar.example/api/orders/{{order_no}}", label: "Look up the order" }),
      node("reply", "text", 940, 40, { text: "Your order {{order_no}} is on its way!" }),
      node("fail", "needs_you", 940, 220, { note: "Order not found" }),
    ],
    edges: [edge("start", "ask"), edge("ask", "check"), edge("check", "reply", "success"), edge("check", "fail", "failed")],
  },
  [F_FESTIVE]: {
    nodes: [
      node("start", "start", 40, 100),
      node("wait", "wait", 340, 100, { minutes: 1440 }),
      node("card", "send_card", 640, 100, { kind: "customer_offer", vars: {} }),
      node("tag", "tag", 940, 100, { tag: "Diwali 2026", action: "add" }),
    ],
    edges: [edge("start", "wait"), edge("wait", "card"), edge("card", "tag")],
  },
  [F_DELETED]: { nodes: [node("start", "start", 40, 100), node("t", "text", 340, 100, { text: "Old greeting" })], edges: [edge("start", "t")] },
};

const FLOWS = [
  { id: F_WELCOME, organization_id: ORG, key: "v2:welcome", name: "Welcome menu", is_enabled: true, updated_at: ago(2 * HOUR), config: {}, whatsapp_account_id: null },
  { id: F_ORDER, organization_id: ORG, key: "v2:order", name: "Order status", is_enabled: true, updated_at: ago(DAY), config: {}, whatsapp_account_id: null },
  { id: F_FESTIVE, organization_id: ORG, key: "v2:festive", name: "Diwali offer follow-up", is_enabled: false, updated_at: ago(3 * DAY), config: {}, whatsapp_account_id: null },
  { id: F_DELETED, organization_id: ORG, key: "v2:old", name: "Old greeting", is_enabled: false, updated_at: ago(6 * DAY), config: { deleted_at: ago(4 * DAY) }, whatsapp_account_id: null },
  { id: uuid(8101), organization_id: ORG, key: "abandoned_checkout", name: "Abandoned checkout", is_enabled: true, whatsapp_account_id: ACCOUNT, config: {} },
  { id: uuid(8102), organization_id: ORG, key: "order_fulfilled", name: "Order shipped", is_enabled: true, whatsapp_account_id: ACCOUNT, config: {} },
];

const VERSIONS = [
  { id: uuid(8201), organization_id: ORG, flow_id: F_WELCOME, version: 4, status: "published", published_at: ago(2 * HOUR), created_at: ago(2 * HOUR), graph: GRAPHS[F_WELCOME] },
  { id: uuid(8202), organization_id: ORG, flow_id: F_ORDER, version: 2, status: "published", published_at: ago(DAY), created_at: ago(DAY), graph: GRAPHS[F_ORDER] },
  { id: uuid(8203), organization_id: ORG, flow_id: F_FESTIVE, version: 1, status: "draft", published_at: null, created_at: ago(3 * DAY), graph: GRAPHS[F_FESTIVE] },
  { id: uuid(8204), organization_id: ORG, flow_id: F_DELETED, version: 1, status: "published", published_at: ago(6 * DAY), created_at: ago(6 * DAY), graph: GRAPHS[F_DELETED] },
];

const TRIGGERS = [
  { id: "t1", organization_id: ORG, flow_id: F_WELCOME, kind: "first_message", config: {}, is_enabled: true, created_at: ago(30 * DAY) },
  { id: "t2", organization_id: ORG, flow_id: F_WELCOME, kind: "keyword", config: { keywords: ["menu", "hi"] }, is_enabled: true, created_at: ago(30 * DAY) },
  { id: "t3", organization_id: ORG, flow_id: F_ORDER, kind: "keyword", config: { keywords: ["order", "track"] }, is_enabled: true, created_at: ago(20 * DAY) },
  { id: "t4", organization_id: ORG, flow_id: F_FESTIVE, kind: "campaign_button", config: {}, is_enabled: true, created_at: ago(3 * DAY) },
];

const PEOPLE = ["Asha Iyer", "Vikram Mehta", "Meera Nair", "Rohan Reddy", "Kavya Shah", "Farhan Khan"];
const RUNS = PEOPLE.flatMap((_, i) => {
  const flow = i % 3 === 2 ? F_ORDER : F_WELCOME;
  return [{
    id: uuid(8300 + i), organization_id: ORG, flow_id: flow, version_id: flow === F_WELCOME ? uuid(8201) : uuid(8202), contact_id: uuid(8400 + i),
    status: ["done", "waiting", "done", "failed", "done", "running"][i], started_at: ago(i * 47 * MIN + 6 * MIN), ended_at: i % 2 === 0 ? ago(i * 47 * MIN) : null,
    current_node_id: i === 1 ? "ask" : null, trigger: { kind: i % 2 ? "keyword" : "first_message" }, last_error: i === 3 ? "The order look-up didn't answer." : null,
  }];
});

function eventsFor(run, i) {
  const t0 = new Date(run.started_at).getTime();
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const rows = [{ node_id: "start", event: "started", at: at(0) }];
  if (run.flow_id === F_WELCOME) {
    rows.push({ node_id: "menu", event: "send", at: at(1) }, { node_id: "menu", event: "reply", at: at(40) });
    if (i === 1) rows.push({ node_id: "ask", event: "send", at: at(42) });
    else if (i === 5) rows.push({ node_id: "shop", event: "products_shown", at: at(41) });
    else rows.push({ node_id: "ask", event: "send", at: at(42) }, { node_id: "ask", event: "reply", at: at(95) }, { node_id: "end", event: "ended", at: at(96) });
  } else {
    rows.push({ node_id: "ask", event: "send", at: at(1) }, { node_id: "ask", event: "reply", at: at(30) }, { node_id: "check", event: i === 3 ? "http_failed" : "http_ok", at: at(31) });
    rows.push(i === 3 ? { node_id: "check", event: "failed", at: at(32) } : { node_id: "reply", event: "send", at: at(32) });
  }
  return rows.map((r, k) => ({ id: `${run.id}-${k}`, organization_id: ORG, run_id: run.id, detail: {}, ...r }));
}
const EVENTS = RUNS.flatMap((r, i) => eventsFor(r, i));
const CONTACTS = PEOPLE.map((name, i) => ({ id: uuid(8400 + i), organization_id: ORG, name, phone: `+91981100${String(1000 + i)}` }));

/* ---------- Automations ---------- */

const AUTOMATIONS = [
  { id: "a1", organization_id: ORG, name: "Welcome new customers", trigger_type: "welcome", config: {}, message_body: "Namaste {{name}}! Welcome to Kesar & Co. Ask us anything about our jewellery.", is_active: true, priority: 1, created_by: null, created_at: ago(40 * DAY), updated_at: ago(5 * DAY) },
  { id: "a2", organization_id: ORG, name: "Price list", trigger_type: "keyword", config: { keywords: ["price", "rate"], match: "contains" }, message_body: "Today's gold rate and our price list: kesar.example/prices", is_active: true, priority: 2, created_by: null, created_at: ago(30 * DAY), updated_at: ago(3 * DAY) },
  { id: "a3", organization_id: ORG, name: "Store address", trigger_type: "keyword", config: { keywords: ["address", "location"], match: "exact" }, message_body: "We're at 14 MG Road, Pune. Open 11 am to 8 pm.", is_active: false, priority: 3, created_by: null, created_at: ago(25 * DAY), updated_at: ago(10 * DAY) },
  { id: "a4", organization_id: ORG, name: "After hours", trigger_type: "away", config: { days: [0, 1, 2, 3, 4, 5, 6], start: "20:00", end: "11:00" }, message_body: "We're closed right now. We'll reply first thing in the morning!", is_active: true, priority: 4, created_by: null, created_at: ago(20 * DAY), updated_at: ago(2 * DAY) },
];
const AUTOMATION_RUNS = [
  { automation_id: "a1", created_at: ago(40 * MIN), status: "sent" },
  { automation_id: "a2", created_at: ago(3 * HOUR), status: "sent" },
  { automation_id: "a4", created_at: ago(14 * HOUR), status: "sent" },
];

/* ---------- Shop ---------- */

const PRODUCT_NAMES = [
  ["Meenakari bridal set", "Necklaces", 24500, 27000],
  ["Temple jhumkas", "Earrings", 8900, null],
  ["Rose-gold solitaire ring", "Rings", 18200, null],
  ["Kundan choker", "Necklaces", 31500, 34000],
  ["Pearl drop earrings", "Earrings", 5600, null],
  ["Antique gold bangles (pair)", "Bangles", 42800, null],
  ["Polki maang tikka", "Hair jewellery", 12400, null],
  ["Silver anklets", "Anklets", 3200, 3800],
];
const PRODUCTS = PRODUCT_NAMES.map(([title, category, price, compare], i) => ({
  id: uuid(9000 + i), organization_id: ORG, integration_id: null, external_id: `KC-${100 + i}`, title, description: `${title} from our festive collection.`,
  sku: `KC-${100 + i}`, brand: "Kesar & Co.", category, price, compare_at_price: compare, currency: "INR",
  availability: i === 6 ? "out_of_stock" : "in_stock", inventory_quantity: i === 6 ? 0 : 4 + i, image_url: i === 7 ? null : `${BACKEND}/media/p${i}.svg`,
  additional_image_urls: [], product_url: `https://kesar.example/p/${100 + i}`, source: i < 5 ? "crawl" : "shopify", is_visible: i !== 4,
  synced_at: ago(DAY), updated_at: ago((i + 1) * HOUR), meta_synced_at: i < 4 ? ago(DAY) : null,
}));
const COLLECTIONS = [
  { id: "c1", organization_id: ORG, name: "Bridal edit", slug: "bridal-edit", description: "Sets and chokers for the wedding season", image_url: null, sort_order: 1 },
  { id: "c2", organization_id: ORG, name: "Everyday earrings", slug: "everyday-earrings", description: "Light pieces under ₹10,000", image_url: null, sort_order: 2 },
  { id: "c3", organization_id: ORG, name: "Diwali gifts", slug: "diwali-gifts", description: null, image_url: null, sort_order: 3 },
];
const COLLECTION_ITEMS = [
  ["c1", 0], ["c1", 3], ["c1", 6], ["c2", 1], ["c2", 4], ["c3", 2], ["c3", 5], ["c3", 7],
].map(([collection_id, i]) => ({ organization_id: ORG, collection_id, product_id: PRODUCTS[i].id }));

export function createB49Backend(options = {}) {
  const base = createBackend(options);
  const state = { mode: options.aidenMode ?? "replying", aiEnabled: options.aiEnabled ?? true };
  const empty = options.empty === true;

  const tables = {
    feature_flags: () =>
      ["inbox", "contacts", "campaigns", "templates", "automations", "analytics", "compliance", "settings", "team", "ai_features", "shopify", "flows",
        "revenue_attribution", "billing", "catalogs", "cards", "wa_forms", "flows_v2", "public_api", "whatsapp_catalog"].map((key) => ({ key, default_enabled: true })),
    flows: () => (empty ? FLOWS.filter((f) => !f.key.startsWith("v2:")) : FLOWS),
    flow_versions: () => VERSIONS,
    flow_triggers: () => TRIGGERS,
    flow_runs: () => (empty ? [] : RUNS),
    flow_run_events: () => EVENTS,
    contacts: (q) => (q.filters.id ? CONTACTS : null),
    scheduled_sends: () => [],
    automations: () => (empty ? [] : AUTOMATIONS),
    automation_runs: () => AUTOMATION_RUNS,
    products: () => (empty ? [] : PRODUCTS),
    product_collections: () => (empty ? [] : COLLECTIONS),
    product_collection_items: () => COLLECTION_ITEMS,
    whatsapp_catalogs: () => [{ waba_id: "waba1", status: "active", mode: "pushed", pushed_count: 7, last_sync_at: ago(3 * HOUR), catalog_name: "Kesar & Co. shop", is_catalog_visible: true, is_cart_enabled: true }],
    knowledge_sources: () => [{ id: "s1", status: "ready" }],
    pending_owner_replies: () => GAPS,
    ai_agents: () => [{ organization_id: ORG, is_default: true, mode: state.mode }],
  };

  async function backend(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" || request.method() === "HEAD") {
      const q = parse(request.url());
      const make = url.pathname.startsWith("/rest/v1/") ? tables[q.table] : null;
      const made = make ? make(q) : null;
      if (made) {
        let rows = applyFilters(made, q.filters);
        const limit = Number(q.params.get("limit") ?? "0");
        if (limit) rows = rows.slice(0, limit);
        const headers = {
          "content-type": "application/json",
          "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "content-range",
        };
        if (request.method() === "HEAD") return route.fulfill({ status: 200, headers, body: "" });
        if ((request.headers()["accept"] ?? "").includes("vnd.pgrst.object")) {
          if (!rows.length) return route.fulfill({ status: 406, headers, body: JSON.stringify({ code: "PGRST116", message: "no rows" }) });
          return route.fulfill({ status: 200, headers, body: JSON.stringify(rows[0]) });
        }
        return route.fulfill({ status: 200, headers, body: JSON.stringify(rows) });
      }
    }
    return base.backend(route);
  }

  async function api(route) {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try {
      body = JSON.parse(request.postData() || "{}");
    } catch {
      body = {};
    }
    const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname === "/api/ai/employee") {
      if (body.action === "overview") return json(overview(state.mode, state.aiEnabled));
      if (body.action === "questions") return json({ questions: QUESTIONS });
      if (body.action === "work") return json({ runs: empty ? [] : WORK });
      if (body.action === "weekly_report") return json({ report: { since: ago(7 * DAY), answered: 284, passed: 17, cost: 96.4, learn: [{ question: "Do you ship to Dubai?", times: 4, last_at: ago(2 * HOUR) }] } });
      if (body.action === "set_mode") {
        state.mode = String(body.mode);
        return json({ ok: true, mode: state.mode });
      }
      if (body.action === "save_settings") {
        if (typeof body.ai_enabled === "boolean") state.aiEnabled = body.ai_enabled;
        return json({ ok: true });
      }
      return json({});
    }
    if (url.pathname === "/api/ai/knowledge") {
      if (body.action === "list") return json({ sources: SOURCES });
      if (body.action === "gaps") return json({ gaps: empty ? [] : GAPS, total: empty ? 0 : GAPS.length, waiting: empty ? 0 : GAPS.length, page: 0, page_size: 20 });
      if (body.action === "price_reviews") return json({ reviews: [] });
      if (body.action === "corrections") return json({ corrections: [] });
      return json({ ok: true });
    }
    if (url.pathname === "/api/internal/ai-run" && body.action === "playground") {
      await new Promise((r) => setTimeout(r, 400));
      return json({ run: playground(String(body.question ?? "")) });
    }
    if (url.pathname === "/api/onboarding/start") return json({});
    if (url.pathname === "/api/flows/triggers" && body.action === "node_stats") {
      return json({ ok: true, stats: { menu: { entered: 214, exited: 209, dropped: 5 }, ask: { entered: 71, exited: 66, dropped: 5 }, shop: { entered: 98, exited: 98, dropped: 0 } } });
    }
    if (url.pathname === "/api/whatsapp/catalog") return json({ ok: true });
    return base.api(route);
  }

  return { ...base, backend, api };
}
