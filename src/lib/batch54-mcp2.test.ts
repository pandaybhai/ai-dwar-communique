import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ORG, ORIGIN, OTHER_ORG, TAG_VIP, mcpWorld, token, type McpWorld } from "./test-support/mcp-world";
import { handleMcpRequest } from "./mcp-server.server";
import { ROUND2_TOOLS } from "./mcp-tools-r2.server";
import { CONFIRM_TTL_MS } from "./mcp-confirm.server";

/**
 * Batch 54 — AiDwar MCP tools, round 2, end to end on fakes (the in-memory
 * database, a fake Supabase Auth, a fake Meta; nothing reaches the live
 * database, WhatsApp or Meta). Every tool's happy path; another workspace
 * and a lower role refused on every tool; confirm codes (expiry, reuse,
 * tampering, content changed); a campaign already sending (or about to)
 * refused; the tag preview's count is what gets tagged; Aiden's answer is
 * passed word for word through the app's answer_gap path; the template
 * validator's own errors; a plain "no attribution data"; rate limits; audit.
 */

const h = vi.hoisted(() => ({
  world: null as null | McpWorld,
  meta: [] as Array<{ url: string; body: Record<string, unknown> }>,
  saved: [] as Array<{ question: string; answer: string }>,
  delivered: [] as Array<{ id: string; answer: string }>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));
// Aiden's knowledge and the WhatsApp send are faked at their edges; answerGap
// (the app's answer_gap path) itself runs for real.
vi.mock("@/lib/knowledge.server", () => ({
  saveCorrection: async (_db: unknown, _org: string, input: { question: string; answer: string }) => {
    h.saved.push({ question: input.question, answer: input.answer });
    return { ok: true };
  },
}));
vi.mock("@/lib/owner-replies.server", () => ({
  deliverToCustomer: async (_db: unknown, pending: { id: string }, answer: string) => {
    h.delivered.push({ id: pending.id, answer });
    return true;
  },
}));

const w = () => h.world!;
const rows = (t: string) => w().rows(t);
const HOUR = 3600 * 1000;

function seed() {
  rows("feature_flags").push({ key: "revenue_attribution", default_enabled: true });
  rows("products").push(
    { id: "p-ring", organization_id: ORG, title: "Ruby ring", description: "Gold ring with a ruby", category: "Rings", price: 12000, compare_at_price: 15000, currency: "INR", availability: "in_stock", inventory_quantity: 4, image_url: "https://cdn.example/ring.jpg", product_url: "https://shop.example/ring", is_visible: true, status: null, updated_at: "2026-10-28T00:00:00Z" },
    { id: "p-chain", organization_id: ORG, title: "Silver chain", description: "Plain chain", category: "Chains", price: 2500, currency: "INR", availability: "out_of_stock", inventory_quantity: 0, image_url: null, product_url: "https://shop.example/chain", is_visible: true, status: null, updated_at: "2026-10-20T00:00:00Z" },
    { id: "p-dup", organization_id: ORG, title: "Ruby ring (old)", currency: "INR", availability: "in_stock", is_visible: false, status: "archived", updated_at: "2026-10-29T00:00:00Z" },
    { id: "p-b", organization_id: OTHER_ORG, title: "B's ruby", currency: "INR", availability: "in_stock", is_visible: true, status: null, updated_at: "2026-10-29T00:00:00Z" },
  );
  rows("product_collections").push({ id: "col-new", organization_id: ORG, name: "New arrivals" }, { id: "col-b", organization_id: OTHER_ORG, name: "New arrivals" });
  rows("product_collection_items").push(
    { organization_id: ORG, collection_id: "col-new", product_id: "p-ring" },
    { organization_id: OTHER_ORG, collection_id: "col-b", product_id: "p-b" },
  );
  const inTwoDays = new Date(Date.now() + 48 * HOUR).toISOString();
  rows("campaigns").push(
    {
      id: "camp-sched",
      organization_id: ORG,
      name: "Weekend sale",
      status: "scheduled",
      whatsapp_account_id: "acc-a",
      template_name: "festive_offer",
      template_language: "en",
      variable_mappings: { "1": { source: "name" }, "2": { source: "static", value: "20% off" } },
      send_settings: {},
      segment_id: "seg-vip",
      scheduled_at: inTwoDays,
      total_recipients: 1,
      estimated_cost: 0.15,
      created_by: "u-marketer",
      created_at: "2026-10-29T00:00:00Z",
    },
    { id: "camp-sending", organization_id: ORG, name: "Live now", status: "sending", whatsapp_account_id: "acc-a", template_name: "festive_offer", segment_id: "seg-vip", scheduled_at: new Date(Date.now() - HOUR).toISOString(), created_by: "u-marketer", created_at: "2026-10-29T00:00:00Z" },
    { id: "camp-soon", organization_id: ORG, name: "Soon", status: "scheduled", whatsapp_account_id: "acc-a", template_name: "festive_offer", segment_id: "seg-vip", scheduled_at: new Date(Date.now() + 2 * 60_000).toISOString(), created_by: "u-marketer", created_at: "2026-10-29T00:00:00Z" },
    { id: "camp-api", organization_id: ORG, name: "From the API", status: "scheduled", whatsapp_account_id: "acc-a", template_name: "festive_offer", segment_id: null, scheduled_at: inTwoDays, created_by: null, created_at: "2026-10-29T00:00:00Z" },
    { id: "camp-b-sched", organization_id: OTHER_ORG, name: "B scheduled", status: "scheduled", whatsapp_account_id: "acc-b", template_name: "b_invoice", scheduled_at: inTwoDays, created_by: "u-b", created_at: "2026-10-29T00:00:00Z" },
  );
  rows("revenue_attributions").push(
    { id: "ra-1", organization_id: ORG, source_type: "campaign", source_id: "camp-done", order_total: 1200, currency: "INR" },
    { id: "ra-2", organization_id: ORG, source_type: "campaign", source_id: "camp-done", order_total: "800.50", currency: "INR" },
    { id: "ra-3", organization_id: ORG, source_type: "flow", source_id: "flow-x", order_total: 999, currency: "INR" },
    { id: "ra-b", organization_id: OTHER_ORG, source_type: "campaign", source_id: "camp-b", order_total: 5, currency: "INR" },
  );
  // Aiden's questions. conv-1's customer wrote an hour ago (window open).
  rows("conversations").find((c) => c["id"] === "conv-1")!["last_customer_message_at"] = new Date(Date.now() - HOUR).toISOString();
  rows("pending_owner_replies").push(
    { id: "q-1", organization_id: ORG, owner_phone: "+919811111111", conversation_id: "conv-1", contact_id: "c1", question: "Do you ship to Dubai?", source: "customer", status: "pending", selected_at: null, created_at: "2026-10-30T08:00:00Z", reminded_at: null },
    { id: "q-2", organization_id: ORG, owner_phone: "+919811111111", conversation_id: null, contact_id: null, question: "What are your Sunday hours?", source: "customer", status: "expired", selected_at: null, created_at: "2026-10-29T08:00:00Z", reminded_at: null },
    { id: "q-done", organization_id: ORG, owner_phone: "+919811111111", conversation_id: null, contact_id: null, question: "Old one", source: "customer", status: "answered", created_at: "2026-10-01T08:00:00Z" },
    { id: "q-b", organization_id: OTHER_ORG, owner_phone: "+919822222222", conversation_id: "conv-b", contact_id: "cb1", question: "B's question", source: "customer", status: "pending", created_at: "2026-10-30T08:00:00Z" },
  );
  // Replies to the Navratri campaign.
  rows("conversations").push({ id: "conv-3", organization_id: ORG, contact_id: "c3", status: "open", needs_human: false });
  rows("campaign_recipients").push(
    { campaign_id: "camp-done", organization_id: ORG, contact_id: "c1", status: "read" },
    { campaign_id: "camp-done", organization_id: ORG, contact_id: "c2", status: "read" },
  );
  const recent = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  rows("messages").push(
    { organization_id: ORG, conversation_id: "conv-1", direction: "inbound", body: "YES!", type: "button", created_at: recent(30) },
    { organization_id: ORG, conversation_id: "conv-2", direction: "inbound", body: "yes", type: "text", created_at: recent(20) },
    { organization_id: ORG, conversation_id: "conv-3", direction: "inbound", body: "Yesterday was great", type: "text", created_at: recent(10) },
    { organization_id: ORG, conversation_id: "conv-2", direction: "outbound", body: "YES", type: "text", created_at: recent(5) },
  );
}

beforeEach(() => {
  process.env["AIDWAR_SUPABASE_URL"] = "https://hcsacmqzspnfqoftoifu.supabase.co";
  h.world = mcpWorld();
  h.meta = [];
  h.saved = [];
  h.delivered = [];
  seed();
  // Meta, faked: template creation answers PENDING; anything else is refused.
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://graph.facebook.com/") && u.includes("/message_templates") && init?.method === "POST") {
      h.meta.push({ url: u, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ id: `meta-tpl-${h.meta.length}`, status: "PENDING", category: "MARKETING" });
    }
    return new Response("no network in tests", { status: 599 });
  });
});
afterEach(() => vi.unstubAllGlobals());

