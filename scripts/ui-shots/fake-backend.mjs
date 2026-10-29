/**
 * A fake AiDwar backend for screenshots (Batch 39). Every request the app makes
 * to the backend host (PostgREST, auth, realtime) and to its own /api/* routes
 * is answered here from made-up data, inside the browser's request router —
 * nothing reaches a live database, WhatsApp or Meta.
 *
 * The data is fictional: a jewellery shop "Kesar & Co." with a team of three
 * and as many conversations as a scenario asks for.
 */

import * as b42 from "./fake-b42.mjs";

export const BACKEND = "http://fake-backend.test";
export const STORAGE_KEY = "sb-fake-backend-auth-token";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ORG_2 = "00000000-0000-4000-8000-0000000000a2";
const ME = "00000000-0000-4000-8000-0000000000b1";
const NEHA = "00000000-0000-4000-8000-0000000000b2";
const ARJUN = "00000000-0000-4000-8000-0000000000b3";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c1";

const PERMISSIONS = [
  "ai.configure", "ai.use", "analytics.view", "automations.manage", "billing.pay", "billing.request",
  "billing.view", "campaigns.create", "campaigns.send", "campaigns.view", "cards.manage", "cards.view",
  "catalog.import", "catalog.manage", "catalog.view", "contacts.delete", "contacts.edit", "contacts.export",
  "contacts.import", "contacts.view", "flows.manage", "flows.view", "flows_v2.edit", "inbox.reply", "inbox.view",
  "inbox.assign", "inbox.close", "integrations.manage", "integrations.view", "public_api.manage",
  "revenue.view", "segments.manage", "settings.manage", "settings.view", "settings.whatsapp", "team.manage",
  "templates.manage",
];

const FLAGS = [
  "inbox", "contacts", "campaigns", "templates", "automations", "analytics", "compliance", "settings", "team",
  "ai_features", "shopify", "flows", "revenue_attribution", "billing", "catalogs", "cards", "wa_forms",
  "flows_v2", "public_api",
];

export function session() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: "fake-access-token",
    refresh_token: "fake-refresh-token",
    token_type: "bearer",
    expires_in: 3600 * 24 * 365,
    expires_at: now + 3600 * 24 * 365,
    user: {
      id: ME,
      aud: "authenticated",
      role: "authenticated",
      email: "riya@kesar.example",
      app_metadata: { provider: "email" },
      user_metadata: { full_name: "Riya Kapoor" },
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}

