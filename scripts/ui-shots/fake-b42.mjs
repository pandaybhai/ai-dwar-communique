/**
 * Batch 42: made-up data for the Flows, Contacts and AI employee screenshots.
 * Same fictional shop as fake-backend.mjs (Kesar & Co.); nothing here is real.
 */

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ------------------------------------------------------------------ Flows

const STORE_FLOWS = [
  { n: 6000, key: "abandoned_checkout", name: "Abandoned checkout", on: true, cls: "marketing" },
  { n: 6001, key: "order_lifecycle", name: "Order updates", on: true, cls: "transactional" },
  { n: 6002, key: "review_request", name: "Review request", on: false, cls: "marketing" },
  { n: 6003, key: "winback", name: "Win back", on: false, cls: "marketing" },
];

/** A chat-flow graph laid out left to right. */
function graph(nodes, edges) {
  return {
    nodes: nodes.map(([nid, type, data, x, y]) => ({ id: nid, type, data, position: { x, y } })),
    edges: edges.map(([s, t, h], i) => ({ id: `e${i}`, source: s, target: t, sourceHandle: h ?? "next" })),
  };
}

const WELCOME = graph(
  [
    ["start", "start", {}, 0, 160],
    ["menu", "buttons", { text: "Namaste {{name}}! 🙏 Welcome to Kesar & Co. How can we help today?", buttons: [{ id: "b1", title: "Shop the Diwali edit" }, { id: "b2", title: "Track my order" }, { id: "b3", title: "Talk to us" }] }, 320, 120],
    ["shop", "show_products", { category: "Diwali edit", max_items: 5, budget: "" }, 680, 0],
    ["track", "ask", { text: "Please share your order number (like KC-2041).", variable: "order_no", validation: "text", retries: 2, on_unexpected: "repeat", timeout_minutes: 1440 }, 680, 220],
    ["team", "assign", { mode: "round_robin" }, 680, 440],
    ["tag", "tag", { tag: "Diwali shopper", action: "add" }, 1040, 0],
    ["found", "text", { text: "Thanks! Your order {{order_no}} is on its way 📦" }, 1040, 220],
    ["end", "end", {}, 1380, 140],
  ],
  [["start", "menu"], ["menu", "shop", "b1"], ["menu", "track", "b2"], ["menu", "team", "b3"], ["shop", "tag"], ["tag", "end"], ["track", "found"], ["found", "end"]],
);

const WEDDING = graph(
  [
    ["start", "start", {}, 0, 120],
    ["date", "ask", { text: "Congratulations! 💍 When is the wedding?", variable: "wedding_date", validation: "date", retries: 1, on_unexpected: "repeat", timeout_minutes: 1440 }, 320, 120],
    ["budget", "list", { text: "What's your budget for the bridal set?", button_text: "Choose", variable: "budget", rows: [{ id: "r1", title: "Under ₹50,000" }, { id: "r2", title: "₹50,000 – ₹1.5 lakh" }, { id: "r3", title: "Above ₹1.5 lakh" }] }, 660, 120],
    ["hours", "business_hours", {}, 1000, 120],
    ["assign", "assign", { mode: "round_robin" }, 1340, 40],
    ["away", "text", { text: "Our bridal stylist will call you at 10 am tomorrow ✨" }, 1340, 240],
  ],
  [["start", "date"], ["date", "budget"], ["budget", "hours", "r1"], ["budget", "hours", "r2"], ["budget", "hours", "r3"], ["hours", "assign", "open"], ["hours", "away", "closed"]],
);

const ORDER_STATUS = graph(
  [
    ["start", "start", {}, 0, 80],
    ["ask", "ask", { text: "What's your order number?", variable: "order_no", validation: "text", retries: 2, on_unexpected: "repeat", timeout_minutes: 60 }, 320, 80],
    ["lookup", "http", { method: "GET", url: "https://kesar.example/api/orders/{{order_no}}", headers: [], save: [] }, 660, 80],
    ["reply", "text", { text: "Your order {{order_no}} is {{status}}." }, 1000, 0],
    ["fail", "needs_you", { note: "Couldn't find the order" }, 1000, 200],
  ],
  [["start", "ask"], ["ask", "lookup"], ["lookup", "reply", "success"], ["lookup", "fail", "failed"]],
);