type ToolAnswer = { isError: boolean; text: string; data: Record<string, unknown> };

async function tool(user: string, name: string, args: Record<string, unknown> = {}, now?: () => number): Promise<ToolAnswer> {
  const deps = now ? { ...w().deps, now } : w().deps;
  const res = await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ sub: user })}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    deps,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } };
  const text = body.result.content[0]!.text;
  const json = text.indexOf("\n\n{");
  return {
    isError: body.result.isError === true,
    text,
    data: body.result.structuredContent ?? (json >= 0 ? (JSON.parse(text.slice(json + 2)) as Record<string, unknown>) : {}),
  };
}

const winterSale = (over: Record<string, unknown> = {}) => ({
  name: "Winter Sale 2026",
  language: "en",
  category: "marketing",
  header_text: "Winter sale",
  body: "Hi {{1}}, our winter sale is on: {{2}} on everything this week.",
  body_examples: ["Asha", "25% off"],
  footer: "Reply STOP to opt out",
  buttons: [{ type: "url", text: "Shop now", url: "https://shop.example/winter" }],
  ...over,
});

describe("the tool list", () => {
  it("adds the ten round-2 tools with honest annotations; still no message, mode, billing, delete or team tool", async () => {
    expect(ROUND2_TOOLS.map((t) => t.name)).toEqual([
      "list_products",
      "get_campaign_sales",
      "list_aiden_questions",
      "create_template_draft",
      "preview_campaign_change",
      "submit_template",
      "update_scheduled_campaign",
      "cancel_scheduled_campaign",
      "tag_contacts",
      "answer_aiden_question",
    ]);
    const by = Object.fromEntries(ROUND2_TOOLS.map((t) => [t.name, t]));
    for (const n of ["list_products", "get_campaign_sales", "list_aiden_questions", "create_template_draft", "preview_campaign_change"]) {
      expect(by[n]!.readOnly, n).toBe(true);
      expect(by[n]!.destructive, n).toBe(false);
    }
    for (const n of ["submit_template", "update_scheduled_campaign", "cancel_scheduled_campaign", "tag_contacts", "answer_aiden_question"]) {
      expect(by[n]!.readOnly, n).toBe(false);
      expect(by[n]!.destructive, n).toBe(true);
      expect(Object.keys(by[n]!.input), n).toContain("confirm_code");
    }
    for (const t of ROUND2_TOOLS) expect(Object.keys(t.input)).toContain("workspace_id");
    const names = ROUND2_TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/send_message|reply|mode|billing|wallet|plan|delete|remove|team|key|setting/);
    // The answer tool says the words must be the user's own.
    expect(by["answer_aiden_question"]!.description).toContain("must come from the user");
    expect(by["answer_aiden_question"]!.description).toContain("never write, guess, complete or rephrase");
  });
});