const FIRST = [
  "Asha", "Vikram", "Meera", "Rohan", "Kavya", "Arjun", "Ishita", "Sanjay", "Pooja", "Nikhil", "Ananya", "Rahul",
  "Divya", "Karan", "Sneha", "Aditya", "Priya", "Manish", "Tanvi", "Harsh", "Lakshmi", "Farhan", "Zoya", "Dev",
];
const LAST = ["Iyer", "Mehta", "Nair", "Reddy", "Shah", "Gupta", "Khan", "Das", "Joshi", "Menon", "Bose", "Patel"];
const PREVIEWS = [
  "Is the rose-gold ring available in size 12?",
  "Thank you! Received the parcel today 😊",
  "Can you share the price for the jhumkas?",
  "What are your store timings on Sunday?",
  "I want to return the bracelet, it's too small",
  "Do you do custom engraving?",
  "Here's my address for delivery",
  "Please call me back when you can",
  "Is COD available for Pune?",
  "Can I exchange it for a different design?",
];

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** n conversations, newest first; the first few are hand-written for the shots. */
export function makeConversations(n) {
  const rows = [];
  const special = [
    {
      name: "Asha Iyer", phone: "+919820011223", unread: 2, needs: true, assigned: null, at: 3 * MIN,
      preview: { body: "Can I get the Meenakari set by Friday? It's for my sister's wedding", type: "text", direction: "inbound" },
      reason: "asked_for_human", question: "Can I get the Meenakari set by Friday? It's for my sister's wedding",
    },
    {
      name: "Vikram Mehta", phone: "+919811045678", unread: 0, needs: false, assigned: ME, at: 18 * MIN,
      preview: { body: "Here are two rings under ₹20,000 that match what you asked for.", type: "text", direction: "outbound" },
    },
    {
      name: "Meera Nair", phone: "+919845098765", unread: 1, needs: false, assigned: NEHA, at: 52 * MIN,
      preview: { body: null, type: "image", direction: "inbound" },
    },
    {
      name: null, phone: "+919900112233", unread: 0, needs: false, assigned: null, at: 3 * HOUR,
      preview: { body: null, type: "template", direction: "outbound", template_name: "order_shipped" },
    },
    {
      name: "Rohan Reddy", phone: "+919876501234", unread: 0, needs: true, assigned: ARJUN, at: 6 * HOUR,
      preview: { body: "I want to return the bracelet, it's too small", type: "text", direction: "inbound" },
      reason: "refund_request",
    },
    {
      name: "Kavya Shah", phone: "+919812398765", unread: 0, needs: false, assigned: null, at: 26 * HOUR, status: "closed",
      preview: { body: "Thank you! Received the parcel today 😊", type: "text", direction: "inbound" },
    },
  ];
  for (let i = 0; i < n; i += 1) {
    const s = special[i];
    const id = `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const at = s ? s.at : 7 * HOUR + i * 37 * MIN;
    rows.push({
      id,
      status: s?.status ?? (i % 5 === 4 ? "closed" : "open"),
      assigned_to: s ? s.assigned : [null, ME, NEHA, ARJUN][i % 4],
      whatsapp_account_id: ACCOUNT,
      contact_id: `00000000-0000-4000-8000-${String(5000 + i).padStart(12, "0")}`,
      last_message_at: ago(at),
      last_customer_message_at: ago(i === 3 ? 3 * DAY : at),
      unread_count: s ? s.unread : i % 6 === 0 ? 1 : 0,
      needs_human: s ? s.needs : i % 17 === 0,
      needs_human_reason: s?.reason ?? (i % 17 === 0 ? "asked_for_human" : null),
      needs_human_question: s?.question ?? null,
      needs_human_at: s?.needs ? ago(at) : null,
      handover_state: s?.needs ? "sent" : null,
      created_at: ago(at + DAY),
      contact: {
        id: `00000000-0000-4000-8000-${String(5000 + i).padStart(12, "0")}`,
        name: s ? s.name : `${first} ${last}`,
        phone: s ? s.phone : `+9198${String(10000000 + i * 7919).slice(0, 8)}`,
        opt_in_status: i === 4 ? "opted_out" : "opted_in",
      },
      preview: [
        {
          ...(s?.preview ?? { body: PREVIEWS[i % PREVIEWS.length], type: "text", direction: i % 3 ? "inbound" : "outbound" }),
          metadata: null,
          created_at: ago(at),
        },
      ],
    });
  }
  return rows;
}

const SVG_RING = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f5e6d3"/><stop offset="1" stop-color="#e8c9a8"/></linearGradient>
<linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7d58b"/><stop offset=".5" stop-color="#c9973f"/><stop offset="1" stop-color="#f2cf7a"/></linearGradient></defs>
<rect width="640" height="480" fill="url(#g)"/><ellipse cx="320" cy="270" rx="150" ry="130" fill="none" stroke="url(#r)" stroke-width="30"/>
<circle cx="320" cy="132" r="34" fill="#e0457b"/><circle cx="310" cy="122" r="9" fill="#fff" opacity=".6"/></svg>`;

/** The open chat: every bubble kind the Inbox draws. */
export function makeThread(conversationId) {
  const t0 = 26 * HOUR;
  const m = (i, over) => ({
    id: `00000000-0000-4000-8000-${String(9000 + i).padStart(12, "0")}`,
    conversation_id: conversationId,
    direction: "inbound",
    type: "text",
    body: null,
    media_url: null,
    media_mime: null,
    template_name: null,
    status: "read",
    error_detail: null,
    sent_by: null,
    detected_language: "en",
    metadata: null,
    ...over,
  });
  return [
    m(1, { body: "Hi! I saw your Diwali collection on Instagram ✨", created_at: ago(t0) }),
    m(2, {
      direction: "outbound",
      body: "Hello Asha! Welcome to Kesar & Co. 🙏 What are you looking for today — earrings, rings or a full set?",
      created_at: ago(t0 - 40_000),
    }),
    m(3, { body: "A *Meenakari* necklace set, something under ₹40,000", created_at: ago(t0 - 4 * MIN) }),
    m(4, {
      direction: "outbound",
      type: "image",
      body: "Meenakari Kundan set — ₹36,500",
      media_url: `${BACKEND}/media/ring.svg`,
      media_mime: "image/svg+xml",
      metadata: { kind: "ai_product" },
      created_at: ago(t0 - 4 * MIN - 30_000),
    }),
    m(5, {
      direction: "outbound",
      type: "template",
      template_name: "order_shipped",
      metadata: { template_params: { 1: "Asha", 2: "#KC-2041" } },
      status: "delivered",
      created_at: ago(5 * HOUR),
    }),
    m(6, {
      type: "document",
      media_url: "storage:chat-media/fake/invoice.pdf",
      media_mime: "application/pdf",
      metadata: { document_filename: "Invoice-KC-2041.pdf" },
      created_at: ago(4 * HOUR),
    }),
    m(7, {
      type: "form_reply",
      metadata: {
        form_name: "Ring size",
        answers: [
          { label: "Size", value: "12" },
          { label: "Metal", value: "Rose gold" },
        ],
      },
      created_at: ago(3 * HOUR),
    }),
    m(8, {
      direction: "outbound",
      body: "Got it — size 12 in rose gold. I'll check with the workshop and confirm today.",
      sent_by: ME,
      created_at: ago(2 * HOUR),
    }),
    m(9, {
      direction: "outbound",
      body: "Our order cut-off for Friday delivery is 6 pm on Wednesday.",
      status: "failed",
      error_detail: "Message failed to send because more than 24 hours have passed since the customer last replied.",
      created_at: ago(90 * MIN),
    }),
    m(10, { body: "Can I get the Meenakari set by Friday? It's for my sister's wedding", created_at: ago(3 * MIN) }),
  ];
}

const AI_RUNS = (thread) => [
  {
    output: thread[1].body,
    input_summary: thread[0].body,
    sources: [{ sourceType: "manual_qa" }],
    created_at: thread[1].created_at,
  },
  {
    output: "Here's a set you may love:",
    input_summary: thread[2].body,
    sources: [],
    created_at: new Date(new Date(thread[3].created_at).getTime() - 2000).toISOString(),
  },
];

/** Campaigns in every state the list shows (Batch 41). */
export function makeCampaigns() {
  const c = (i, name, status, total, sent, delivered, read, failed, replied, at, extra = {}) => ({
    id: `00000000-0000-4000-8000-${String(7000 + i).padStart(12, "0")}`,
    organization_id: ORG,
    name,
    template_name: ["diwali_preview", "order_shipped", "back_in_stock", "wedding_edit", "festive_offer"][i % 5],
    template_language: "en",
    variable_mappings: null,
    segment_id: null,
    status,
    scheduled_at: status === "scheduled" ? new Date(Date.now() + DAY).toISOString() : null,
    started_at: sent ? ago(at) : null,
    completed_at: status === "completed" ? ago(at - HOUR) : null,
    total_recipients: total,
    sent_count: sent,
    delivered_count: delivered,
    read_count: read,
    failed_count: failed,
    replied_count: replied,
    created_by: ME,
    created_at: ago(at + HOUR),
    send_settings: {},
    estimated_cost: total * 0.86,
    held_amount: 0,
    charged_amount: sent * 0.86,
    returned_amount: 0,
    pause_reason: null,
    ...extra,
  });
  return [
    c(0, "Diwali preview — VIP list", "sending", 4210, 2630, 2488, 1712, 31, 96, 40 * MIN, {
      send_settings: { coupon_code: "DIWALI15", offer_expires_at: new Date(Date.now() + 2 * DAY).toISOString() },
    }),
    c(1, "Order shipped — October", "completed", 1180, 1180, 1162, 941, 18, 37, 2 * DAY),
    c(2, "Back in stock: Meenakari sets", "scheduled", 860, 0, 0, 0, 0, 0, 3 * HOUR),
    c(3, "Wedding edit lookbook", "awaiting_approval", 5200, 0, 0, 0, 0, 0, 5 * HOUR),
    c(4, "Festive offer — lapsed buyers", "paused", 2300, 940, 902, 511, 12, 22, DAY, { pause_reason: "insufficient_credits" }),
    c(5, "Dhanteras reminder", "completed", 3150, 3150, 3097, 2604, 53, 118, 6 * DAY),
    c(6, "Draft: Karva Chauth gifts", "draft", 0, 0, 0, 0, 0, 0, 7 * DAY),
    c(7, "Old price list", "cancelled", 640, 120, 118, 77, 0, 3, 12 * DAY),
    c(8, "Test to staff", "failed", 12, 0, 0, 0, 12, 0, 20 * DAY),
  ];
}

const RECIPIENT_STATUS = ["read", "read", "delivered", "sent", "read", "failed", "queued", "read", "delivered", "sending"];
export function makeRecipients(campaignId) {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `${campaignId.slice(0, 24)}${String(100 + i).padStart(12, "0")}`,
    contact_id: null,
    phone: `+9198${String(20000000 + i * 104729).slice(0, 8)}`,
    resolved_variables: { 1: FIRST[i % FIRST.length] },
    status: RECIPIENT_STATUS[i % RECIPIENT_STATUS.length],
    error: RECIPIENT_STATUS[i % RECIPIENT_STATUS.length] === "failed" ? "131026: Message undeliverable — the number isn't on WhatsApp." : null,
    updated_at: ago(i * 3 * MIN),
  }));
}