const LEADS = graph(
  [
    ["start", "start", {}, 0, 80],
    ["need", "list", { text: "What are you looking for?", button_text: "Choose", variable: "need", rows: [{ id: "r1", title: "New order" }, { id: "r2", title: "Bulk / wholesale" }] }, 320, 80],
    ["email", "ask", { text: "What's your email?", variable: "email", validation: "email" }, 660, 80],
    ["tag", "tag", { tag: "", action: "add" }, 1000, 80],
  ],
  [["start", "need"], ["need", "email", "r1"], ["need", "email", "r2"], ["email", "tag"]],
);

const CHAT_FLOWS = [
  { n: 6100, name: "Welcome menu", on: true, published: true, graph: WELCOME, updated: 2 * HOUR, runs: 1284, last: 6 * MIN },
  { n: 6101, name: "Wedding enquiries", on: true, published: true, graph: WEDDING, updated: DAY, runs: 342, last: 50 * MIN },
  { n: 6102, name: "Order status lookup", on: false, published: true, graph: ORDER_STATUS, updated: 4 * DAY, runs: 97, last: 4 * DAY },
  { n: 6103, name: "Wholesale leads", on: false, published: false, graph: LEADS, updated: 20 * MIN, runs: 0, last: null },
  { n: 6104, name: "Old Navratri menu", on: false, published: true, graph: LEADS, updated: 12 * DAY, runs: 61, last: 12 * DAY, deleted: 3 * DAY },
];

export function makeFlows() {
  return [
    ...STORE_FLOWS.map((f) => ({
      id: id(f.n), organization_id: ORG, key: f.key, name: f.name, is_enabled: f.on, whatsapp_account_id: null,
      config: { message_class: f.cls }, updated_at: ago(3 * DAY),
    })),
    ...CHAT_FLOWS.map((f) => ({
      id: id(f.n), organization_id: ORG, key: `v2:${f.n}`, name: f.name, is_enabled: f.on, whatsapp_account_id: null,
      config: f.deleted ? { deleted_at: ago(f.deleted) } : {}, updated_at: ago(f.updated),
    })),
  ];
}

export const FIRST_CHAT_FLOW = id(6100);

export function makeFlowSteps() {
  const rows = [];
  STORE_FLOWS.forEach((f, i) => {
    const count = i === 1 ? 3 : 2;
    for (let s = 0; s < count; s += 1)
      rows.push({ id: id(6200 + i * 10 + s), flow_id: id(f.n), step_order: s + 1, delay_minutes: (s + 1) * 60, template_id: id(8000), condition: null, is_enabled: true });
  });
  return rows;
}

export function makeScheduledSends() {
  const rows = [];
  const add = (flow, status, n) => {
    for (let i = 0; i < n; i += 1) rows.push({ flow_id: id(flow), status });
  };
  add(6000, "sent", 214); add(6000, "scheduled", 18); add(6000, "skipped", 9); add(6000, "cancelled", 41);
  add(6001, "sent", 532); add(6001, "scheduled", 27); add(6001, "skipped", 2);
  return rows;
}

export function makeFlowVersions() {
  const rows = [];
  for (const f of CHAT_FLOWS) {
    if (f.published) rows.push({ id: id(f.n + 300), flow_id: id(f.n), organization_id: ORG, version: 3, status: "published", published_at: ago(f.updated + DAY), created_at: ago(f.updated + DAY), graph: f.graph });
    rows.push({ id: id(f.n + 400), flow_id: id(f.n), organization_id: ORG, version: 4, status: "draft", published_at: null, created_at: ago(f.updated), graph: f.graph });
    if (f.published) rows.push({ id: id(f.n + 500), flow_id: id(f.n), organization_id: ORG, version: 2, status: "archived", published_at: ago(f.updated + 9 * DAY), created_at: ago(f.updated + 9 * DAY), graph: f.graph });
  }
  return rows.sort((a, b) => b.version - a.version);
}

export function makeFlowTriggers() {
  return [
    { id: id(6600), flow_id: id(6100), kind: "keyword", config: { keywords: ["hi", "hello", "menu"], match: "exact" }, is_enabled: true, created_at: ago(30 * DAY) },
    { id: id(6601), flow_id: id(6100), kind: "first_message", config: {}, is_enabled: true, created_at: ago(30 * DAY) },
    { id: id(6602), flow_id: id(6101), kind: "ctwa_ad", config: {}, is_enabled: true, created_at: ago(20 * DAY) },
    { id: id(6603), flow_id: id(6102), kind: "keyword", config: { keywords: ["track", "order status"], match: "contains" }, is_enabled: true, created_at: ago(15 * DAY) },
  ];
}