describe("list_products", () => {
  it("lists the catalogue newest first (no archived duplicates), with price, stock, picture, link and collections", async () => {
    const a = await tool("u-marketer", "list_products");
    expect(a.isError).toBe(false);
    const products = a.data["products"] as Array<Record<string, unknown>>;
    expect(products.map((p) => p["product_id"])).toEqual(["p-ring", "p-chain"]);
    expect(products[0]).toMatchObject({
      name: "Ruby ring",
      price: 12000,
      compare_at_price: 15000,
      currency: "INR",
      availability: "in_stock",
      stock: 4,
      image_url: "https://cdn.example/ring.jpg",
      product_url: "https://shop.example/ring",
      collections: ["New arrivals"],
    });
    expect(String(products[0]!["price_text"])).toContain("12,000");
    expect(a.data["link"]).toBe("https://aidwar.in/app/catalog");
  });

  it("searches words, filters by collection (name or id) and availability; at most 50 a page", async () => {
    expect(((await tool("u-marketer", "list_products", { search: "ruby" })).data["products"] as unknown[]).length).toBe(1);
    expect(((await tool("u-marketer", "list_products", { collection: "new arrivals" })).data["products"] as Array<{ product_id: string }>).map((p) => p.product_id)).toEqual(["p-ring"]);
    expect(((await tool("u-marketer", "list_products", { collection: "col-new" })).data["products"] as unknown[]).length).toBe(1);
    expect(((await tool("u-marketer", "list_products", { availability: "out_of_stock" })).data["products"] as Array<{ product_id: string }>).map((p) => p.product_id)).toEqual(["p-chain"]);
    expect((await tool("u-marketer", "list_products", { collection: "Sale" })).text).toContain('No collection called "Sale"');
    expect((await tool("u-marketer", "list_products", { limit: 51 })).isError).toBe(true);
  });
});

describe("get_campaign_sales", () => {
  it("is the campaign screen's figure: the campaign's attributed orders and revenue", async () => {
    const a = await tool("u-marketer", "get_campaign_sales", { campaign_id: "camp-done" });
    expect(a.isError).toBe(false);
    expect(a.data["sales"]).toMatchObject({ orders: 2, revenue: 2000.5, currency: "INR" });
    expect(a.text).toContain("2 order(s)");
    // The same number the app shows (loadCampaignSales reads through the same function).
    const src = readFileSync("src/components/campaigns-v2/data.ts", "utf8");
    expect(src).toContain("readCampaignSales(aidwar, organizationId, campaignId)");
  });

  it("says plainly when the workspace has no attribution data, and never gives a number", async () => {
    rows("revenue_attributions").splice(0, rows("revenue_attributions").length, { id: "ra-b", organization_id: OTHER_ORG, source_type: "campaign", source_id: "camp-b", order_total: 5 });
    const a = await tool("u-marketer", "get_campaign_sales", { campaign_id: "camp-done" });
    expect(a.isError).toBe(false);
    expect(a.data).toMatchObject({ sales: null, reason: "no_attribution_data" });
    expect(a.text).toContain("no sales attribution data yet");
    expect(a.text).toContain("Don't estimate one");
    expect(a.text).not.toMatch(/₹|\d+ order/);
  });

  it("no orders on this campaign, attribution switched off, or orders in two currencies: no invented total", async () => {
    expect((await tool("u-marketer", "get_campaign_sales", { campaign_id: "camp-sched" })).data).toMatchObject({ reason: "no_orders_linked", sales: { orders: 0, revenue: 0 } });
    rows("revenue_attributions").push({ id: "ra-usd", organization_id: ORG, source_type: "campaign", source_id: "camp-done", order_total: 10, currency: "USD" });
    const mixed = await tool("u-marketer", "get_campaign_sales", { campaign_id: "camp-done" });
    expect(mixed.data).toMatchObject({ sales: null, orders: 3, reason: "mixed_currencies" });
    rows("organization_feature_overrides").push({ organization_id: ORG, flag_key: "revenue_attribution", enabled: false });
    expect((await tool("u-marketer", "get_campaign_sales", { campaign_id: "camp-done" })).data).toMatchObject({ sales: null, reason: "attribution_off" });
  });
});