const tpl = (i, name, category, status, components, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(8000 + i).padStart(12, "0")}`,
  organization_id: ORG,
  waba_id: "waba1",
  meta_template_id: `meta-${i}`,
  name,
  language: i === 4 ? "hi" : "en",
  category,
  status,
  components,
  rejection_reason: null,
  created_at: ago((i + 1) * 2 * DAY),
  updated_at: ago((i + 1) * DAY),
  ...extra,
});

/** A template library with every kind of template the preview draws. */
export function makeTemplates() {
  return [
    tpl(0, "order_shipped", "UTILITY", "APPROVED", [
      { type: "BODY", text: "Hi {{1}}, your order {{2}} has shipped 📦 Track it here: kesar.example/t/2041", example: { body_text: [["Asha", "#KC-2041"]] } },
      { type: "FOOTER", text: "Kesar & Co. · Jaipur" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Track order", url: "https://kesar.example/t/{{1}}" }] },
    ]),
    tpl(1, "diwali_preview", "MARKETING", "APPROVED", [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["x"] } },
      { type: "BODY", text: "✨ *Diwali preview* for our favourite customers, {{1}}! Our new Meenakari collection is here — 15% off this week only.", example: { body_text: [["Asha"]] } },
      { type: "FOOTER", text: "Reply STOP to opt out" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Show me" }, { type: "QUICK_REPLY", text: "Not now" }] },
    ]),
    tpl(2, "back_in_stock", "MARKETING", "PENDING", [
      { type: "HEADER", format: "TEXT", text: "Back in stock 💍" },
      { type: "BODY", text: "Good news, {{1}} — the {{2}} you asked about is back. Shall we keep one for you?", example: { body_text: [["Asha", "rose-gold ring"]] } },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes, keep one" }] },
    ]),
    tpl(3, "festive_offer", "MARKETING", "REJECTED", [
      { type: "BODY", text: "FLAT 50% OFF EVERYTHING!!! Click now before it's gone!!!" },
    ], { rejection_reason: "Promotional content that may be considered spam (excessive capital letters and punctuation)." }),
    tpl(4, "invoice_hi", "UTILITY", "APPROVED", [
      { type: "HEADER", format: "DOCUMENT", example: { header_handle: ["x"] } },
      { type: "BODY", text: "नमस्ते {{1}}, आपका बिल संलग्न है। धन्यवाद!", example: { body_text: [["आशा"]] } },
    ]),
    tpl(5, "login_code", "AUTHENTICATION", "APPROVED", [
      { type: "BODY", text: "*{{1}}* is your verification code. For your security, do not share this code.", example: { body_text: [["482913"]] } },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ]),
  ];
}

function parse(url) {
  const u = new URL(url);
  const table = u.pathname.replace(/^\/rest\/v1\//, "");
  const filters = {};
  for (const [k, v] of u.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(k)) continue;
    if (k.includes(".")) continue; // filters on embedded tables
    const m = /^(eq|neq|in|is|ilike|like|gte|lte|gt|lt)\.(.*)$/.exec(v);
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
      if (f.op === "gt") return Number(v) > Number(f.value);
      if (f.op === "like") return String(v).startsWith(f.value.replace(/[%*].*$/, ""));
      return true;
    }),
  );
}

/**
 * Builds the request handlers for one scenario.
 * options.conversations — how many chats (0 = the empty Inbox).
 */
export function createBackend(options = {}) {
  const conversations = makeConversations(options.conversations ?? 40);
  const campaigns = options.campaigns === 0 ? [] : makeCampaigns();
  // Batch 42: contacts are the Inbox's own customers (0 = the empty list).
  const contacts = options.contacts === 0 ? [] : b42.makeContacts(conversations);
  const templates = options.templates === 0 ? [] : makeTemplates();
  const threads = new Map();
  const threadOf = (id) => {
    if (!threads.has(id)) threads.set(id, id === conversations[0]?.id ? makeThread(id) : makeThread(id).slice(0, 4));
    return threads.get(id);
  };
  const org = (id, name) => ({
    id, name, slug: name.toLowerCase().replace(/\W+/g, "-"), status: "active", timezone: "Asia/Kolkata",
    plan_status: "active", plan_version_id: "pv1", trial_ends_at: null,
  });
  const profiles = [
    { id: ME, full_name: "Riya Kapoor", email: "riya@kesar.example", is_super_admin: false },
    { id: NEHA, full_name: "Neha Joshi", email: "neha@kesar.example", is_super_admin: false },
    { id: ARJUN, full_name: "Arjun Das", email: "arjun@kesar.example", is_super_admin: false },
  ];

  const tables = {
    organization_members: () => [
      { role: "owner", user_id: ME, created_at: "2026-01-01", organizations: org(ORG, "Kesar & Co.") },
      { role: "admin", user_id: ME, created_at: "2026-02-01", organizations: org(ORG_2, "Kesar Outlet Store") },
    ].concat([{ role: "agent", user_id: NEHA }, { role: "agent", user_id: ARJUN }]),
    profiles: () => profiles,
    feature_flags: () => FLAGS.map((key) => ({ key, default_enabled: true })),
    organization_feature_overrides: () => [],
    whatsapp_accounts: () => [
      {
        id: ACCOUNT, organization_id: ORG, display_phone_number: "+91 98200 00000", verified_name: "Kesar & Co.",
        phone_number_id: "pn1", waba_id: "waba1", is_default: true, status: "active", health: "ok", quality_rating: "GREEN",
        label: null, created_at: "2026-01-01",
      },
    ],
    conversations: () => conversations,
    messages: (q) => {
      const cid = q.filters.conversation_id?.value;
      return cid ? threadOf(cid).slice().reverse() : [];
    },
    ai_runs: (q) => {
      const cid = q.filters.conversation_id?.value;
      return cid ? AI_RUNS(threadOf(cid)) : [];
    },
    message_templates: () => templates,
    campaigns: () => campaigns,
    campaign_recipients: (q) => (q.filters.campaign_id ? makeRecipients(q.filters.campaign_id.value) : []),
    campaign_offer_events: (q) =>
      Array.from({ length: q.filters.event?.value === "redeemed" ? 41 : 212 }, (_, i) => ({ id: `ev${i}` })),
    segments: () => [
      { id: "seg1", name: "VIP customers", description: "Spent ₹50,000+ this year", filters: {}, created_by: ME, created_at: ago(30 * DAY) },
      { id: "seg2", name: "Wedding season leads", description: "Asked about bridal sets", filters: {}, created_by: ME, created_at: ago(10 * DAY) },
    ],
    pending_owner_replies: () => [],
    automations: () => [],
    contact_tags: (q) =>
      q.filters.contact_id || q.params.get("select")?.includes("contact_id")
        ? b42.makeContactTags(contacts)
        : [
            { tag_id: "t1", tags: { id: "t1", name: "VIP" } },
            { tag_id: "t2", tags: { id: "t2", name: "Wedding season" } },
          ],
    tags: () => (options.contacts === 0 ? [] : b42.TAGS),
    contacts: (q) => {
      if (q.params.get("select") === "attributes") return contacts.slice(0, 12);
      if (q.filters.id) return contacts;
      return contacts.map((c) => ({ ...c, conversations: [{ id: conversations.find((v) => v.contact_id === c.id)?.id, last_message_at: conversations.find((v) => v.contact_id === c.id)?.last_message_at }] }));
    },
    flows: () => b42.makeFlows(),
    flow_steps: () => b42.makeFlowSteps(),
    scheduled_sends: () => b42.makeScheduledSends(),
    organization_send_settings: () => [
      { quiet_hours_enabled: true, quiet_hours_start: 21, quiet_hours_end: 9, quiet_hours_exempt_transactional: true, marketing_cap_per_day: 1, marketing_cap_per_week: 3 },
    ],
    flow_versions: () => b42.makeFlowVersions(),
    flow_triggers: () => b42.makeFlowTriggers(),
    flow_runs: () => b42.makeFlowRuns(),
    orders: (q) => (q.filters.contact_id ? b42.makeOrders(q.filters.contact_id.value) : []),
    ai_agents: () => [{ mode: "replying", is_default: true }],
    products: () => [],
    wa_forms: () => [],
  };

  async function rest(route, request) {
    const q = parse(request.url());
    const method = request.method();
    const make = tables[q.table];
    let rows = make ? make(q) : [];
    rows = applyFilters(rows, q.filters);
    if (q.table === "conversations" && q.filters.id) {
      // single-row reads (handoff_alert_result, aiden_flow_rules)
      rows = rows.map((r, i) => ({
        ...r,
        aiden_flow_rules:
          r.id === conversations[0]?.id
            ? { flow_id: "f1", flow_name: "Wedding orders", run_id: "r1", behaviour: "Warm and quick", rules: "Offer express delivery", set_at: ago(HOUR), expires_at: new Date(Date.now() + DAY).toISOString() }
            : null,
        handoff_alert_result: { at: r.needs_human_at, reminder: false, whatsapp: ["Riya Kapoor"], email: null, skipped: null } }));
    }
    const limit = Number(q.params.get("limit") ?? "0");
    if (limit && method === "GET") rows = rows.slice(0, limit);
    // Campaign recipients: 20 rows drawn, but counted like a real 4,210-recipient send.
    const total =
      q.table === "campaign_recipients"
        ? method === "HEAD" ? 2580 : 4210
        : q.table === "flow_runs" && q.filters.flow_id
          ? (b42.flowRunTotal(q.filters.flow_id.value) ?? rows.length)
          : q.table === "contacts" && rows.length >= 25 && !q.filters.opt_in_status
            ? 1284
            : rows.length;
    const headers = {
      "content-type": "application/json",
      "content-range": `0-${Math.max(0, rows.length - 1)}/${total}`,
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range",
    };
    if (method === "HEAD") return route.fulfill({ status: 200, headers, body: "" });
    if (method !== "GET") return route.fulfill({ status: 200, headers, body: method === "PATCH" ? "" : "[]" });
    const single = (request.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    if (single) {
      if (rows.length === 0) return route.fulfill({ status: 406, headers, body: JSON.stringify({ code: "PGRST116", message: "no rows" }) });
      return route.fulfill({ status: 200, headers, body: JSON.stringify(rows[0]) });
    }
    return route.fulfill({ status: 200, headers, body: JSON.stringify(rows) });
  }

  /** Batch 41: the analytics reads Home and the campaign results page make. */
  async function rpc(route, fn, request) {
    let args = {};
    try {
      args = JSON.parse(request.postData() || "{}");
    } catch {
      args = {};
    }
    const reply = (body) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    if (fn === "analytics_timeseries") {
      const days = 7;
      const day = (offset) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(
          new Date(Date.now() - offset * DAY),
        );
      const sent = [820, 1240, 960, 3180, 2410, 1780, 2630];
      const replies = [64, 92, 71, 188, 143, 120, 96];
      const opened = [31, 42, 38, 61, 57, 44, 48];
      return reply(
        Array.from({ length: days }, (_, i) => ({
          day: day(days - 1 - i),
          sent: sent[i],
          delivered: Math.round(sent[i] * 0.95),
          read: Math.round(sent[i] * 0.68),
          failed: Math.round(sent[i] * 0.012),
          replies: replies[i],
          new_contacts: 12 + i,
          opt_outs: i % 3,
          conversations_opened: opened[i],
          conversations_closed: opened[i] - 6,
        })),
      );
    }
    if (fn === "analytics_campaign_recipients") {
      const status = args.p_status ?? null;
      const rows = makeRecipients(String(args.p_campaign_id ?? "00000000-0000-4000-8000-000000007000"))
        .filter((r) => !status || r.status === status || (status === "replied" && r.status === "read"))
        .map((r, i) => ({
          recipient_id: r.id,
          phone: r.phone,
          contact_name: ["Asha Iyer", "Rohan Mehta", "Priya Nair", "Farhan Khan", "Kavya Rao"][i % 5],
          status: r.status,
          error: r.error,
          replied_at: i % 4 === 0 && r.status === "read" ? r.updated_at : null,
          updated_at: r.updated_at,
          total_count: 4210,
        }));
      return reply(rows.slice(Number(args.p_offset ?? 0), Number(args.p_offset ?? 0) + Number(args.p_limit ?? 50)));
    }
    if (fn === "contacts_source_breakdown") return reply(options.contacts === 0 ? [] : b42.SOURCE_BREAKDOWN);
    if (fn === "analytics_campaign_failures") {
      return reply([
        { reason: "131026: Message undeliverable — the number isn't on WhatsApp.", recipients: 19 },
        { reason: "131049: Meta chose not to deliver this marketing message.", recipients: 12 },
      ]);
    }
    return reply(null);
  }

  async function backend(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,HEAD,OPTIONS",
          "access-control-expose-headers": "content-range",
        },
      });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) return rpc(route, url.pathname.slice("/rest/v1/rpc/".length), request);
    if (url.pathname.startsWith("/rest/v1/")) return rest(route, request);
    if (url.pathname.startsWith("/auth/v1/user")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session().user), headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname.startsWith("/media/")) {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG_RING, headers: { "access-control-allow-origin": "*" } });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}", headers: { "access-control-allow-origin": "*" } });
  }

  async function api(route) {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/permissions") return json({ permissions: PERMISSIONS, overrides: {} });
    if (url.pathname.startsWith("/api/whatsapp/chat-media/")) {
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%fake\n" });
    }
    let action = "";
    let body = {};
    try {
      body = JSON.parse(request.postData() || "{}");
      action = String(body.action ?? "");
    } catch {
      action = "";
    }
    if (url.pathname === "/api/flows/triggers") {
      if (action === "node_stats") return json({ ok: true, stats: b42.nodeStats() });
      if (action === "contact_runs") return json({ ok: true, ...b42.contactRuns() });
      if (action === "list")
        return json({ ok: true, triggers: b42.makeFlowTriggers().filter((t) => t.flow_id === body.flow_id), fires: {}, conflicts: [] });
      return json({ runs: [] });
    }
    if (url.pathname === "/api/flows/v2") {
      if (action === "editor_context")
        return json({ numbers: [{ id: ACCOUNT, label: "+91 98200 00000", onboarding: false }], whatsapp_account_id: null, members: [{ id: ME, name: "Riya Kapoor" }, { id: NEHA, name: "Neha Joshi" }], whatsapp_shop_connected: true });
      if (action === "delete_check") return json({ active_runs: 12, refusal: null });
      return json({ ok: true });
    }
    if (url.pathname === "/api/flows/responses") return json(b42.makeResponses());
    if (url.pathname === "/api/ai/employee") return json(b42.employeeApi(action));
    if (url.pathname === "/api/ai/knowledge") return json(b42.knowledgeApi(action));
    if (url.pathname === "/api/internal/ai-run") {
      await new Promise((r) => setTimeout(r, 400));
      return json(b42.playgroundRun(String(body.question ?? "")));
    }
    if (url.pathname === "/api/contacts/opt-in" && action === "count_unknown") return json({ count: 214 });
    if (url.pathname === "/api/home/summary") {
      return json({
        today: { conversations: 48, ai_answers: 41, escalations: 3 },
        credits: { balance: 2840.5, currency: "INR" },
        plan: { name: "Growth", status: "active", trial_days_left: null },
        waiting: [
          { id: "w1", question: "Can I get the Meenakari set by Friday?", asked_at: ago(3 * MIN), conversation_id: conversations[0]?.id ?? null, contact_name: "Asha Iyer", source: "customer" },
          { id: "w2", question: "Do you ship to Dubai?", asked_at: ago(2 * HOUR), conversation_id: null, contact_name: "Farhan Khan", source: "customer" },
        ],
        learned: [
          { source_id: "s1", source_name: "kesar.example", source_type: "website", items: 126, latest_at: ago(DAY) },
          { source_id: "s2", source_name: "Return policy.pdf", source_type: "document", items: 14, latest_at: ago(3 * DAY) },
        ],
        generated_at: new Date().toISOString(),
      });
    }
    if (url.pathname === "/api/onboarding/journey") {
      // Batch 40: an owner who left the first-run journey at "connect" (Save & exit).
      return json(options.journey ? { state: { active: true, step: "connect" }, can_configure: true, owner_phone: null } : {});
    }
    if (url.pathname === "/api/billing/summary") {
      return json({
        organization_id: ORG,
        enabled: true,
        wallet: { balance: 2840.5, held: 0, available: options.lowCredits ? 180 : 2840.5, currency: "INR", lifetime_purchased: 12000, lifetime_consumed: 9159.5 },
        plan: { key: "growth", name: "Growth" },
        ai_answers: { included: 1000, used: 812 },
        usage: [],
        usage_total: 0,
        rates: [],
        packs: [],
        settings: { low_credit_threshold: 500, auto_topup_enabled: false, monthly_budget_cap: null, campaign_approval_threshold: null, overdraft_limit: 0, credits_expire_months: 12 },
        billing_account: { id: null, name: null, gstin: null, billing_email: null, state_code: null },
        period: { start: ago(20 * DAY), end: ago(-10 * DAY) },
      });
    }
    if (url.pathname === "/api/campaigns/audience") {
      return json({ matched: 1240, eligible: 1186, excluded: 54, sample: { name: "Asha Iyer", phone: "+919820011223", attributes: {} } });
    }
    if (url.pathname === "/api/campaigns/estimate") {
      return json({ enabled: true, recipients: 1186, category: "marketing", rate: 0.86, currency: "INR", estimate: 1019.96, available: 2840.5, shortfall: 0, can_send: true, needs_approval: false, approval_threshold: null, daily_limit: 10000, over_daily_limit: false, days_needed: 1 });
    }
    if (url.pathname === "/api/whatsapp/send-message") {
      await new Promise((r) => setTimeout(r, 600));
      return json({ message_id: "fake" });
    }
    return json({});
  }

  /** Phoenix channel replies so realtime subscribes quietly. */
  function realtime(ws) {
    ws.onMessage((raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.event === "phx_join") {
        const changes = (msg.payload?.config?.postgres_changes ?? []).map((c, i) => ({ ...c, id: i + 1 }));
        ws.send(JSON.stringify({ topic: msg.topic, event: "phx_reply", ref: msg.ref, join_ref: msg.join_ref, payload: { status: "ok", response: { postgres_changes: changes } } }));
      } else if (msg.ref) {
        ws.send(JSON.stringify({ topic: msg.topic, event: "phx_reply", ref: msg.ref, payload: { status: "ok", response: {} } }));
      }
    });
  }

  return { backend, api, realtime, conversations };
}