/** Runs per chat flow: only what the list counts (flow_id, started_at). */
export function makeFlowRuns() {
  const rows = [];
  for (const f of CHAT_FLOWS) {
    const n = Math.min(f.runs, 40);
    for (let i = 0; i < n; i += 1) rows.push({ id: id(700000 + f.n * 50 + i), flow_id: id(f.n), organization_id: ORG, started_at: ago((f.last ?? 0) + i * 3 * HOUR) });
  }
  return rows;
}
/** The list counts with HEAD; the real totals are larger than the 40 rows drawn. */
export function flowRunTotal(flowId) {
  return CHAT_FLOWS.find((f) => id(f.n) === flowId)?.runs ?? null;
}

export function nodeStats() {
  return {
    start: { entered: 1284, exited: 1284, dropped: 0 },
    menu: { entered: 1284, exited: 1102, dropped: 182 },
    shop: { entered: 611, exited: 604, dropped: 7 },
    track: { entered: 356, exited: 318, dropped: 38 },
    team: { entered: 135, exited: 135, dropped: 0 },
    tag: { entered: 604, exited: 604, dropped: 0 },
    found: { entered: 318, exited: 318, dropped: 0 },
  };
}

const RUN_NAMES = ["Asha Iyer", "Vikram Mehta", "Meera Nair", "Rohan Reddy", "Kavya Shah", "Ishita Das", "Farhan Khan", "Priya Joshi"];
export function makeResponses() {
  const statuses = ["finished", "waiting", "finished", "stopped", "finished", "failed", "finished", "waiting"];
  return {
    columns: [
      { key: "order_no", label: "order_no", kind: "variable" },
      { key: "last_choice", label: "Menu choice", kind: "variable" },
    ],
    rows: RUN_NAMES.map((name, i) => ({
      run_id: id(710000 + i),
      contact_id: id(5000 + i),
      conversation_id: id(1000 + i),
      name,
      phone: `+9198${String(20000000 + i * 104729).slice(0, 8)}`,
      started_at: ago(6 * MIN + i * 97 * MIN),
      status: statuses[i],
      step: statuses[i] === "finished" ? null : ["Track my order", "Menu", "Menu", "Track my order"][i % 4],
      version: 3,
      answers: i % 3 === 1 ? { order_no: `KC-20${41 + i}`, last_choice: "Track my order" } : { last_choice: i % 2 ? "Talk to us" : "Shop the Diwali edit" },
    })),
    total: 1284,
    page_size: 25,
    summary: {
      started: 1284,
      finished: 1046,
      completion_rate: 81,
      drop_off: [
        { node_id: "menu", label: "Menu", count: 182 },
        { node_id: "track", label: "Order number", count: 38 },
      ],
    },
  };
}

// ------------------------------------------------------------------ Contacts

export const TAGS = [
  { id: "t1", name: "VIP", color: "#10B981" },
  { id: "t2", name: "Wedding season", color: "#8B5CF6" },
  { id: "t3", name: "Repeat buyer", color: "#0EA5A4" },
  { id: "t4", name: "COD", color: "#F59E0B" },
  { id: "t5", name: "Instagram lead", color: "#EF4444" },
  { id: "t6", name: "Wholesale", color: "#6366F1" },
];

const SOURCES = ["ctwa_instagram", "import", "direct", "website", "ctwa_facebook", "manual", "import", "direct"];

/** Contacts drawn from the Inbox's conversations, so a drawer finds its chat. */
export function makeContacts(conversations) {
  return conversations.map((c, i) => ({
    ...c.contact,
    wa_id: c.contact.phone.replace(/\D/g, ""),
    opt_in_status: i === 4 || i === 13 ? "opted_out" : i % 5 === 2 ? "unknown" : "opted_in",
    attributes: i % 3 === 0 ? { city: ["Jaipur", "Pune", "Mumbai", "Delhi"][i % 4], ring_size: String(10 + (i % 5)) } : {},
    source: SOURCES[i % SOURCES.length],
    source_detail: i % 8 === 0 ? { headline: "Diwali Meenakari edit — 15% off", source_id: "120208812345678" } : null,
    created_at: ago((i + 1) * 2 * DAY + i * HOUR),
    updated_at: ago(i * HOUR),
    opt_in_source: i % 5 === 2 ? null : "import",
    opted_in_at: ago(20 * DAY),
  }));
}