describe("templates: draft, then submit", () => {
  it("drafts with the builder's validator (nothing saved, nothing to Meta), then submits through the Templates page's create", async () => {
    const d = await tool("u-marketer", "create_template_draft", winterSale());
    expect(d.isError).toBe(false);
    expect(d.data).toMatchObject({ name: "winter_sale_2026", language: "en", category: "marketing", ready: true, problems: [] });
    expect(String(d.data["preview"])).toContain("Hi Asha, our winter sale is on: 25% off on everything this week.");
    expect(h.meta).toHaveLength(0);
    expect(rows("message_templates").some((t) => t["name"] === "winter_sale_2026")).toBe(false);

    const s = await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: d.data["confirm_code"] });
    expect(s.isError).toBe(false);
    expect(s.data).toMatchObject({ name: "winter_sale_2026", status: "pending", link: "https://aidwar.in/app/templates" });
    expect(h.meta).toHaveLength(1);
    expect(h.meta[0]!.url).toContain("/waba-a/message_templates");
    expect(h.meta[0]!.body).toMatchObject({ name: "winter_sale_2026", language: "en", category: "MARKETING" });
    const body = (h.meta[0]!.body["components"] as Array<Record<string, unknown>>).find((c) => c["type"] === "BODY")!;
    expect(body).toMatchObject({ text: winterSale().body, example: { body_text: [["Asha", "25% off"]] } });
    expect(rows("message_templates").find((t) => t["name"] === "winter_sale_2026")).toMatchObject({ organization_id: ORG, waba_id: "waba-a", status: "PENDING", meta_template_id: "meta-tpl-1" });
    // createTemplateFromDraft's own activity entry, plus the MCP audit row.
    expect(rows("activity_log").some((r) => r["action"] === "template_created")).toBe(true);
    // Works once: the template now exists.
    const again = await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: d.data["confirm_code"] });
    expect(again.text).toContain("already exists");
    expect(h.meta).toHaveLength(1);
  });

  it("surfaces the template validator's own errors and gives no code", async () => {
    const d = await tool("u-marketer", "create_template_draft", winterSale({ body: "{{1}} our sale is on {{3}}", body_examples: ["Asha"], footer: "x".repeat(61) }));
    expect(d.data["ready"]).toBe(false);
    expect(d.data["confirm_code"]).toBeNull();
    const problems = d.data["problems"] as string[];
    expect(problems).toContain("Number your variables in order, starting at {{1}}.");
    expect(problems).toContain("Meta won't accept a message that starts or ends with a variable — add a word before or after it.");
    expect(problems).toContain("Meta requires an example value for every variable in the body.");
    expect(problems).toContain("A footer can be 60 characters at most.");
    const button = await tool("u-marketer", "create_template_draft", winterSale({ buttons: [{ type: "url", text: "Shop", url: "shop.example" }] }));
    expect(button.data["problems"]).toContain("Button 1's web address must start with https://.");
    const taken = await tool("u-marketer", "create_template_draft", winterSale({ name: "festive_offer" }));
    expect((taken.data["problems"] as string[]).join(" ")).toContain("already exists");
  });

  it("a code for other words, another user, an expired code or a tampered one is refused; nothing reaches Meta", async () => {
    const d = await tool("u-marketer", "create_template_draft", winterSale());
    const code = String(d.data["confirm_code"]);
    expect((await tool("u-marketer", "submit_template", { ...winterSale({ body_examples: ["Asha", "50% off"] }), confirm_code: code })).text).toContain("Something changed");
    expect((await tool("u-marketer", "submit_template", { ...winterSale({ name: "winter_sale_2027" }), confirm_code: code })).text).toContain("doesn't belong");
    expect((await tool("u-owner", "submit_template", { ...winterSale(), workspace_id: ORG, confirm_code: code })).text).toContain("doesn't belong");
    expect((await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: code.slice(0, -1) + (code.endsWith("A") ? "B" : "A") })).text).toContain("doesn't belong");
    const later = () => Date.now() + CONFIRM_TTL_MS + 60_000;
    expect((await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: code }, later)).text).toContain("expired");
    expect(h.meta).toHaveLength(0);
  });

  it("at most 10 submissions a day per workspace", async () => {
    const d = await tool("u-marketer", "create_template_draft", winterSale());
    w().rate.windows.set(`mcp:template:${ORG}`, 10);
    const a = await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("At most 10 templates a day");
    expect(h.meta).toHaveLength(0);
  });

  it("Meta's refusal comes back as it is; the template isn't filed", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: { message: "Invalid parameter", error_user_msg: "This name is reserved." } }, { status: 400 }));
    const d = await tool("u-marketer", "create_template_draft", winterSale());
    const a = await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("Not submitted: This name is reserved.");
    expect(rows("message_templates").some((t) => t["name"] === "winter_sale_2026")).toBe(false);
  });
});

