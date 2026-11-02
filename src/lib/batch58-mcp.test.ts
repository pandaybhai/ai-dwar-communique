import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG, ORIGIN, mcpWorld, token, type McpWorld } from "./test-support/mcp-world";
import { handleMcpRequest, INSTRUCTIONS } from "./mcp-server.server";
import { CONFIRM_TTL_MS, CONFIRM_REFUSALS } from "./mcp-confirm.server";
import { MCP_TOOL_LIST } from "./mcp-connect";
import {
  BILLING_TEMPLATES,
  PLATFORM_NOTICE_TEMPLATE_NAMES,
  STAFF_HANDOFF_TEMPLATE,
  isPlatformNoticeTemplate,
  withoutPlatformNoticeTemplates,
} from "./platform-notice-templates";

/**
 * Batch 58 item 3 on fakes (the in-memory database and a fake Supabase Auth;
 * nothing reaches the live database, WhatsApp or Meta):
 *   - refresh_confirm_code gives a fresh code for the SAME draft and creates
 *     no draft row; every code still works once;
 *   - AiDwar's own notice templates are never offered for a campaign.
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
  const body = JSON.parse(await res.text()) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } };
  const text = body.result.content[0]!.text;
  const json = text.indexOf("\n\n{");
  return {
    isError: body.result.isError === true,
    text,
    data: body.result.structuredContent ?? (json >= 0 ? (JSON.parse(text.slice(json + 2)) as Record<string, unknown>) : {}),
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

const drafts = () => rows("campaigns").filter((c) => c["status"] === "draft");

describe("refresh_confirm_code: a fresh code for the same campaign draft, never a second draft", () => {
  it("after 15 minutes the old code is refused; the refresh creates no row and its code sends that same draft once", async () => {
    const t0 = Date.now();
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs(), () => t0);
    const id = String(d.data["campaign_id"]);
    expect(drafts()).toHaveLength(1);
    const campaignsBefore = rows("campaigns").length;

    const late = () => t0 + CONFIRM_TTL_MS + 60_000;
    const expired = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: d.data["confirm_code"] }, late);
    expect(expired.isError).toBe(true);
    expect(expired.text).toContain("refresh_confirm_code");
    expect(expired.text).not.toContain("Create the draft again");

    const r = await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, campaign_id: id }, late);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("nothing new was created");
    expect(r.data).toMatchObject({ campaign_id: id, status: "draft", recipients: 1, not_opted_in_left_out: 1, wallet_covers_it: true });
    expect(r.data["confirm_code"]).not.toBe(d.data["confirm_code"]);
    // Nothing created, nothing sent.
    expect(rows("campaigns")).toHaveLength(campaignsBefore);
    expect(drafts().map((c) => c["id"])).toEqual([id]);
    expect(rows("campaign_recipients")).toHaveLength(0);

    const sent = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: r.data["confirm_code"] }, late);
    expect(sent.isError).toBe(false);
    expect(sent.data).toMatchObject({ status: "sending", recipients: 1, draft_id: id });
    // Single use: neither the new code nor the old one works again.
    for (const code of [r.data["confirm_code"], d.data["confirm_code"]]) {
      const again = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: code }, late);
      expect(again.isError).toBe(true);
    }
    expect(rows("campaigns").filter((c) => c["status"] === "sending")).toHaveLength(1);
    // And a sent draft can't be refreshed.
    expect((await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, campaign_id: id }, late)).isError).toBe(true);
  });

  it("an unexpired old code still works once after a refresh (both bound to the same draft), then the other is refused", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const id = String(d.data["campaign_id"]);
    const r = await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, campaign_id: id });
    expect(drafts()).toHaveLength(1);
    const first = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: d.data["confirm_code"] });
    expect(first.isError).toBe(false);
    const second = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: r.data["confirm_code"] });
    expect(second.isError).toBe(true);
    expect(rows("campaigns").filter((c) => c["status"] === "sending")).toHaveLength(1);
  });

  it("is audited, needs campaigns.create, and refuses a draft not made by create_campaign_draft", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const id = String(d.data["campaign_id"]);
    await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, campaign_id: id });
    const log = rows("activity_log").find((a) => a["action"] === "mcp_confirm_code_refreshed");
    expect(log).toMatchObject({ organization_id: ORG, user_id: "u-marketer" });
    expect((log!["details"] as Record<string, unknown>)["source"]).toBe("mcp");

    const agent = await tool("u-agent", "refresh_confirm_code", { workspace_id: ORG, campaign_id: id });
    expect(agent.text).toContain("don't have permission");

    rows("campaigns").push({ id: "camp-app-draft", organization_id: ORG, name: "From the app", status: "draft", template_name: "festive_offer", send_settings: {} });
    const app = await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, campaign_id: "camp-app-draft" });
    expect(app.text).toContain("Only drafts made by create_campaign_draft");
  });

  it("needs exactly one of campaign_id or flow_id", async () => {
    expect((await tool("u-admin", "refresh_confirm_code", { workspace_id: ORG })).text).toContain("either campaign_id or flow_id");
    expect((await tool("u-admin", "refresh_confirm_code", { workspace_id: ORG, campaign_id: "a", flow_id: "b" })).text).toContain(
      "either campaign_id or flow_id",
    );
  });

  it("a draft changed after its code: the refresh shows the change and its code is bound to the new state", async () => {
    const d = await tool("u-marketer", "create_campaign_draft", draftArgs());
    const id = String(d.data["campaign_id"]);
    rows("campaigns").find((c) => c["id"] === id)!["name"] = "Diwali (edited)";
    const stale = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: d.data["confirm_code"] });
    expect(stale.text).toContain("refresh_confirm_code");
    const r = await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, campaign_id: id });
    expect(r.data["name"]).toBe("Diwali (edited)");
    const ok = await tool("u-marketer", "send_campaign", { campaign_id: id, confirm_code: r.data["confirm_code"] });
    expect(ok.isError).toBe(false);
  });
});

describe("refresh_confirm_code for a flow draft", () => {
  it("no new flow or version; the new code switches that flow on once", async () => {
    const t0 = Date.now();
    const d = await tool("u-admin", "create_flow_draft", { name: "Welcome", graph: welcomeGraph }, () => t0);
    const id = String(d.data["flow_id"]);
    const flows = rows("flows").length;
    const versions = rows("flow_versions").length;
    const late = () => t0 + CONFIRM_TTL_MS + 60_000;
    expect((await tool("u-admin", "activate_flow", { flow_id: id, confirm_code: d.data["confirm_code"] }, late)).text).toContain(
      "refresh_confirm_code",
    );
    const r = await tool("u-admin", "refresh_confirm_code", { workspace_id: ORG, flow_id: id }, late);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ flow_id: id, status: "Draft", switched_on: false, problems: [] });
    expect(rows("flows")).toHaveLength(flows);
    expect(rows("flow_versions")).toHaveLength(versions);
    const on = await tool("u-admin", "activate_flow", { flow_id: id, confirm_code: r.data["confirm_code"] }, late);
    expect(on.isError).toBe(false);
    expect((await tool("u-admin", "activate_flow", { flow_id: id, confirm_code: r.data["confirm_code"] }, late)).text).toContain(
      "already switched on",
    );
    expect((await tool("u-admin", "refresh_confirm_code", { workspace_id: ORG, flow_id: id }, late)).text).toContain("already switched on");
  });

  it("a marketer (no flows_v2.edit) can't refresh a flow code", async () => {
    const d = await tool("u-admin", "create_flow_draft", { name: "Welcome", graph: welcomeGraph });
    expect((await tool("u-marketer", "refresh_confirm_code", { workspace_id: ORG, flow_id: d.data["flow_id"] })).text).toContain(
      "don't have permission",
    );
  });
});

describe("docs and instructions name the tool", () => {
  it("server instructions, the /developers list and the expired refusal point at refresh_confirm_code", () => {
    expect(INSTRUCTIONS).toContain("refresh_confirm_code");
    expect(INSTRUCTIONS).toContain("never draft it again");
    expect(MCP_TOOL_LIST.find((t) => t.name === "refresh_confirm_code")).toMatchObject({ kind: "draft" });
    expect(CONFIRM_REFUSALS.expired).toContain("refresh_confirm_code");
  });
});

describe("AiDwar's own notice templates are never offered for a campaign", () => {
  it("one list, exact names: billing notices, the staff alert and the onboarding nudges", () => {
    for (const t of BILLING_TEMPLATES) expect(isPlatformNoticeTemplate(t.name)).toBe(true);
    expect(isPlatformNoticeTemplate(STAFF_HANDOFF_TEMPLATE.name)).toBe(true);
    for (const n of ["client_invoice_overdue", "admin_ai_provider_alert", "staff_handoff_alert", "aidwar_onboarding_start", "aidwar_onboarding_resume", "aidwar_onboarding_resume_link"])
      expect(PLATFORM_NOTICE_TEMPLATE_NAMES.has(n)).toBe(true);
    // A merchant's own template with a similar prefix is never hidden.
    for (const n of ["client_feedback", "admin_sale", "staff_party", "festive_offer"]) expect(isPlatformNoticeTemplate(n)).toBe(false);
    expect(withoutPlatformNoticeTemplates([{ name: "client_invoice_overdue" }, { name: "festive_offer" }])).toEqual([{ name: "festive_offer" }]);
  });

  it("list_templates leaves them out and create_campaign_draft refuses them", async () => {
    for (const name of ["client_invoice_overdue", "aidwar_onboarding_start", "staff_handoff_alert"]) {
      rows("message_templates").push({
        id: `t-${name}`,
        organization_id: ORG,
        waba_id: "waba-a",
        name,
        language: "en",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hello {{1}} there {{2}} now {{3}} ok" }],
      });
    }
    const list = await tool("u-marketer", "list_templates", { workspace_id: ORG });
    const names = (list.data["templates"] as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("festive_offer");
    for (const hidden of ["client_invoice_overdue", "aidwar_onboarding_start", "staff_handoff_alert"]) expect(names).not.toContain(hidden);
    const draft = await tool("u-marketer", "create_campaign_draft", draftArgs({ template_name: "client_invoice_overdue", variables: { "1": "a", "2": "b", "3": "c" } }));
    expect(draft.isError).toBe(true);
    expect(draft.text).toContain("AiDwar's own notice templates");
    expect(drafts()).toHaveLength(0);
  });
});