export function makeContactTags(contacts) {
  const rows = [];
  contacts.forEach((c, i) => {
    const picks = [[0, 2], [1], [], [4], [0], [3, 2], [5], [1, 4]][i % 8];
    for (const t of picks) rows.push({ contact_id: c.id, organization_id: ORG, tag_id: TAGS[t].id, tags: TAGS[t] });
  });
  return rows;
}

export function makeOrders(contactId) {
  return [
    { id: "o1", contact_id: contactId, order_number: "#KC-2041", financial_status: "paid", fulfillment_status: "fulfilled", is_cod: false, currency: "INR", total: 36500, placed_at: ago(5 * DAY), delivered_at: ago(2 * DAY), cancelled_at: null },
    { id: "o2", contact_id: contactId, order_number: "#KC-1876", financial_status: "pending", fulfillment_status: null, is_cod: true, currency: "INR", total: 8900, placed_at: ago(41 * DAY), delivered_at: null, cancelled_at: null },
  ];
}

export function contactRuns() {
  return {
    runs: [
      {
        id: "r1", flow_id: id(6100), flow_name: "Welcome menu", status: "finished", started_at: ago(2 * DAY), ended_at: ago(2 * DAY - 4 * MIN), trigger: { kind: "keyword" },
        events: [
          { node_id: "start", event: "started", at: ago(2 * DAY) },
          { node_id: "menu", event: "send", at: ago(2 * DAY) },
          { node_id: "menu", event: "reply", at: ago(2 * DAY - MIN) },
          { node_id: "end", event: "ended", at: ago(2 * DAY - 4 * MIN) },
        ],
      },
      {
        id: "r2", flow_id: id(6101), flow_name: "Wedding enquiries", status: "waiting", started_at: ago(3 * HOUR), ended_at: null, trigger: { kind: "ctwa_ad" },
        events: [{ node_id: "date", event: "send", at: ago(3 * HOUR) }],
      },
    ],
  };
}

export const SOURCE_BREAKDOWN = [
  { source: "import", contacts: 612 },
  { source: "ctwa_instagram", contacts: 341 },
  { source: "direct", contacts: 218 },
  { source: "website", contacts: 113 },
];

// ------------------------------------------------------------------ AI employee

const SOURCES_AI = [
  {
    id: "s1", type: "website", name: "kesar.example", status: "ready", item_count: 126, failed_pages: 0,
    last_synced_at: ago(DAY), last_error: null, refresh_days: 0, pages_seen: 48, products_found: 84,
    config: { url: "https://kesar.example" }, total_pages: 48, last_full_read_at: ago(DAY),
    reading: { unread: 0, plan_cap: 200, paid: true, tonight: 0, refresh_days: 0, auto_refresh: false, can_read_more: false, changes_available_at: null, coverage: { faq: true, shipping: true, returns: true, size_guide: false, contact: true }, products_by_category: { Necklaces: 31, Earrings: 28, Rings: 25 }, products_without_photo: 3 },
  },
  { id: "s2", type: "meta_catalog", name: "WhatsApp catalogue", status: "ready", item_count: 84, last_synced_at: ago(3 * HOUR), last_error: null },
  { id: "s3", type: "pdf", name: "Return policy.pdf", status: "ready", item_count: 14, last_synced_at: ago(3 * DAY), last_error: null },
  { id: "s4", type: "manual_qa", name: "Answers you taught", status: "ready", item_count: 23, last_synced_at: ago(5 * HOUR), last_error: null },
  { id: "s5", type: "spreadsheet", name: "Ring sizes.xlsx", status: "ready", item_count: 9, last_synced_at: ago(19 * DAY), last_error: null },
];

export function employeeOverview(mode = "replying") {
  return {
    agent: { id: "ag1", name: "Aiden", avatar: null, mode },
    settings: { ai_enabled: true, ai_monthly_cap_amount: 2000, currency: "INR", brain_choice: "recommended" },
    spend_this_month: 412.6,
    tiers: [
      { key: "fast", display_name: "Quick", plain_description: "Short, fast answers for simple questions.", speed_text: "Fastest", quality_text: "Good", relative_cost_text: "Lowest cost" },
      { key: "balanced", display_name: "Balanced", plain_description: "The best mix for most shops.", speed_text: "Fast", quality_text: "Very good", relative_cost_text: "Standard" },
      { key: "careful", display_name: "Careful", plain_description: "Takes longer and checks more.", speed_text: "Slower", quality_text: "Best", relative_cost_text: "Higher" },
    ],
    task_models: [{ task: "agent_reply", tier: "balanced", agent_id: null }],
    instructions: [
      { id: "iv2", persona_name: "Aiden", tone: "warm", instructions: "Help customers find jewellery they love.", escalation_rules: "Refunds and custom orders go to the team.", handover_message: "Let me get someone from the team for you.", languages: ["en", "hi"], working_hours_behaviour: "answer", version: 2, is_current: true, updated_at: ago(4 * DAY), origin: "owner" },
    ],
    sources: SOURCES_AI,
    tools: [
      { name: "catalog_search", description: "Searches your products", access: "read", feature: "catalogs", available: true, reason: null },
      { name: "order_status", description: "Looks up an order", access: "read", feature: "shopify", available: true, reason: null },
    ],
    week: { answered: 412, passed: 23, refused: 4 },
    tested_recently: true,
    can_configure: true,
  };
}