describe("scheduled campaigns: preview, then change or cancel", () => {
  const sevenPm = () => {
    const d = new Date(Date.now() + 72 * HOUR);
    d.setUTCHours(13, 30, 0, 0); // 19:00 IST
    return d.toISOString();
  };

  it("previews a new time (recipients, cost, code), then relaunches through launchCampaign and cancels the old one", async () => {
    const at = sevenPm();
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", schedule_at: at });
    expect(p.isError).toBe(false);
    expect(p.data).toMatchObject({ campaign_id: "camp-sched", new_scheduled_at: at, recipients: 1, not_opted_in_left_out: 1, estimated_cost: { amount: 0.15 } });
    expect((p.data["changes"] as string[])[0]).toContain("send time");
    expect(rows("campaigns").find((c) => c["id"] === "camp-sched")!["status"]).toBe("scheduled");

    const u = await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", schedule_at: at, confirm_code: p.data["confirm_code"] });
    expect(u.isError).toBe(false);
    const fresh = rows("campaigns").find((c) => c["id"] === u.data["campaign_id"])!;
    expect(fresh).toMatchObject({ status: "scheduled", name: "Weekend sale", template_name: "festive_offer", segment_id: "seg-vip", scheduled_at: at, created_by: "u-marketer" });
    expect(rows("campaigns").find((c) => c["id"] === "camp-sched")!["status"]).toBe("cancelled");
    expect(rows("campaign_recipients").filter((r) => r["campaign_id"] === fresh["id"]).map((r) => r["contact_id"])).toEqual(["c1"]);
    // The app's own entries say it came from MCP.
    expect(rows("activity_log").find((r) => r["action"] === "campaign_launched")!["details"]).toMatchObject({ source: "mcp", tool: "update_scheduled_campaign", replaces_campaign_id: "camp-sched" });
    expect(rows("activity_log").find((r) => r["action"] === "campaign_cancelled")!["details"]).toMatchObject({ campaign_id: "camp-sched", source: "mcp", replaced_by: fresh["id"] });
    // Works once.
    const again = await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", schedule_at: at, confirm_code: p.data["confirm_code"] });
    expect(again.text).toContain("cancelled, not scheduled");
  });

  it("changes the audience and a variable's value; the counts follow", async () => {
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", all_opted_in: true, variables: { "2": "30% off" } });
    expect(p.data).toMatchObject({ recipients: 2 });
    const u = await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", all_opted_in: true, variables: { "2": "30% off" }, confirm_code: p.data["confirm_code"] });
    expect(u.isError).toBe(false);
    const recipients = rows("campaign_recipients").filter((r) => r["campaign_id"] === u.data["campaign_id"]);
    expect(recipients.map((r) => r["contact_id"]).sort()).toEqual(["c1", "c2"]);
    expect(recipients.find((r) => r["contact_id"] === "c1")!["resolved_variables"]).toEqual({ "1": "Asha", "2": "30% off" });
    expect(recipients.map((r) => r["contact_id"])).not.toContain("c-out");
  });

  it("cancels after a preview with cancel: true (cancelCampaign); the code works once", async () => {
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", cancel: true });
    expect(p.data["change"]).toBe("cancel");
    const c = await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: "camp-sched", confirm_code: p.data["confirm_code"] });
    expect(c.isError).toBe(false);
    expect(rows("campaigns").find((x) => x["id"] === "camp-sched")).toMatchObject({ status: "cancelled" });
    expect((await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: "camp-sched", confirm_code: p.data["confirm_code"] })).text).toContain("a confirm_code works once");
    // A cancel code doesn't change a campaign and an update code doesn't cancel one.
    rows("campaigns").find((x) => x["id"] === "camp-sched")!["status"] = "scheduled";
    const up = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", all_opted_in: true });
    expect((await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: "camp-sched", confirm_code: up.data["confirm_code"] })).text).toContain("doesn't belong");
  });

  it("never touches a campaign that is sending, sent, due within 5 minutes or made through the API", async () => {
    for (const [id, words] of [
      ["camp-sending", "already sending"],
      ["camp-done", "already sent"],
      ["camp-soon", "within 5 minutes"],
      ["camp-api", "through the AiDwar API"],
    ] as const) {
      for (const args of [{ cancel: true }, { all_opted_in: true }]) {
        const a = await tool("u-marketer", "preview_campaign_change", { campaign_id: id, ...args });
        expect(a.isError, id).toBe(true);
        expect(a.text, id).toContain(words);
      }
      expect((await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: id, confirm_code: "x" })).text).toContain(words);
    }
    expect(rows("campaigns").find((c) => c["id"] === "camp-sending")!["status"]).toBe("sending");
  });

  it("a campaign that started sending after its preview is refused at confirm time", async () => {
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", cancel: true });
    rows("campaigns").find((c) => c["id"] === "camp-sched")!["status"] = "sending";
    const a = await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: "camp-sched", confirm_code: p.data["confirm_code"] });
    expect(a.text).toContain("already sending");
    expect(rows("campaigns").find((c) => c["id"] === "camp-sched")!["status"]).toBe("sending");
  });

  it("a change to the campaign or its audience after the preview, an expired or another user's code: refused, nothing launched", async () => {
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", all_opted_in: true });
    const code = p.data["confirm_code"];
    expect((await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", segment_id: "seg-vip", variables: { "2": "x" }, confirm_code: code })).text).toContain("Something changed");
    const later = () => Date.now() + CONFIRM_TTL_MS + 60_000;
    expect((await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", all_opted_in: true, confirm_code: code }, later)).text).toContain("expired");
    expect((await tool("u-owner", "update_scheduled_campaign", { workspace_id: ORG, campaign_id: "camp-sched", all_opted_in: true, confirm_code: code })).text).toContain("doesn't belong");
    rows("campaigns").find((c) => c["id"] === "camp-sched")!["variable_mappings"] = { "1": { source: "name" }, "2": { source: "static", value: "50% off" } };
    expect((await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", all_opted_in: true, confirm_code: code })).text).toContain("Something changed");
    const p2 = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", schedule_at: sevenPm() });
    rows("segments").find((s) => s["id"] === "seg-vip")!["filters"] = { match: "all", conditions: [] };
    expect((await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", schedule_at: sevenPm(), confirm_code: p2.data["confirm_code"] })).text).toContain("Something changed");
    expect(rows("campaigns").filter((c) => c["name"] === "Weekend sale")).toHaveLength(1);
  });

  it("a launch refusal (wallet too low) changes nothing: the scheduled campaign stays", async () => {
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", all_opted_in: true });
    rows("wallet_balances")[0]!["balance"] = 0;
    const a = await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", all_opted_in: true, confirm_code: p.data["confirm_code"] });
    expect(a.text).toContain("Not changed");
    expect(a.text).toContain("credits");
    expect(rows("campaigns").find((c) => c["id"] === "camp-sched")!["status"]).toBe("scheduled");
    expect(rows("campaigns").filter((c) => c["name"] === "Weekend sale")).toHaveLength(1);
  });

  it("refuses nothing-to-change, a new time too soon and a variable the template doesn't have", async () => {
    expect((await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched" })).text).toContain("Nothing to change");
    expect((await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", segment_id: "seg-vip" })).text).toContain("nothing would change");
    expect((await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", schedule_at: new Date(Date.now() + 60_000).toISOString() })).text).toContain("at least 5 minutes");
    expect((await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", variables: { "3": "x" } })).text).toContain("no {{3}}");
  });
});

describe("tag_contacts: preview, then apply", () => {
  it("preview counts who'd newly get the tag with five sample names; applying tags exactly that many (bulk Add tag write)", async () => {
    // VIP: c1 and c3 have it. c1, c2, c3 and c-out (opted out: a tag isn't a message) match "9800000".
    const p = await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "9800000" });
    expect(p.isError).toBe(false);
    expect(p.data).toMatchObject({ matched: 4, already_have_tag: 2, will_get_tag: 2 });
    expect(p.data["sample_names"]).toEqual(["(no name)", "Ravi"]);
    const before = rows("contact_tags").length;
    expect(rows("contact_tags")).toHaveLength(before); // preview wrote nothing
    const a = await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "9800000", confirm_code: p.data["confirm_code"] });
    expect(a.isError).toBe(false);
    expect(a.data["tagged"]).toBe(p.data["will_get_tag"]);
    expect(rows("contact_tags").length - before).toBe(p.data["will_get_tag"]);
    expect(rows("contact_tags").find((l) => l["contact_id"] === "c2")).toMatchObject({ organization_id: ORG, tag_id: TAG_VIP });
    // Works once.
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "9800000", confirm_code: p.data["confirm_code"] })).text).toContain("a confirm_code works once");
  });

  it("'everyone who replied YES' reads the customers' own replies (not 'Yesterday', not our own messages)", async () => {
    const p = await tool("u-marketer", "tag_contacts", { tag: "Hot lead", create_tag_if_missing: true, replied_with: "yes" });
    expect(p.data).toMatchObject({ tag_exists: false, matched: 2, will_get_tag: 2 });
    expect((p.data["sample_names"] as string[]).sort()).toEqual(["Asha", "Ravi"]);
    const a = await tool("u-marketer", "tag_contacts", { tag: "Hot lead", create_tag_if_missing: true, replied_with: "yes", confirm_code: p.data["confirm_code"] });
    expect(a.data["tagged"]).toBe(2);
    const tag = rows("tags").find((t) => t["name"] === "Hot lead")!;
    expect(tag).toMatchObject({ organization_id: ORG });
    expect(rows("contact_tags").filter((l) => l["tag_id"] === tag["id"]).map((l) => l["contact_id"]).sort()).toEqual(["c1", "c2"]);
    // Narrowed to one campaign's recipients.
    const camp = await tool("u-marketer", "tag_contacts", { tag: "VIP", replied_with: "YES", campaign_id: "camp-done" });
    expect(camp.data).toMatchObject({ matched: 2, will_get_tag: 1, sample_names: ["Ravi"] });
  });

  it("by tag, segment and explicit ids; an unknown tag is never created unless asked; at most 5,000", async () => {
    expect((await tool("u-marketer", "tag_contacts", { tag: "Gold", has_tag: "VIP" })).text).toContain('No tag called "Gold"');
    expect(rows("tags").some((t) => t["name"] === "Gold")).toBe(false);
    expect((await tool("u-marketer", "tag_contacts", { tag: "Hot", create_tag_if_missing: true, has_tag: "VIP" })).data).toMatchObject({ matched: 2, will_get_tag: 2 });
    expect((await tool("u-marketer", "tag_contacts", { tag: "Hot", create_tag_if_missing: true, segment_id: "seg-vip" })).data).toMatchObject({ matched: 2 });
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c1", "c2"] })).data).toMatchObject({ matched: 2, will_get_tag: 1 });
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c1", "cb1"] })).text).toContain("aren't customers in");
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "a", has_tag: "VIP" })).text).toContain("exactly one");
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: Array.from({ length: 5001 }, (_, i) => `x${i}`) })).isError).toBe(true);
    for (let i = 0; i < 5001; i += 1) rows("contacts").push({ id: `bulk-${i}`, organization_id: ORG, phone: `+9177${String(i).padStart(8, "0")}`, name: `Bulk ${i}`, opt_in_status: "opted_in" });
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "Bulk" })).text).toContain("more than 5,000");
  });

  it("someone new matching after the preview, or another filter, is refused; expired too", async () => {
    const p = await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "9800000" });
    rows("contacts").push({ id: "c-new", organization_id: ORG, phone: "+919800000077", name: "Neha", opt_in_status: "opted_in" });
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", search: "9800000", confirm_code: p.data["confirm_code"] })).text).toContain("Something changed");
    const p2 = await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2"] });
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2", "c-new"], confirm_code: p2.data["confirm_code"] })).text).toContain("Something changed");
    const later = () => Date.now() + CONFIRM_TTL_MS + 60_000;
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2"], confirm_code: p2.data["confirm_code"] }, later)).text).toContain("expired");
    expect(rows("contact_tags").some((l) => l["contact_id"] === "c2")).toBe(false);
  });

  it("at most 20 tag operations an hour per workspace", async () => {
    const p = await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2"] });
    w().rate.windows.set(`mcp:tag:${ORG}`, 20);
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2"], confirm_code: p.data["confirm_code"] })).text).toContain("At most 20 tag operations an hour");
    expect(rows("contact_tags").some((l) => l["contact_id"] === "c2")).toBe(false);
  });

  it("reading replies needs the Inbox", async () => {
    rows("member_permissions").push({ organization_id: ORG, user_id: "u-marketer", permission_key: "inbox.view", granted: false });
    expect((await tool("u-marketer", "tag_contacts", { tag: "VIP", replied_with: "yes" })).text).toContain("don't have permission to read customers' replies");
  });
});

