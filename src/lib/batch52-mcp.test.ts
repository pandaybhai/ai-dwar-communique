import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CLIENT_ID, ISSUER, ORG, ORIGIN, OTHER_ORG, SECRET, TAG_VIP, mcpWorld, token, type McpWorld } from "./test-support/mcp-world";
import { handleMcpRequest } from "./mcp-server.server";
import { MCP_TOOLS } from "./mcp-tools.server";
import { issueConfirmCode, verifyConfirmCode, CONFIRM_TTL_MS } from "./mcp-confirm.server";
import { collapseLeadingSlashes } from "./double-slash";

/**
 * Batch 52 — AiDwar MCP end to end on fakes (the in-memory database, a fake
 * Supabase Auth; nothing reaches the live database, WhatsApp or Meta).
 * The 401 challenge and resource metadata; token checks; every tool's happy
 * path; another workspace and a lower role refused on every tool; the
 * confirm_code (expiry, reuse, tampering, a draft changed after it was
 * issued); opted-out customers left out; a wallet too low blocks the send;
 * flow drafts always off; the kill switch; rate limits; audit rows; the
 * app's own routes refuse an AI app's token; //oauth/consent; and a run with
 * the official SDK client.
 */

const h = vi.hoisted(() => ({ world: null as null | McpWorld }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

const w = () => h.world!;
const rows = (t: string) => w().rows(t);

beforeEach(() => {
  process.env["AIDWAR_SUPABASE_URL"] = "https://hcsacmqzspnfqoftoifu.supabase.co";
  h.world = mcpWorld();
  vi.stubGlobal("fetch", async () => new Response("no network in tests", { status: 599 }));
});
afterEach(() => vi.unstubAllGlobals());

const tok = (sub: string, extra: Record<string, unknown> = {}) => token({ sub, ...extra });

async function post(bearer: string | null, body: unknown, now?: () => number) {
  const deps = now ? { ...w().deps, now } : w().deps;
  const res = await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

type ToolAnswer = { isError: boolean; text: string; data: Record<string, unknown> };

async function tool(user: string, name: string, args: Record<string, unknown> = {}, now?: () => number): Promise<ToolAnswer> {
  const res = await post(tok(user), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, now);
  expect(res.status).toBe(200);
  const result = (res.body as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }).result;
  const text = result.content[0]!.text;
  const json = text.indexOf("\n\n{");
  return {
    isError: result.isError === true,
    text,
    data: result.structuredContent ?? (json >= 0 ? (JSON.parse(text.slice(json + 2)) as Record<string, unknown>) : {}),
  };
}

const draftArgs = (over: Record<string, unknown> = {}) => ({
  workspace_id: ORG,
  name: "Diwali",
  template_name: "festive_offer",
  variables: { "1": { source: "name" }, "2": "20% off" },
  segment_id: "seg-vip",
  ...over,
});

describe("discovery and the 401 challenge", () => {
  it("serves RFC 9728 metadata at both well-known paths, pointing at the Supabase auth server", async () => {
    const { Route: Root } = await import("../routes/[.]well-known.oauth-protected-resource");
    const { Route: Path } = await import("../routes/[.]well-known.oauth-protected-resource.mcp");
    for (const route of [Root, Path]) {
      const get = (route.options as unknown as { server: { handlers: { GET: (a: { request: Request }) => Promise<Response> } } }).server.handlers.GET;
      const res = await get({ request: new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: "https://aidwar.in/mcp",
        authorization_servers: [ISSUER],
        bearer_methods_supported: ["header"],
        scopes_supported: ["openid", "email", "profile"],
        resource_name: "AiDwar",
        resource_documentation: "https://aidwar.in/developers#mcp",
      });
    }
  });

  it("answers a call without a token with 401 + WWW-Authenticate resource_metadata", async () => {
    const res = await post(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://aidwar.in/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it.each([
    ["expired", tok("u-marketer", { exp: Math.floor(Date.now() / 1000) - 5 })],
    ["wrong issuer", tok("u-marketer", { iss: "https://evil.example/auth/v1" })],
    ["wrong audience", tok("u-marketer", { aud: "anon", role: "anon" })],
    ["bad signature", token({ sub: "u-marketer" }, "bad")],
    ["an app session (no client_id)", tok("u-marketer", { client_id: undefined })],
    ["not a JWT", "u-marketer"],
  ])("rejects a token that is %s with 401 invalid_token", async (_why, bearer) => {
    const res = await post(bearer, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("rejects a token whose grant was revoked (session gone)", async () => {
    const t = tok("u-marketer");
    w().revoked.add(t);
    expect((await post(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });

  it("is stateless: GET is 405, OPTIONS is a CORS preflight", async () => {
    const get = await handleMcpRequest(new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${tok("u-marketer")}` } }), w().deps);
    expect(get.status).toBe(405);
    const pre = await handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method: "OPTIONS" }), w().deps);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-expose-headers")).toContain("www-authenticate");
  });
});

describe("the tool list", () => {
  it("is exactly the read-only and may-modify tools, with annotations — no message, mode, billing, delete or team tool", async () => {
    const res = await post(tok("u-marketer"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res.body as { result: { tools: Array<{ name: string; annotations: Record<string, boolean>; description: string; inputSchema: { properties?: Record<string, unknown> } }> } }).result.tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    const readOnly = ["list_workspaces", "get_workspace_overview", "list_templates", "list_segments", "count_audience", "search_contacts", "list_campaigns", "get_campaign_report", "list_flows", "get_flow", "list_needs_attention"];
    const modify = ["create_segment", "create_campaign_draft", "send_campaign", "create_flow_draft", "activate_flow"];
    expect(Object.keys(by).sort()).toEqual([...readOnly, ...modify].sort());
    for (const n of readOnly) expect(by[n]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const n of modify) expect(by[n]!.annotations["readOnlyHint"]).toBe(false);
    expect(by["send_campaign"]!.annotations["destructiveHint"]).toBe(true);
    expect(by["activate_flow"]!.annotations["destructiveHint"]).toBe(true);
    expect(by["create_campaign_draft"]!.annotations["destructiveHint"]).toBe(false);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(60);
      if (t.name !== "list_workspaces") expect(t.inputSchema.properties).toHaveProperty("workspace_id");
    }
  });
});

describe("read-only tools — happy paths", () => {
  it("list_workspaces lists the memberships", async () => {
    const a = await tool("u-owner", "list_workspaces");
    expect(a.isError).toBe(false);
    expect((a.data["workspaces"] as unknown[]).length).toBe(2);
  });

  it("get_workspace_overview: plan, Aiden's mode, numbers, chats; wallet only with billing.view", async () => {
    const owner = await tool("u-owner", "get_workspace_overview", { workspace_id: ORG });
    expect(owner.data).toMatchObject({ aiden_mode: "replying", chats: { open: 2, need_a_person: 1 } });
    expect(owner.data["wallet"]).toMatchObject({ available: 100, currency: "INR" });
    expect((owner.data["whatsapp_numbers"] as unknown[]).length).toBe(1);
    expect(owner.data["link"]).toBe("https://aidwar.in/app");
    const marketer = await tool("u-marketer", "get_workspace_overview");
    expect(marketer.data["wallet"]).toBe("Not visible to your role.");
  });

  it("list_templates: approved only, with variables, buttons and header media", async () => {
    const a = await tool("u-marketer", "list_templates");
    const names = (a.data["templates"] as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("festive_offer");
    expect(names).not.toContain("invoice_pending");
    expect(names).not.toContain("b_invoice");
    const offer = (a.data["templates"] as Array<Record<string, unknown>>).find((t) => t["name"] === "festive_offer")!;
    expect(offer["body_variables"]).toEqual(["{{1}}", "{{2}}"]);
    const invoice = (a.data["templates"] as Array<Record<string, unknown>>).find((t) => t["name"] === "invoice_ready")!;
    expect(invoice["header_media"]).toEqual({ type: "document", has_default_file: false });
  });

  it("list_segments describes rules in words", async () => {
    const a = await tool("u-marketer", "list_segments");
    expect(a.data["segments"]).toEqual([expect.objectContaining({ segment_id: "seg-vip", rules: ["Tag has VIP"] })]);
  });

  it("count_audience counts opted-in customers only (segment, tags, all)", async () => {
    expect((await tool("u-marketer", "count_audience", { segment_id: "seg-vip" })).data).toMatchObject({ opted_in: 1, matched: 2, not_opted_in: 1 });
    expect((await tool("u-marketer", "count_audience", { tags: ["vip"] })).data).toMatchObject({ opted_in: 1, matched: 2 });
    // c1, c2 opted in; c3 unknown and c-out opted out are not counted.
    expect((await tool("u-marketer", "count_audience", { all_opted_in: true })).data).toMatchObject({ opted_in: 2 });
    expect((await tool("u-marketer", "count_audience", { segment_id: "seg-vip", all_opted_in: true })).isError).toBe(true);
  });

  it("search_contacts masks numbers unless the role may export; at most 50 a page", async () => {
    const m = await tool("u-marketer", "search_contacts", { query: "Asha" });
    expect(m.data["contacts"]).toEqual([expect.objectContaining({ name: "Asha", phone: "+91••••••0001", tags: ["VIP"] })]);
    expect(m.data["phone_numbers"]).toBe("masked");
    const a = await tool("u-admin", "search_contacts", { query: "Asha" });
    expect(a.data["contacts"]).toEqual([expect.objectContaining({ phone: "+919800000001" })]);
    expect((await tool("u-marketer", "search_contacts", { limit: 51 })).isError).toBe(true);
    const tagged = await tool("u-marketer", "search_contacts", { tag: "VIP" });
    expect((tagged.data["contacts"] as unknown[]).length).toBe(2);
  });

  it("list_campaigns and get_campaign_report", async () => {
    const list = await tool("u-marketer", "list_campaigns");
    expect(list.data["campaigns"]).toEqual([expect.objectContaining({ campaign_id: "camp-done", link: "https://aidwar.in/app/campaigns/camp-done" })]);
    const r = await tool("u-marketer", "get_campaign_report", { campaign_id: "camp-done" });
    expect(r.data).toMatchObject({
      counts: { recipients: 100, sent: 100, delivered: 90, read: 60, replied: 9, failed: 10 },
      rates_percent: { delivered_of_sent: 90, read_of_delivered: 66.7, replied_of_delivered: 10 },
      cost: { amount: 15, final: true },
    });
  });

  it("list_needs_attention: who and why, the last customer message preview only", async () => {
    const a = await tool("u-agent", "list_needs_attention");
    const chats = a.data["chats"] as Array<Record<string, unknown>>;
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      conversation_id: "conv-1",
      customer: "Asha",
      phone: "+91••••••0001",
      reason: "price_question",
      last_customer_message_preview: "Hi, how much is the gold set?",
      link: "https://aidwar.in/app/inbox?c=conv-1",
    });
    expect(a.text).not.toContain("SECRET staff reply");
    expect(a.text).not.toContain("Earlier private message");
  });
});

describe("create_segment", () => {
  it("saves the builder's row (tag name -> id) and counts it; nothing is sent", async () => {
    const a = await tool("u-marketer", "create_segment", { name: "VIPs from AI", rules: [{ field: "tag", operator: "has", value: "VIP" }] });
    expect(a.isError).toBe(false);
    const seg = rows("segments").find((s) => s["name"] === "VIPs from AI")!;
    expect(seg).toMatchObject({ organization_id: ORG, created_by: "u-marketer", filters: { match: "all", conditions: [{ field: "tag", operator: "has", value: TAG_VIP }] } });
    expect(a.data).toMatchObject({ segment_id: seg["id"], opted_in: 1 });
    expect(rows("campaigns")).toHaveLength(2);
  });

  it("refuses an unknown tag, a wrong operator and a duplicate name", async () => {
    expect((await tool("u-marketer", "create_segment", { name: "X", rules: [{ field: "tag", operator: "has", value: "Gold" }] })).text).toContain('No tag called "Gold"');
    expect((await tool("u-marketer", "create_segment", { name: "X", rules: [{ field: "tag", operator: "equals", value: "VIP" }] })).isError).toBe(true);
    expect((await tool("u-marketer", "create_segment", { name: "VIP", rules: [{ field: "tag", operator: "has", value: "VIP" }] })).text).toContain("already exists");
  });
});

describe("campaign: draft, then confirm", () => {
  it("drafts without sending: draft row, opted-in count, cost, wallet, confirm_code, link", async () => {
    const a = await tool("u-marketer", "create_campaign_draft", draftArgs());
    expect(a.isError).toBe(false);
    expect(a.data).toMatchObject({
      status: "draft",
      recipients: 1,
      not_opted_in_left_out: 1,
      estimated_cost: { amount: 0.15, currency: "INR" },
      wallet_available: { amount: 100 },
      wallet_covers_it: true,
    });
    const id = String(a.data["campaign_id"]);
    expect(a.data["link"]).toBe(`https://aidwar.in/app/campaigns/${id}`);
    expect(String(a.data["confirm_code"])).toMatch(/^[0-9a-z]+\.[0-9a-f]{16}\.[A-Za-z0-9_-]{32}$/);
    const row = rows("campaigns").find((c) => c["id"] === id)!;
    expect(row).toMatchObject({ status: "draft", template_name: "festive_offer", segment_id: "seg-vip", total_recipients: 1 });
    expect(rows("campaign_recipients")).toHaveLength(0);
  });

  it("sends through launchCampaign: opted-in recipients only, the draft gone, a code works once", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const id = String(d.data["campaign_id"]);
    const send = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: d.data["confirm_code"] });
    expect(send.isError).toBe(false);
    expect(send.data).toMatchObject({ status: "sending", recipients: 1, draft_id: id });
    const launched = rows("campaigns").find((c) => c["id"] === send.data["campaign_id"])!;
    expect(launched).toMatchObject({ status: "sending", name: "Diwali", created_by: "u-marketer" });
    expect(rows("campaigns").some((c) => c["id"] === id)).toBe(false);
    const recipients = rows("campaign_recipients").filter((r) => r["campaign_id"] === launched["id"]);
    expect(recipients.map((r) => r["contact_id"])).toEqual(["c1"]); // c3 (unknown) left out
    expect(recipients[0]!["resolved_variables"]).toEqual({ "1": "Asha", "2": "20% off" });
    // Reuse: the draft is no longer a draft.
    const again = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: d.data["confirm_code"] });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/No campaign draft|already/);
    // An all_opted_in draft never includes the opted-out contact.
    const all = await tool("u-marketer", "create_campaign_draft", draftArgs({ segment_id: undefined, all_opted_in: true, name: "All" }));
    const sentAll = await tool("u-marketer", "send_campaign", { campaign_id: all.data["campaign_id"], confirm_code: all.data["confirm_code"] });
    const allRecipients = rows("campaign_recipients").filter((r) => r["campaign_id"] === sentAll.data["campaign_id"]).map((r) => r["contact_id"]);
    expect(allRecipients.sort()).toEqual(["c1", "c2"]);
    expect(allRecipients).not.toContain("c-out");
  });

  it("an expired code is refused", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const later = () => Date.now() + CONFIRM_TTL_MS + 60_000;
    const a = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] }, later);
    expect(a.isError).toBe(true);
    expect(a.text).toContain("expired");
    expect(rows("campaigns").find((c) => c["id"] === d.data["campaign_id"])!["status"]).toBe("draft");
  });

  it("a tampered code, or one used by another person, is refused", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const code = String(d.data["confirm_code"]);
    const flipped = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    expect((await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: flipped })).text).toContain("doesn't belong");
    expect((await tool("u-owner", "send_campaign", { workspace_id: ORG, campaign_id: d.data["campaign_id"], confirm_code: code })).text).toContain("doesn't belong");
    expect((await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: "123" })).isError).toBe(true);
  });

  it("a draft changed after its code was issued is refused (audience rules, template, schedule)", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    rows("segments").find((s) => s["id"] === "seg-vip")!["filters"] = { match: "all", conditions: [] };
    const a = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("changed after the confirm_code");
    const d2 = await tool("u-marketer", "create_campaign_draft", draftArgs({ name: "Two" }));
    rows("campaigns").find((c) => c["id"] === d2.data["campaign_id"])!["template_name"] = "shop_link";
    expect((await tool("u-marketer", "send_campaign", { campaign_id: d2.data["campaign_id"], confirm_code: d2.data["confirm_code"] })).text).toContain("changed");
    expect(rows("campaign_recipients")).toHaveLength(0);
  });

  it("a wallet too low blocks the send; the draft stays for later", async () => {
    rows("wallet_balances")[0]!["balance"] = 0;
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    expect(d.data["wallet_covers_it"]).toBe(false);
    expect(d.text).toContain("add credits");
    const a = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] });
    expect(a.isError).toBe(true);
    expect(a.text).toContain("Not sent");
    expect(a.text).toContain("credits");
    expect(rows("campaigns").find((c) => c["id"] === d.data["campaign_id"])!["status"]).toBe("draft");
    expect(rows("campaign_recipients")).toHaveLength(0);
    // Credits added: the same code (still fresh) now sends.
    rows("wallet_balances")[0]!["balance"] = 100;
    expect((await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] })).isError).toBe(false);
  });

  it("re-checks the template's approval at send time", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    rows("message_templates").find((t) => t["name"] === "festive_offer")!["status"] = "PAUSED";
    const a = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("isn't approved");
  });

  it("refuses a draft missing a variable, an unapproved template or no audience choice", async () => {
    expect((await tool("u-marketer", "create_campaign_draft", draftArgs({ variables: { "1": "Hi" } }))).text).toContain("{{2}}");
    expect((await tool("u-marketer", "create_campaign_draft", draftArgs({ template_name: "invoice_pending" }))).text).toContain("isn't approved");
    expect((await tool("u-marketer", "create_campaign_draft", draftArgs({ segment_id: undefined }))).text).toContain("audience");
    expect((await tool("u-marketer", "create_campaign_draft", draftArgs({ template_name: "invoice_ready", variables: { "1": "a", "2": "b", "3": "c" } }))).text).toContain("header_media_url");
  });

  it("only drafts made through MCP can be sent from here", async () => {
    rows("campaigns").push({ id: "camp-app-draft", organization_id: ORG, name: "App draft", status: "draft", send_settings: {} });
    const code = await issueConfirmCode({ userId: "u-marketer", workspaceId: ORG, objectId: "camp-app-draft", action: "send_campaign", stateHash: "0".repeat(64) }, Date.now(), SECRET);
    expect((await tool("u-marketer", "send_campaign", { campaign_id: "camp-app-draft", confirm_code: code.code })).text).toContain("Only drafts made by create_campaign_draft");
  });
});

const welcomeGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "hello", type: "text", data: { text: "Hi {{name}}! Welcome to the shop." } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "hello", sourceHandle: "next" },
    { id: "e2", source: "hello", target: "end", sourceHandle: "next" },
  ],
};

describe("flows: draft (always off), then confirm", () => {
  it("drafts a flow switched off with a readable summary, then activates it with the code (once)", async () => {
    const d = await tool("u-admin", "create_flow_draft", { name: "Welcome", graph: welcomeGraph });
    expect(d.isError).toBe(false);
    const id = String(d.data["flow_id"]);
    expect(d.data).toMatchObject({ status: "Draft", switched_on: false, steps: ["1. Message: Hi {{name}}! Welcome to the shop.", "2. End"], problems: [] });
    expect(rows("flows").find((f) => f["id"] === id)).toMatchObject({ is_enabled: false, name: "Welcome" });
    expect(rows("flow_versions").find((v) => v["flow_id"] === id)).toMatchObject({ status: "draft", version: 1 });
    expect(d.data["link"]).toBe(`https://aidwar.in/app/flows/v2/${id}`);
    const on = await tool("u-admin", "activate_flow", { flow_id: id, confirm_code: d.data["confirm_code"] });
    expect(on.isError).toBe(false);
    expect(on.text).toContain("no trigger yet");
    expect(rows("flows").find((f) => f["id"] === id)!["is_enabled"]).toBe(true);
    expect(w().publishCalls).toHaveLength(1);
    const again = await tool("u-admin", "activate_flow", { flow_id: id, confirm_code: d.data["confirm_code"] });
    expect(again.text).toContain("already switched on");
  });

  it("a starter works; a graph with problems is saved off with no code; HTTP steps are refused", async () => {
    const s = await tool("u-admin", "create_flow_draft", { name: "Hello", starter: "welcome_message" });
    expect(s.data["confirm_code"]).toBeTruthy();
    const broken = await tool("u-admin", "create_flow_draft", {
      name: "Broken",
      graph: { nodes: [{ id: "a", type: "text", data: { text: "x" } }, { id: "b", type: "end", data: {} }], edges: [] },
    });
    expect(broken.data["confirm_code"]).toBeNull();
    expect(broken.data["problems"]).toContain("A flow needs exactly one start.");
    expect(rows("flows").find((f) => f["id"] === broken.data["flow_id"])!["is_enabled"]).toBe(false);
    const http = await tool("u-admin", "create_flow_draft", {
      name: "Exfil",
      graph: { nodes: [{ id: "s", type: "start", data: {} }, { id: "h", type: "http", data: { url: "https://x.example" } }], edges: [] },
    });
    expect(http.text).toContain("can't be added from an AI assistant");
    expect(rows("flows").some((f) => f["name"] === "Exfil")).toBe(false);
  });

  it("a draft edited after its code was issued is not switched on", async () => {
    const d = await tool("u-admin", "create_flow_draft", { name: "Welcome", graph: welcomeGraph });
    const v = rows("flow_versions").find((x) => x["flow_id"] === d.data["flow_id"])!;
    (v["graph"] as { nodes: Array<{ data: Record<string, unknown> }> }).nodes[1]!.data["text"] = "Changed";
    const a = await tool("u-admin", "activate_flow", { flow_id: d.data["flow_id"], confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("changed after the confirm_code");
    expect(rows("flows").find((f) => f["id"] === d.data["flow_id"])!["is_enabled"]).toBe(false);
  });

  it("get_flow and list_flows read it back", async () => {
    const d = await tool("u-admin", "create_flow_draft", { name: "Welcome", graph: welcomeGraph });
    const g = await tool("u-marketer", "get_flow", { flow_id: d.data["flow_id"] });
    expect(g.data).toMatchObject({ status: "Draft", steps: ["1. Message: Hi {{name}}! Welcome to the shop.", "2. End"], triggers: [] });
    const l = await tool("u-marketer", "list_flows");
    expect(l.data["flows"]).toEqual([expect.objectContaining({ flow_id: d.data["flow_id"], status: "Draft", triggers_on: 0 })]);
  });
});

describe("another workspace and lower roles are refused on every tool", () => {
  const argsFor: Record<string, Record<string, unknown>> = {
    get_campaign_report: { campaign_id: "camp-b" },
    get_flow: { flow_id: "flow-b" },
    create_segment: { name: "x", rules: [{ field: "opt_in_status", operator: "is", value: "opted_in" }] },
    create_campaign_draft: draftArgs({ workspace_id: OTHER_ORG, segment_id: "seg-b" }),
    send_campaign: { campaign_id: "camp-b", confirm_code: "abc" },
    create_flow_draft: { name: "x", starter: "blank" },
    activate_flow: { flow_id: "flow-b", confirm_code: "abc" },
  };
  it.each(MCP_TOOLS.filter((t) => !t.noWorkspace).map((t) => t.name))("%s with another workspace's id", async (name) => {
    const a = await tool("u-marketer", name, { ...(argsFor[name] ?? {}), workspace_id: OTHER_ORG });
    expect(a.isError).toBe(true);
    expect(a.text).toContain("aren't a member of that workspace");
  });

  it("another workspace's objects are not found from your own workspace", async () => {
    expect((await tool("u-admin", "get_campaign_report", { campaign_id: "camp-b" })).text).toContain("No campaign");
    expect((await tool("u-admin", "get_flow", { flow_id: "flow-b" })).text).toContain("No chat flow");
    expect((await tool("u-admin", "send_campaign", { campaign_id: "camp-b", confirm_code: "x" })).text).toContain("No campaign draft");
    expect((await tool("u-admin", "activate_flow", { flow_id: "flow-b", confirm_code: "x" })).text).toContain("No chat flow");
    expect((await tool("u-admin", "count_audience", { segment_id: "seg-b" })).isError).toBe(true);
  });

  it("several workspaces and none named: asks which", async () => {
    const a = await tool("u-owner", "list_campaigns");
    expect(a.isError).toBe(true);
    expect(a.text).toContain("several workspaces");
    expect(a.data["workspaces"]).toHaveLength(2);
  });

  it("an agent can read the Inbox but can't draft, send, segment or build flows", async () => {
    for (const [name, args] of [
      ["create_campaign_draft", draftArgs()],
      ["send_campaign", { campaign_id: "camp-done", confirm_code: "x" }],
      ["create_segment", { name: "x", rules: [{ field: "opt_in_status", operator: "is", value: "opted_in" }] }],
      ["create_flow_draft", { name: "x", starter: "blank" }],
      ["list_campaigns", {}],
    ] as const) {
      const a = await tool("u-agent", name, args as Record<string, unknown>);
      expect(a.isError, name).toBe(true);
      expect(a.text, name).toContain("don't have permission");
    }
  });

  it("a marketer drafts and sends campaigns but can't build flows (flows_v2.edit is admin)", async () => {
    expect((await tool("u-marketer", "create_flow_draft", { name: "x", starter: "blank" })).text).toContain("don't have permission");
  });

  it("a member's override that takes campaigns.send away stops send_campaign", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    rows("member_permissions").push({ organization_id: ORG, user_id: "u-marketer", permission_key: "campaigns.send", granted: false });
    const a = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("don't have permission to send campaigns");
  });

  it("a super admin who isn't a member gets nothing", async () => {
    const a = await tool("u-super", "list_campaigns", { workspace_id: ORG });
    expect(a.text).toContain("aren't a member");
  });
});

describe("kill switch, mcp.use and rate limits", () => {
  it("mcp_access off for a workspace: every tool says so", async () => {
    rows("organization_feature_overrides").push({ organization_id: ORG, flag_key: "mcp_access", enabled: false });
    const a = await tool("u-marketer", "list_campaigns");
    expect(a.isError).toBe(true);
    expect(a.text).toContain("switched off");
  });

  it("no flag row yet (20261260 not applied) = on; flag default off = off", async () => {
    const flags = rows("feature_flags");
    flags.splice(flags.findIndex((f) => f["key"] === "mcp_access"), 1);
    expect((await tool("u-marketer", "list_campaigns")).isError).toBe(false);
    flags.push({ key: "mcp_access", default_enabled: false });
    expect((await tool("u-marketer", "list_campaigns")).text).toContain("switched off");
  });

  it("mcp.use taken away from a member refuses; a database without mcp.use allows", async () => {
    rows("member_permissions").push({ organization_id: ORG, user_id: "u-marketer", permission_key: "mcp.use", granted: false });
    expect((await tool("u-marketer", "list_campaigns")).text).toContain("permission to use AiDwar from an AI assistant");
    const perms = rows("permissions");
    perms.splice(perms.findIndex((p) => p["key"] === "mcp.use"), 1);
    expect((await tool("u-marketer", "list_campaigns")).isError).toBe(false);
  });

  it("60 tool calls a minute per person", async () => {
    w().rate.windows.set("mcp:user:u-marketer", 60);
    const a = await tool("u-marketer", "list_campaigns");
    expect(a.text).toContain("at most 60 a minute");
  });

  it("5 campaign sends an hour per workspace (the draft stays)", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    w().rate.windows.set(`mcp:send:${ORG}`, 5);
    const a = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] });
    expect(a.text).toContain("At most 5 campaigns an hour");
    expect(rows("campaigns").find((c) => c["id"] === d.data["campaign_id"])!["status"]).toBe("draft");
  });
});

