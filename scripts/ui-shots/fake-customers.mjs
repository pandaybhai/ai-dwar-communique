/**
 * Batch 48: the Customers screens' fake data, on top of fake-backend.mjs
 * (createBackend({ customers: true })). Fictional: Kesar & Co.'s customers
 * are the chats' contacts, with tags, opt-in, shop orders and flow runs.
 * Nothing here reaches a live database, WhatsApp or Meta.
 */

const ORG = "00000000-0000-4000-8000-0000000000a1";
const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const TAGS = [
  { id: "t1", name: "Repeat buyer", color: "#10B981" },
  { id: "t2", name: "Bridal", color: "#F59E0B" },
  { id: "t3", name: "Earrings", color: "#6366F1" },
  { id: "t4", name: "Walk-in", color: "#0EA5A4" },
  { id: "t5", name: "Rings", color: "#8B5CF6" },
];
/** Tags per customer, by index. */
const TAGGED = [["t1", "t3"], ["t2"], ["t4"], ["t5"], ["t1", "t2"], [], ["t3"], ["t1"], [], ["t2", "t5"]];
const SOURCES = ["ctwa_instagram", "direct", "import", "website", "manual", "ctwa_facebook"];
/** Rupees spent per customer, by index (0 = no order). */
const SPENT = [41200, 0, 8400, 15600, 38000, 0, 12300, 64800, 0, 5200];

const row = (source_type, source_id, name, days, sent, orders, revenue, spent, complete = true) => ({
  source_type, source_id, name, created_at: ago(days * DAY), messages_sent: sent, delivered: Math.round(sent * 0.95),
  read_count: Math.round(sent * 0.7), clicked: Math.round(sent * 0.12), orders, revenue, spent, cost_complete: complete,
  median_hours: 5, currency: "INR",
});
const SOURCES_ROWS = [
  row("campaign", "c1", "Diwali preview: VIP list", 6, 1186, 21, 842000, 1019.96),
  row("campaign", "c2", "Bridal edit, week 2", 14, 2410, 12, 516000, 2072.6, false),
  row("flow", "f1", "Welcome message", 40, 640, 7, 188500, 0),
  row("flow", "f2", "Abandoned cart nudge", 22, 310, 4, 94200, 266.6),
];
const STEP_ROWS = [
  { ...row("flow", "f2", "Reminder after 1 hour", 0, 210, 3, 70200, 180.6), step_id: "s1", step_order: 1 },
  { ...row("flow", "f2", "Last call with 5% off", 0, 100, 1, 24000, 86), step_id: "s2", step_order: 2 },
];

export function makeCustomers(conversations) {
  const contacts = conversations.slice(0, 30).map((c, i) => ({
    id: c.contact.id,
    name: c.contact.name,
    phone: c.contact.phone,
    wa_id: c.contact.phone.replace(/\D/g, ""),
    opt_in_status: i === 4 ? "opted_out" : i % 4 === 3 ? "unknown" : "opted_in",
    opt_in_source: i % 4 === 3 || i === 4 ? null : i % 2 ? "import" : "manual",
    opted_in_at: i % 4 === 3 || i === 4 ? null : ago((20 + i) * DAY),
    attributes: i % 3 === 0 ? { city: ["Hyderabad", "Mumbai", "Pune"][i % 3 === 0 ? (i / 3) % 3 : 0] } : {},
    source: SOURCES[i % SOURCES.length],
    source_detail: i % 6 === 0 ? { headline: "Diwali bridal edit: 10% off making charges" } : null,
    created_at: ago((40 - i) * DAY),
  }));
  const links = contacts.flatMap((c, i) =>
    (TAGGED[i % TAGGED.length] ?? []).map((tagId) => ({
      contact_id: c.id,
      tag_id: tagId,
      organization_id: ORG,
      tags: TAGS.find((t) => t.id === tagId),
    })),
  );
  const orders = contacts.flatMap((c, i) => {
    const total = SPENT[i % SPENT.length];
    if (!total) return [];
    const first = Math.round(total * 0.7);
    return [
      { id: `ord-${i}-1`, contact_id: c.id, order_number: `#KC-${2040 - i}`, total: first, currency: "INR", placed_at: ago((3 + i) * DAY), cancelled_at: null },
      { id: `ord-${i}-2`, contact_id: c.id, order_number: `#KC-${1880 - i}`, total: total - first, currency: "INR", placed_at: ago((70 + i) * DAY), cancelled_at: null },
    ];
  });
  const runs = contacts.slice(0, 8).flatMap((c, i) => [
    { id: `run-${i}-1`, contact_id: c.id, status: i % 3 === 0 ? "waiting" : "done", started_at: ago((1 + i) * DAY), flows: { name: "Welcome message" } },
    ...(i % 2 ? [] : [{ id: `run-${i}-2`, contact_id: c.id, status: "done", started_at: ago((9 + i) * DAY), flows: { name: "Bridal enquiry" } }]),
  ]);

  const tables = {
    contacts: () => contacts,
    tags: () => TAGS,
    contact_tags: () => links,
    orders: () => orders,
    flow_runs: (q) => (q.filters.contact_id ? runs : []),
    // Each chat carries its contact id (the list's "Last chat").
    conversations: () => conversations.map((c) => ({ ...c, contact_id: c.contact.id })),
    segments: () => [
      { id: "seg1", name: "VIP customers", description: "Bought for ₹30,000 or more", filters: { match: "all", conditions: [{ field: "tag", operator: "has", value: "t1" }] }, created_by: "00000000-0000-4000-8000-0000000000b1", created_at: ago(30 * DAY) },
      { id: "seg2", name: "Wedding season leads", description: "Asked about bridal sets", filters: { match: "any", conditions: [{ field: "tag", operator: "has", value: "t2" }] }, created_by: "00000000-0000-4000-8000-0000000000b1", created_at: ago(10 * DAY) },
      { id: "seg3", name: "Not opted in yet", description: null, filters: { match: "all", conditions: [{ field: "opt_in_status", operator: "is", value: "unknown" }] }, created_by: "00000000-0000-4000-8000-0000000000b1", created_at: ago(4 * DAY) },
    ],
  };

  function rpc(fn) {
    if (fn === "contacts_source_breakdown") {
      const counts = {};
      for (const c of contacts) counts[c.source] = (counts[c.source] ?? 0) + 1;
      return Object.entries(counts).map(([source, n]) => ({ source, contacts: n * 41 }));
    }
    if (fn === "analytics_attribution_sources") return SOURCES_ROWS;
    if (fn === "analytics_attribution_steps") return STEP_ROWS;
    if (fn === "analytics_cost_settings") return { timezone: "Asia/Kolkata", gst_percent: 18 };
    return undefined;
  }

  function api(pathname, body) {
    if (pathname === "/api/contacts/evaluate-segment") {
      const n = { seg1: 412, seg2: 138 }[body?.segment_id] ?? 0;
      if (body?.mode === "ids") return { ids: contacts.slice(0, 6).map((c) => c.id) };
      const conds = body?.filters?.conditions ?? [];
      return { count: conds[0]?.value === "t1" ? 412 : conds[0]?.value === "t2" ? 138 : n || 96 };
    }
    if (pathname === "/api/contacts/opt-in") {
      if (body?.action === "count_unknown") return { count: 96 };
      return { changed: (body?.contact_ids ?? []).length || 96, skipped_opted_out: 0, already_opted_in: 0 };
    }
    return undefined;
  }

  return { tables, rpc, api, total: 2410 };
}