describe("Aiden's questions", () => {
  it("lists what Aiden is waiting on, newest first (answered ones left out)", async () => {
    const a = await tool("u-marketer", "list_aiden_questions");
    expect(a.data["questions"]).toEqual([
      expect.objectContaining({ question_id: "q-1", question: "Do you ship to Dubai?", status: "waiting", from_customer_chat: true, chat_link: "https://aidwar.in/app/inbox?c=conv-1" }),
      expect.objectContaining({ question_id: "q-2", status: "expired", from_customer_chat: false }),
    ]);
  });

  it("answers with the user's words exactly, through answer_gap: Aiden learns it and the waiting customer gets it", async () => {
    const words = "Yes — we ship to Dubai in 5–7 days, ₹1,500 flat.\nCOD isn't available abroad 🙏";
    const p = await tool("u-admin", "answer_aiden_question", { question_id: "q-1", answer: words });
    expect(p.isError).toBe(false);
    expect(p.data).toMatchObject({ answer_exactly: words, aiden_learns_it: true, sent_to_customer: true });
    expect(h.saved).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    const a = await tool("u-admin", "answer_aiden_question", { question_id: "q-1", answer: words, confirm_code: p.data["confirm_code"] });
    expect(a.isError).toBe(false);
    expect(a.data).toMatchObject({ answered: true, sent_to_customer: true });
    expect(h.saved).toEqual([{ question: "Do you ship to Dubai?", answer: words }]);
    expect(h.delivered).toEqual([{ id: "q-1", answer: words }]);
    expect(rows("pending_owner_replies").find((r) => r["id"] === "q-1")).toMatchObject({ status: "answered", answer: words });
    expect(rows("activity_log").find((r) => r["action"] === "ai_answer_corrected")!["details"]).toMatchObject({ from: "unanswered", source: "mcp", tool: "answer_aiden_question" });
    // Works once.
    expect((await tool("u-admin", "answer_aiden_question", { question_id: "q-1", answer: words, confirm_code: p.data["confirm_code"] })).text).toContain("already answered");
    expect(h.delivered).toHaveLength(1);
  });

  it("other words than those previewed are refused (the code is bound to the exact text)", async () => {
    const p = await tool("u-admin", "answer_aiden_question", { question_id: "q-1", answer: "Yes, we do." });
    const a = await tool("u-admin", "answer_aiden_question", { question_id: "q-1", answer: "Yes, we do!", confirm_code: p.data["confirm_code"] });
    expect(a.text).toContain("Something changed");
    expect(h.saved).toHaveLength(0);
  });

  it("an expired question teaches Aiden but sends nothing to a customer", async () => {
    const p = await tool("u-admin", "answer_aiden_question", { question_id: "q-2", answer: "10am to 2pm" });
    expect(p.data["sent_to_customer"]).toBe(false);
    const a = await tool("u-admin", "answer_aiden_question", { question_id: "q-2", answer: "10am to 2pm", confirm_code: p.data["confirm_code"] });
    expect(a.data).toMatchObject({ answered: true, sent_to_customer: false });
    expect(h.saved).toEqual([{ question: "What are your Sunday hours?", answer: "10am to 2pm" }]);
    expect(h.delivered).toHaveLength(0);
  });

  it("the app's answer_gap route and the MCP tool are one path", () => {
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain('const { answerGap } = await import("@/lib/answer-gap.server");');
    expect(route).not.toContain("deliverToCustomer");
    const tools = readFileSync("src/lib/mcp-tools-r2.server.ts", "utf8");
    expect(tools).toContain('answer: args["answer"],');
    expect(tools).not.toMatch(/saveCorrection|deliverToCustomer|sendServiceText/);
  });

  it("a marketer (ai.use, no ai.configure) sees the questions but can't answer them, as in the app", async () => {
    expect((await tool("u-marketer", "list_aiden_questions")).isError).toBe(false);
    expect((await tool("u-marketer", "answer_aiden_question", { question_id: "q-1", answer: "Yes" })).text).toContain("don't have permission to answer Aiden's questions");
  });
});

