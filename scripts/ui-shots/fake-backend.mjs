/**
 * A fake AiDwar backend for screenshots (Batch 39). Every request the app makes
 * to the backend host (PostgREST, auth, realtime) and to its own /api/* routes
 * is answered here from made-up data, inside the browser's request router —
 * nothing reaches a live database, WhatsApp or Meta.
 *
 * The data is fictional: a jewellery shop "Kesar & Co." with a team of three
 * and as many conversations as a scenario asks for.
 */

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
  "contacts.import", "contacts.view", "flows.manage", "flows.view", "inbox.reply", "inbox.view",
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

/** Batch 43: made-up plans for the screenshots (Billing and the public pricing). */
export const PLANS = [
  { key: "starter", name: "Starter", tagline: "For a shop finding its feet on WhatsApp", currency: "INR", price_monthly: 1999, price_annual: 19990, limits: { members: 2, numbers: 1, ai_answers: 500, contacts: 2000, messages_monthly: 5000 }, highlights: ["Shared inbox", "Campaigns and templates"] },
  { key: "growth", name: "Growth", tagline: "For shops sending every week", currency: "INR", price_monthly: 4999, price_annual: 49990, limits: { members: 5, numbers: 2, ai_answers: 1000, contacts: 10000, messages_monthly: 25000 }, highlights: ["Flows and automations", "Revenue tracking"] },
  { key: "pro", name: "Pro", tagline: "For teams running several numbers", currency: "INR", price_monthly: 9999, price_annual: 99990, limits: { members: 15, numbers: 5, ai_answers: 5000, contacts: 50000, messages_monthly: 100000 }, highlights: ["Public API and webhooks", "Priority support"] },
  { key: "enterprise", name: "Enterprise", tagline: "Custom volumes and white-label", currency: "INR", price_monthly: null, price_annual: null, limits: { members: -1, numbers: -1, ai_answers: -1 }, highlights: ["Dedicated manager"] },
];