describe("audit", () => {
  it("every change writes activity_log with source mcp, the tool, the client and the object", async () => {
    const seg = await tool("u-marketer", "create_segment", { name: "Opted", rules: [{ field: "opt_in_status", operator: "is", value: "opted_in" }] });
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const s = await tool("u-marketer", "send_campaign", { campaign_id: d.data["campaign_id"], confirm_code: d.data["confirm_code"] });
    const f = await tool("u-admin", "create_flow_draft", { name: "Welcome", graph: welcomeGraph });
    await tool("u-admin", "activate_flow", { flow_id: f.data["flow_id"], confirm_code: f.data["confirm_code"] });
    const log = rows("activity_log").filter((r) => String(r["action"]).startsWith("mcp_"));
    expect(log.map((r) => r["action"])).toEqual(["mcp_segment_created", "mcp_campaign_drafted", "mcp_campaign_sent", "mcp_flow_drafted", "mcp_flow_activated"]);
    for (const r of log) expect(r["details"]).toMatchObject({ source: "mcp", client_id: CLIENT_ID, client_name: "Claude" });
    expect(log.map((r) => (r["details"] as Record<string, unknown>)["object_id"])).toEqual([seg.data["segment_id"], d.data["campaign_id"], s.data["campaign_id"], f.data["flow_id"], f.data["flow_id"]]);
    expect(log.map((r) => (r["details"] as Record<string, unknown>)["tool"])).toEqual(["create_segment", "create_campaign_draft", "send_campaign", "create_flow_draft", "activate_flow"]);
    // The app's own launch entry says it came from MCP too.
    expect(rows("activity_log").find((r) => r["action"] === "campaign_launched")!["details"]).toMatchObject({ source: "mcp", tool: "send_campaign", client_id: CLIENT_ID });
    // Reads write nothing.
    const before = rows("activity_log").length;
    await tool("u-marketer", "list_campaigns");
    expect(rows("activity_log")).toHaveLength(before);
  });
});