describe("another workspace and lower roles are refused on every round-2 tool", () => {
  it.each(ROUND2_TOOLS.map((t) => t.name))("%s with another workspace's id", async (name) => {
    const a = await tool("u-marketer", name, { workspace_id: OTHER_ORG, campaign_id: "camp-b", question_id: "q-b", tag: "vip", has_tag: "vip", answer: "x", ...winterSale(), confirm_code: "x" });
    expect(a.isError).toBe(true);
    expect(a.text).toContain("aren't a member of that workspace");
  });

  it("another workspace's objects are not found from your own", async () => {
    const products = (await tool("u-admin", "list_products")).data["products"] as Array<{ product_id: string }>;
    expect(products.map((p) => p.product_id)).not.toContain("p-b");
    expect((await tool("u-admin", "get_campaign_sales", { campaign_id: "camp-b" })).text).toContain("No campaign");
    expect((await tool("u-admin", "preview_campaign_change", { campaign_id: "camp-b-sched", cancel: true })).text).toContain("No campaign");
    expect((await tool("u-admin", "cancel_scheduled_campaign", { campaign_id: "camp-b-sched", confirm_code: "x" })).text).toContain("No campaign");
    expect((await tool("u-admin", "answer_aiden_question", { question_id: "q-b", answer: "x" })).text).toContain("No open question");
    expect((await tool("u-admin", "tag_contacts", { tag: "VIP", contact_ids: ["cb1"] })).text).toContain("aren't customers in");
    const qs = (await tool("u-admin", "list_aiden_questions")).data["questions"] as Array<{ question_id: string }>;
    expect(qs.map((q) => q.question_id)).not.toContain("q-b");
    expect(rows("campaigns").find((c) => c["id"] === "camp-b-sched")!["status"]).toBe("scheduled");
  });

  it.each(ROUND2_TOOLS.map((t) => t.name))("an agent can't use %s", async (name) => {
    const a = await tool("u-agent", name, { campaign_id: "camp-sched", question_id: "q-1", tag: "VIP", contact_ids: ["c1"], answer: "x", cancel: true, ...winterSale(), confirm_code: "x" });
    expect(a.isError).toBe(true);
    expect(a.text).toContain("don't have permission");
  });

  it("a member's override that takes campaigns.send away stops changes to scheduled campaigns", async () => {
    const p = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", cancel: true });
    rows("member_permissions").push({ organization_id: ORG, user_id: "u-marketer", permission_key: "campaigns.send", granted: false });
    expect((await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: "camp-sched", confirm_code: p.data["confirm_code"] })).text).toContain("don't have permission");
    expect(rows("campaigns").find((c) => c["id"] === "camp-sched")!["status"]).toBe("scheduled");
  });

  it("the kill switch stops round 2 too", async () => {
    rows("organization_feature_overrides").push({ organization_id: ORG, flag_key: "mcp_access", enabled: false });
    expect((await tool("u-marketer", "list_products")).text).toContain("switched off");
  });
});