function parse(url) {
  const u = new URL(url);
  const table = u.pathname.replace(/^\/rest\/v1\//, "");
  const filters = {};
  for (const [k, v] of u.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(k)) continue;
    if (k.includes(".")) continue; // filters on embedded tables
    const m = /^(eq|neq|in|is|ilike|gte|lte|gt|lt)\.(.*)$/.exec(v);
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
  const templates = options.templates === 0 ? [] : makeTemplates();
  const threads = new Map();
  const threadOf = (id) => {
    if (!threads.has(id)) threads.set(id, id === conversations[0]?.id ? makeThread(id) : makeThread(id).slice(0, 4));
    return threads.get(id);
  };
  // Batch 43: the plan state a Billing scenario starts in (active by default).
  const planStatus = options.planStatus ?? "active";
  const org = (id, name) => ({
    id, name, slug: name.toLowerCase().replace(/\W+/g, "-"), status: "active", timezone: "Asia/Kolkata",
    plan_status: id === ORG ? planStatus : "active",
    plan_version_id: id === ORG && planStatus === "trial" ? null : "pv1",
    trial_ends_at: id === ORG && planStatus === "trial" ? ago(-9 * DAY) : null,
  });
  const profiles = [
    { id: ME, full_name: "Riya Kapoor", email: "riya@kesar.example", is_super_admin: false },
    { id: NEHA, full_name: "Neha Joshi", email: "neha@kesar.example", is_super_admin: false },
    { id: ARJUN, full_name: "Arjun Das", email: "arjun@kesar.example", is_super_admin: false },
  ];

  const tables = {
    organization_members: (q) =>
      (q.params.get("select") ?? "").includes("organizations")
        ? [
            { role: "owner", user_id: ME, created_at: "2026-01-01", organizations: org(ORG, "Kesar & Co.") },
            { role: "admin", user_id: ME, created_at: "2026-02-01", organizations: org(ORG_2, "Kesar Outlet Store") },
          ]
        : [
            // Settings → Team (Batch 43).
            { id: "m1", role: "owner", user_id: ME, created_at: "2026-01-01" },
            { id: "m2", role: "admin", user_id: NEHA, created_at: "2026-03-14" },
            { id: "m3", role: "agent", user_id: ARJUN, created_at: "2026-06-02" },
          ],
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
    contact_tags: () => [
      { tag_id: "t1", tags: { id: "t1", name: "VIP" } },
      { tag_id: "t2", tags: { id: "t2", name: "Wedding season" } },
    ],
    tags: () => [],
    contacts: () =>
      conversations.slice(0, 6).map((c) => ({ ...c.contact, conversations: [{ id: c.id, last_message_at: c.last_message_at }] })),
    flow_triggers: () => [],
    flow_runs: () => [],
    wa_forms: () => [],
    // Batch 43: Settings.
    permissions: () => [
      { key: "inbox.reply", name: "Reply in the Inbox", description: "Send replies to customers.", category: "Inbox", min_role: "agent" },
      { key: "campaigns.send", name: "Send campaigns", description: "Launch campaigns to customers.", category: "Campaigns", min_role: "admin" },
      { key: "billing.pay", name: "Pay", description: "Buy credits and pay invoices.", category: "Billing", min_role: "owner" },
    ],
    role_permissions: () => [
      { role: "agent", permission_key: "inbox.reply" },
      { role: "admin", permission_key: "inbox.reply" },
      { role: "admin", permission_key: "campaigns.send" },
      { role: "owner", permission_key: "billing.pay" },
    ],
    member_permissions: () => [{ user_id: ARJUN, permission_key: "campaigns.send", granted: true }],
    activity_log: () => [
      { user_id: ME, created_at: ago(4 * MIN) },
      { user_id: NEHA, created_at: ago(2 * HOUR) },
      { user_id: ARJUN, created_at: ago(3 * DAY) },
    ],
    invitations: () => [
      { id: "inv1", email: "kabir@kesar.example", role: "agent", token: "fake-invite-token", expires_at: ago(-5 * DAY) },
    ],
    organization_send_settings: () => [
      {
        quiet_hours_enabled: true, quiet_hours_start: "21:00", quiet_hours_end: "09:00", quiet_hours_exempt_transactional: true,
        marketing_cap_per_day: 1, marketing_cap_per_week: 3, attribution_window_hours: 168, gst_percent: 18,
        winback_after_days: 45, reorder_after_days: 30,
      },
    ],
    lead_source_markers: () => [],
    opt_out_keywords: () => [],
    deletion_requests: () => [],
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
      q.table === "campaign_recipients" ? (method === "HEAD" ? 2580 : 4210) : rows.length;
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
    if (url.pathname === "/api/flows/triggers") return json({ runs: [] });
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
        plan: planStatus === "trial" ? { key: null, name: null } : { key: "growth", name: "Growth", tagline: "For shops sending every week", status: planStatus, price_monthly: 4999, limits: {}, highlights: [], trial_ends_at: null, billing_day: 3 },
        ai_answers: { included: 1000, used: 812 },
        usage: [
          { category: "messaging", label: "Campaign & template messages", amount: 6420.4, count: 7480 },
          { category: "automation", label: "Automations & flows", amount: 1310.6, count: 1520 },
          { category: "ai", label: "AI answers over your allowance", amount: 0, count: 0 },
          { category: "inbox", label: "Inbox replies", amount: 128.5, count: 151 },
        ],
        usage_total: 7859.5,
        rates: [
          { category: "marketing", rate: 0.8631, currency: "INR" },
          { category: "utility", rate: 0.115, currency: "INR" },
          { category: "authentication", rate: 0.115, currency: "INR" },
          { category: "service", rate: 0, currency: "INR" },
        ],
        packs: [
          { id: "pack1", name: "Starter pack", amount: 1000, bonus_amount: 0, currency: "INR" },
          { id: "pack2", name: "Growth pack", amount: 5000, bonus_amount: 250, currency: "INR" },
          { id: "pack3", name: "Scale pack", amount: 20000, bonus_amount: 1500, currency: "INR" },
        ],
        settings: { low_credit_threshold: 500, auto_topup_enabled: false, monthly_budget_cap: null, campaign_approval_threshold: null, overdraft_limit: 0, credits_expire_months: 12 },
        billing_account: { id: null, name: null, gstin: null, billing_email: null, state_code: null },
        period: { start: ago(20 * DAY), end: ago(-10 * DAY) },
      });
    }
    if (url.pathname === "/api/billing/plan") {
      return json({
        plan_status: planStatus,
        plan_version_id: planStatus === "trial" ? null : "pv1",
        trial_ends_at: planStatus === "trial" ? ago(-9 * DAY) : null,
        current_plan: planStatus === "trial" ? null : { key: "growth", name: "Growth" },
        suggested_plan: "growth",
        default_whatsapp: "+91 98200 00000",
        gstin: null,
        pending_payment: null,
        plans: PLANS.map((p) => ({ ...p, plan_version_id: `pv-${p.key}`, limits: { contacts: p.limits.contacts, messages_monthly: p.limits.messages_monthly, ai_answers_monthly: p.limits.ai_answers, team_members: p.limits.members } })),
      });
    }
    if (url.pathname === "/api/billing/invoices") {
      return json({
        invoices: [
          { id: "inv-3", invoice_number: "AD/26-27/0142", kind: "tax_invoice", purpose: "plan_fee", status: planStatus === "past_due" ? "issued" : "paid", issue_date: ago(2 * DAY), due_date: ago(-5 * DAY), period_start: ago(2 * DAY), period_end: ago(-28 * DAY), total: 5899, amount_paid: planStatus === "past_due" ? 0 : 5899, currency: "INR", pdf_path: "x", pay_url: "https://example.invalid/pay", roi_snapshot: { attributed_revenue: 184500, total_cost: 9159.5 } },
          { id: "inv-2", invoice_number: "AD/26-27/0127", kind: "tax_invoice", purpose: "credit_purchase", status: "paid", issue_date: ago(12 * DAY), due_date: null, period_start: null, period_end: null, total: 5900, amount_paid: 5900, currency: "INR", pdf_path: "x", pay_url: null, roi_snapshot: null },
          { id: "inv-1", invoice_number: "AD/26-27/0098", kind: "tax_invoice", purpose: "plan_fee", status: "paid", issue_date: ago(32 * DAY), due_date: null, period_start: ago(32 * DAY), period_end: ago(2 * DAY), total: 5899, amount_paid: 5899, currency: "INR", pdf_path: "x", pay_url: null, roi_snapshot: null },
        ],
        autopay: { enabled: planStatus === "active", status: "active", cycle: "monthly", next_charge_at: ago(-28 * DAY), cancel_at_period_end: false, short_url: null },
      });
    }
    if (url.pathname === "/api/billing/ledger") {
      const kind = url.searchParams.get("kind");
      if (kind === "payments") {
        return json({ entries: [
          { id: "pay-2", purpose: "Credits", status: "paid", paid_at: ago(12 * DAY), amount: 5900, currency: "INR" },
          { id: "pay-1", purpose: "Plan fee", status: "paid", paid_at: ago(32 * DAY), amount: 5899, currency: "INR" },
        ] });
      }
      let balance = options.lowCredits ? 180 : 2840.5;
      const moves = [-412.6, -96.2, -1019.96, -38.4, 5000, -870.3, -12.5, -640, -220.8, 5000, -84, -310.2];
      const entries = moves.map((amount, i) => {
        const row = { id: `led-${i}`, entry_type: amount > 0 ? "credit_purchase" : i % 3 === 0 ? "debit_campaign" : "debit_message", amount, balance_after: Math.round(balance * 100) / 100, currency: "INR", description: amount > 0 ? "Credits bought — Growth pack" : i % 3 === 0 ? "Campaign: Diwali preview — VIP list" : null, reference_type: null, created_at: ago(i * 1.7 * DAY + HOUR) };
        balance -= amount;
        return row;
      });
      return json({ entries, next_cursor: null });
    }
    if (url.pathname === "/api/developer/keys") {
      return json({ keys: [
        { id: "k1", name: "Shopify order updates", masked: "adw_live_••••••••3f9a", created_at: ago(40 * DAY), last_used_at: ago(12 * MIN), revoked_at: null },
        { id: "k2", name: "Zapier", masked: "adw_live_••••••••a71c", created_at: ago(90 * DAY), last_used_at: null, revoked_at: ago(20 * DAY) },
      ] });
    }
    if (url.pathname === "/api/developer/webhook") {
      return json({ url: null, status: null, last_delivery: null, recent: [], mode: "multi", limit: 3, webhooks: [] });
    }
    if (url.pathname === "/api/whatsapp/token-status") {
      return json({ connected: true, is_platform_org: false, numbers: [{ whatsapp_account_id: ACCOUNT, display_phone_number: "+91 98200 00000", never_expires: true }] });
    }
    if (url.pathname === "/api/whatsapp/profile") {
      return json({
        profile: { about: "Handcrafted jewellery since 1987 ✨", address: "14 Linking Road, Bandra West, Mumbai", description: "Gold, silver and kundan jewellery. Custom engraving and bridal sets.", email: "hello@kesar.example", websites: ["https://kesar.example"], vertical: "RETAIL", profile_picture_url: null },
        name: { verified_name: "Kesar & Co.", name_status: "APPROVED", new_display_name: null, new_name_status: null },
      });
    }
    if (url.pathname === "/api/integrations/shopify") {
      return json({ configured: true, integrations: [] });
    }
    if (url.pathname === "/api/integrations/flow-connections") {
      return json({ google_available: true, google: null, razorpay: null, razorpay_webhook_url: "https://aidwar.in/api/public/razorpay-flow-webhook" });
    }
    if (url.pathname === "/api/ai/employee") {
      return json({ phones: ["+91 98111 22334"], email: "riya@kesar.example", business_numbers: ["+91 98200 00000"], owner_phone: "+91 98111 22334", owner_is_business_number: false });
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