describe("confirm codes", () => {
  const binding = { userId: "u1", workspaceId: "w1", objectId: "o1", action: "send_campaign" as const, stateHash: "a".repeat(64) };
  it("bind every field and expire after 15 minutes", async () => {
    const now = Date.now();
    const { code } = await issueConfirmCode(binding, now, SECRET);
    expect(await verifyConfirmCode(code, binding, now, SECRET)).toEqual({ ok: true });
    for (const k of ["userId", "workspaceId", "objectId"] as const)
      expect(await verifyConfirmCode(code, { ...binding, [k]: "other" }, now, SECRET)).toEqual({ ok: false, reason: "tampered" });
    expect(await verifyConfirmCode(code, { ...binding, action: "activate_flow" }, now, SECRET)).toEqual({ ok: false, reason: "tampered" });
    expect(await verifyConfirmCode(code, { ...binding, stateHash: "b".repeat(64) }, now, SECRET)).toEqual({ ok: false, reason: "changed" });
    expect(await verifyConfirmCode(code, binding, now + CONFIRM_TTL_MS + 1000, SECRET)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyConfirmCode(code, binding, now, "another-secret")).toEqual({ ok: false, reason: "tampered" });
  });
});

describe("the app's own routes refuse an AI app's token", () => {
  it("POST /api/campaigns/launch with a client_id token is 403; nothing is created", async () => {
    const { Route } = await import("../routes/api/campaigns/launch");
    const post = (Route.options as unknown as { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }).server.handlers.POST;
    const res = await post({
      request: new Request(`${ORIGIN}/api/campaigns/launch`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok("u-marketer")}`, "content-type": "application/json" },
        body: JSON.stringify({ organization_id: ORG, name: "Sneaky", template_name: "festive_offer" }),
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("MCP tools");
    expect(rows("campaigns").some((c) => c["name"] === "Sneaky")).toBe(false);
  });
});

describe("//oauth/consent", () => {
  it("308s a doubled leading slash to one, keeping the query", () => {
    const res = collapseLeadingSlashes(new Request("https://aidwar.in//oauth/consent?authorization_id=abc"))!;
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/oauth/consent?authorization_id=abc");
    expect(collapseLeadingSlashes(new Request("https://aidwar.in///x"))!.headers.get("location")).toBe("/x");
    expect(collapseLeadingSlashes(new Request("https://aidwar.in/oauth/consent?a=1"))).toBeNull();
  });
});

describe("end to end with the official MCP SDK client", () => {
  it("connects, lists tools, drafts a campaign and confirms it", async () => {
    const bearer = tok("u-marketer");
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: async (url, init) => handleMcpRequest(new Request(url, init), w().deps),
    });
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    await client.connect(transport as unknown as Transport);
    expect(client.getServerVersion()).toMatchObject({ name: "aidwar" });
    expect(client.getInstructions()).toContain("only after they clearly confirm");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const draft = (await client.callTool({ name: "create_campaign_draft", arguments: draftArgs() })) as { structuredContent: Record<string, unknown> };
    expect(draft.structuredContent).toMatchObject({ status: "draft", recipients: 1 });
    const sent = (await client.callTool({
      name: "send_campaign",
      arguments: { campaign_id: draft.structuredContent["campaign_id"], confirm_code: draft.structuredContent["confirm_code"] },
    })) as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(sent.isError).toBeFalsy();
    expect(sent.structuredContent).toMatchObject({ status: "sending", recipients: 1 });
    await client.close();
  });

  it("without a token the SDK client sees the 401 challenge", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: async (url, init) => handleMcpRequest(new Request(url, init), w().deps),
    });
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    await expect(client.connect(transport as unknown as Transport)).rejects.toThrow();
  });
});