describe("audit", () => {
  it("every change writes activity_log with source mcp, the tool, the client and the object; previews write nothing", async () => {
    const before = rows("activity_log").length;
    await tool("u-marketer", "list_products");
    await tool("u-marketer", "get_campaign_sales", { campaign_id: "camp-done" });
    await tool("u-marketer", "list_aiden_questions");
    const d = await tool("u-marketer", "create_template_draft", winterSale());
    const pc = await tool("u-marketer", "preview_campaign_change", { campaign_id: "camp-sched", all_opted_in: true });
    const pt = await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2"] });
    const pa = await tool("u-admin", "answer_aiden_question", { question_id: "q-2", answer: "10am to 2pm" });
    expect(rows("activity_log")).toHaveLength(before);

    await tool("u-marketer", "submit_template", { ...winterSale(), confirm_code: d.data["confirm_code"] });
    const u = await tool("u-marketer", "update_scheduled_campaign", { campaign_id: "camp-sched", all_opted_in: true, confirm_code: pc.data["confirm_code"] });
    const pcancel = await tool("u-marketer", "preview_campaign_change", { campaign_id: String(u.data["campaign_id"]), cancel: true });
    await tool("u-marketer", "cancel_scheduled_campaign", { campaign_id: u.data["campaign_id"], confirm_code: pcancel.data["confirm_code"] });
    await tool("u-marketer", "tag_contacts", { tag: "VIP", contact_ids: ["c2"], confirm_code: pt.data["confirm_code"] });
    await tool("u-admin", "answer_aiden_question", { question_id: "q-2", answer: "10am to 2pm", confirm_code: pa.data["confirm_code"] });
    const log = rows("activity_log").filter((r) => String(r["action"]).startsWith("mcp_"));
    expect(log.map((r) => r["action"])).toEqual(["mcp_template_submitted", "mcp_campaign_changed", "mcp_campaign_cancelled", "mcp_contacts_tagged", "mcp_question_answered"]);
    for (const r of log) expect(r["details"]).toMatchObject({ source: "mcp", client_name: "Claude" });
    expect(log.map((r) => (r["details"] as Record<string, unknown>)["tool"])).toEqual(["submit_template", "update_scheduled_campaign", "cancel_scheduled_campaign", "tag_contacts", "answer_aiden_question"]);
    expect((log[3]!["details"] as Record<string, unknown>)["tagged"]).toBe(1);
  });

  it("the new actions are registered with the mcp feature", async () => {
    const { FEATURES } = await import("./feature-registry");
    const mcp = FEATURES.find((f) => f.key === "mcp")!;
    expect(mcp.activity_actions).toEqual(
      expect.arrayContaining(["mcp_template_submitted", "mcp_campaign_changed", "mcp_campaign_cancelled", "mcp_contacts_tagged", "mcp_question_answered"]),
    );
  });
});