export function employeeApi(action) {
  if (action === "overview") return employeeOverview();
  if (action === "weekly_report")
    return {
      report: {
        since: ago(7 * DAY), answered: 412, passed: 23, cost: 98.4,
        learn: [
          { question: "Do you ship to Dubai?", times: 6, last_at: ago(2 * HOUR) },
          { question: "Can I pay in 3 instalments?", times: 4, last_at: ago(DAY) },
        ],
      },
    };
  if (action === "questions")
    return { questions: ["Is the rose-gold ring available in size 12?", "Do you ship to Dubai?", "What are your store timings on Sunday?", "Is COD available for Pune?"] };
  if (action === "behaviour_status") return { suggested: false, version_id: null };
  if (action === "skills") return { skills: [] };
  if (action === "work")
    return {
      runs: [
        { id: "w1", task: "agent_reply", tier: "balanced", status: "ok", escalation_signal: null, billed_amount: 0.21, cost_source: "platform", latency_ms: 2400, input_summary: "Is the rose-gold ring available in size 12?", output: "Yes! The rose-gold solitaire comes in size 12 — ₹18,400.", sources: [{ kind: "knowledge", label: "Rings" }], created_at: ago(9 * MIN) },
        { id: "w2", task: "agent_reply", tier: "balanced", status: "escalated", escalation_signal: "refund_request", billed_amount: 0.18, cost_source: "platform", latency_ms: 1900, input_summary: "I want to return the bracelet, it's too small", output: "Let me get someone from the team for you.", sources: [], created_at: ago(6 * HOUR) },
      ],
    };
  if (action === "handoff_alerts") return {};
  if (action === "brief") return null;
  return {};
}

export function knowledgeApi(action) {
  if (action === "list") return { sources: SOURCES_AI };
  if (action === "price_reviews")
    return {
      reviews: [
        { id: "p1", title: "Meenakari Kundan set", sku: "MK-221", price: 36500, product_url: "https://kesar.example/p/mk-221", price_review: { old_price: 36500, new_price: 3650, url: "https://kesar.example/p/mk-221", seen_at: ago(5 * HOUR) } },
      ],
    };
  if (action === "gaps")
    return {
      gaps: [
        { id: "g1", question: "Do you ship to Dubai?", status: "pending", source: "customer", conversation_id: null, created_at: ago(2 * HOUR) },
        { id: "g2", question: "Can I pay in 3 instalments?", status: "pending", source: "customer", conversation_id: null, created_at: ago(DAY) },
        { id: "g3", question: "Is the jhumka pair hallmarked?", status: "pending", source: "customer", conversation_id: null, created_at: ago(2 * DAY) },
      ],
      total: 3,
    };
  if (action === "corrections")
    return {
      corrections: [
        { id: "c1", question: "Store timings on Sunday?", answer: "We're open 11 am – 7 pm on Sundays.", use_count: 14, last_used_at: ago(3 * HOUR), created_at: ago(20 * DAY) },
      ],
    };
  return {};
}

export function playgroundRun(question) {
  return {
    run: {
      runId: "pg1",
      status: "ok",
      output: /dubai/i.test(question)
        ? "I'm not sure about shipping to Dubai — let me check with the team and get back to you."
        : "Yes! The rose-gold solitaire comes in size 12. It's ₹18,400 and ships in 3 days ✨ Shall I keep one for you?",
      sources: [{ kind: "knowledge", label: "Rings — kesar.example" }],
      toolCalls: [],
      media: null,
      escalationSignal: null,
      billedAmount: 0.21,
      billedCurrency: "INR",
      costKnown: true,
      latencyMs: 2300,
      tier: "balanced",
      brainName: "Balanced",
    },
  };
}
