import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { ORG, ORIGIN, SECRET, mcpWorld, nodeDbProof, sha256Hex, token, type McpWorld } from "./test-support/mcp-world";
import {
  MCP_DB_PROOF_HEADER,
  MCP_DB_PROOF_LABEL,
  ensureDbProof,
  mcpDbProof,
  mcpDbProofHash,
  mcpUserClient,
  proofWatchingFetch,
  resetDbProofStateForTests,
} from "./mcp-db-proof.server";
import { handleMcpRequest } from "./mcp-server.server";

/**
 * Batch 56 — the MCP server's side of "an AI app's token works only through
 * AiDwar MCP": the proof (HKDF label aidwar-mcp-db-proof from the service-role
 * key, no new secret), the one user client that sends it on every request,
 * the once-per-isolate bootstrap of its hash (and the PGRST202 case: the code
 * works without 20261300), the loud log when the database refuses it, and all
 * 26 tools through a database that answers only with the proof. The database
 * side is batch56-sql.test.ts. Nothing reaches the live database.
 */

const h = vi.hoisted(() => ({ world: null as null | McpWorld, service: null as unknown }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.service ?? h.world!.db.supabase }));

const w = () => h.world!;
const URL_ = "https://hcsacmqzspnfqoftoifu.supabase.co";

beforeEach(() => {
  process.env["AIDWAR_SUPABASE_URL"] = URL_;
  h.world = mcpWorld();
  h.service = null;
  resetDbProofStateForTests();
  vi.stubGlobal("fetch", async () => new Response("no network in tests", { status: 599 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(user: string, name: string, args: Record<string, unknown> = {}) {
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
    w().deps,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: body.result.isError === true, text: body.result.content[0]!.text };
}

describe("the proof", () => {
  it("is HKDF(service-role key, 'aidwar-mcp-db-proof') -> HMAC, the same as an independent node:crypto build", async () => {
    const proof = await mcpDbProof(SECRET);
    expect(MCP_DB_PROOF_LABEL).toBe("aidwar-mcp-db-proof");
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof).toBe(nodeDbProof(SECRET));
    expect(await mcpDbProof(SECRET)).toBe(proof);
    expect(await mcpDbProof("another key")).not.toBe(proof);
    // Not the service-role key, and not the confirm-code key's output.
    expect(proof).not.toContain(SECRET);
    expect(await mcpDbProofHash(proof)).toBe(sha256Hex(proof));
    expect(await mcpDbProofHash(proof)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is derived from AIDWAR_SUPABASE_SERVICE_ROLE_KEY by default and refuses to run without it", async () => {
    const before = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];
    process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "env-service-key";
    expect(await mcpDbProof()).toBe(nodeDbProof("env-service-key"));
    delete process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];
    expect(() => mcpDbProof()).toThrow(/service configuration/);
    if (before !== undefined) process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = before;
  });
});

describe("mcpUserClient: every Supabase request with the caller's token carries the proof", () => {
  it("tables (GET and HEAD count), rpc and Storage, to the project only", async () => {
    const seen: Array<{ url: string; method: string; auth: string | null; proof: string | null }> = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), proof: req.headers.get(MCP_DB_PROOF_HEADER) });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const proof = await mcpDbProof(SECRET);
    const client = mcpUserClient("tok.en.sig", { url: URL_, anonKey: "anon", proof, createClient: createClient as never, fetch: fake });
    await client.from("contacts").select("id").eq("organization_id", ORG);
    await client.from("contacts").select("id", { count: "exact", head: true });
    await client.rpc("some_read", {}, { get: true });
    await client.storage.from("chat-media").list(ORG);
    expect(seen.map((s) => s.method)).toEqual(["GET", "HEAD", "GET", "POST"]);
    for (const s of seen) {
      expect(s.url.startsWith(`${URL_}/`), s.url).toBe(true);
      expect(s.auth).toBe("Bearer tok.en.sig");
      expect(s.proof).toBe(proof);
    }
  });

  it("logs once, loudly, when the database refuses the proof — and the caller only sees the usual answer", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = proofWatchingFetch((async () =>
      Response.json({ code: "42501", message: "AI apps connected to AiDwar work only through…", hint: "aidwar_mcp_proof_required" }, { status: 403 })) as typeof fetch);
    const res = await refused("https://x.supabase.co/rest/v1/contacts");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { hint: string }).hint).toBe("aidwar_mcp_proof_required");
    await refused("https://x.supabase.co/rest/v1/contacts");
    expect(err.mock.calls.filter((c) => String(c[0]).includes("mcp_db_proof_rejected"))).toHaveLength(1);
    // Another 403 (an RLS refusal) isn't the proof's.
    resetDbProofStateForTests();
    const other = proofWatchingFetch((async () => Response.json({ code: "42501", message: "permission denied" }, { status: 403 })) as typeof fetch);
    await other("https://x.supabase.co/rest/v1/contacts");
    expect(err.mock.calls.filter((c) => String(c[0]).includes("mcp_db_proof_rejected"))).toHaveLength(1);
  });
});

describe("ensureDbProof: the bootstrap and self-check, once per isolate", () => {
  const serviceAnswering = (answers: Array<{ data: unknown; error: unknown }>) => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      client: { rpc: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), answers.shift() ?? { data: "match", error: null }) },
    };
  };

  it("stores the hash (never the proof) through the service role, then stays quiet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = serviceAnswering([{ data: "set", error: null }]);
    expect(await ensureDbProof(s.client as never, nodeDbProof(SECRET))).toBe("set");
    expect(await ensureDbProof(s.client as never, nodeDbProof(SECRET))).toBe("set");
    expect(s.calls).toEqual([{ name: "mcp_set_db_proof_hash", args: { p_hash: sha256Hex(nodeDbProof(SECRET)) } }]);
    expect(JSON.stringify(s.calls)).not.toContain(nodeDbProof(SECRET));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("mcp_db_proof_stored"))).toBe(true);
  });

  it("'match' is silent; 'replaced' (the key rotated) is an error in the logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await ensureDbProof(serviceAnswering([{ data: "match", error: null }]).client as never, "p")).toBe("match");
    expect(err).not.toHaveBeenCalled();
    resetDbProofStateForTests();
    expect(await ensureDbProof(serviceAnswering([{ data: "replaced", error: null }]).client as never, "p")).toBe("replaced");
    expect(err.mock.calls.some((c) => String(c[0]).includes('"state":"replaced"'))).toBe(true);
  });

  it("a failure is logged and tried again next time; PGRST202 (20261300 not applied) just carries on", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = serviceAnswering([{ data: null, error: { code: "57014", message: "timeout" } }, { data: "match", error: null }]);
    expect(await ensureDbProof(s.client as never, "p")).toBe("failed");
    expect(err.mock.calls.some((c) => String(c[0]).includes("mcp_db_proof_failed"))).toBe(true);
    expect(await ensureDbProof(s.client as never, "p")).toBe("match");
    expect(s.calls).toHaveLength(2);
    resetDbProofStateForTests();
    const missing = serviceAnswering([{ data: null, error: { code: "PGRST202", message: "Could not find the function" } }]);
    expect(await ensureDbProof(missing.client as never, "p")).toBe("not_applied");
    expect(await ensureDbProof(missing.client as never, "p")).toBe("not_applied");
    expect(missing.calls).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("mcp_db_proof_not_applied"))).toBe(true);
  });

  it("liveMcpDeps runs it before the first read and builds the user client with the proof (PGRST202: still works)", async () => {
    process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = SECRET;
    process.env["AIDWAR_SUPABASE_ANON_KEY"] = "anon-key";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: string[] = [];
    h.service = { rpc: async (name: string) => (calls.push(name), { data: null, error: { code: "PGRST202", message: "missing" } }) };
    const seen: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).headers.get(MCP_DB_PROOF_HEADER));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    const { liveMcpDeps } = await import("./mcp-server.server");
    const deps = await liveMcpDeps();
    expect(calls).toEqual(["mcp_set_db_proof_hash"]);
    await deps.userClient("a.b.c").from("organization_members").select("organization_id");
    expect(seen).toEqual([nodeDbProof(SECRET)]);
    await liveMcpDeps();
    expect(calls).toHaveLength(1); // once per isolate
  });
});

/** One call of every tool, the way an assistant would start with it. */
const EVERY_TOOL: Array<[string, Record<string, unknown>]> = [
  ["list_workspaces", {}],
  ["get_workspace_overview", { workspace_id: ORG }],
  ["list_templates", { workspace_id: ORG }],
  ["list_segments", { workspace_id: ORG }],
  ["count_audience", { workspace_id: ORG, segment_id: "seg-vip" }],
  ["search_contacts", { workspace_id: ORG }],
  ["list_campaigns", { workspace_id: ORG }],
  ["get_campaign_report", { workspace_id: ORG, campaign_id: "camp-done" }],
  ["list_flows", { workspace_id: ORG }],
  ["get_flow", { workspace_id: ORG, flow_id: "flow-none" }],
  ["list_needs_attention", { workspace_id: ORG }],
  ["create_segment", { workspace_id: ORG, name: "Proof VIPs", match: "all", rules: [{ field: "tag", operator: "has", value: "VIP" }] }],
  ["create_campaign_draft", { workspace_id: ORG, name: "Proof", template_name: "festive_offer", variables: { "1": { source: "name" }, "2": "20% off" }, segment_id: "seg-vip" }],
  ["send_campaign", { workspace_id: ORG, campaign_id: "camp-none", confirm_code: "x" }],
  ["create_flow_draft", { workspace_id: ORG, name: "Proof flow", starter: "welcome_message" }],
  ["activate_flow", { workspace_id: ORG, flow_id: "flow-none", confirm_code: "x" }],
  ["list_products", { workspace_id: ORG }],
  ["get_campaign_sales", { workspace_id: ORG, campaign_id: "camp-done" }],
  ["create_template_draft", { workspace_id: ORG, name: "proof_sale", category: "MARKETING", language: "en", body: "Hi {{1}}, our sale is on." }],
  ["submit_template", { workspace_id: ORG, name: "proof_sale", category: "MARKETING", language: "en", body: "Hi {{1}}, our sale is on." }],
  ["preview_campaign_change", { workspace_id: ORG, campaign_id: "camp-done", action: "cancel" }],
  ["update_scheduled_campaign", { workspace_id: ORG, campaign_id: "camp-done", confirm_code: "x" }],
  ["cancel_scheduled_campaign", { workspace_id: ORG, campaign_id: "camp-done", confirm_code: "x" }],
  ["tag_contacts", { workspace_id: ORG, tag: "VIP", segment_id: "seg-vip" }],
  ["list_aiden_questions", { workspace_id: ORG }],
  ["answer_aiden_question", { workspace_id: ORG, question_id: "q-none", answer: "Yes" }],
];

describe("all 26 MCP tools through a database that answers only with the proof", () => {
  it("covers every tool the server has", async () => {
    const { ALL_MCP_TOOLS } = await import("./mcp-server.server");
    expect(ALL_MCP_TOOLS).toHaveLength(26);
    expect(EVERY_TOOL.map(([n]) => n).sort()).toEqual(ALL_MCP_TOOLS.map((t) => t.name).sort());
  });

  it("with the right proof every tool answers as it did before Batch 56, and every read client carried it", async () => {
    const answers = new Map<string, { isError: boolean; text: string }>();
    for (const [name, args] of EVERY_TOOL) answers.set(name, await call("u-owner", name, args));
    for (const [name, a] of answers) expect(a.text, name).not.toMatch(/Something went wrong|isn't a member of any workspace/);
    for (const name of ["list_workspaces", "get_workspace_overview", "list_templates", "list_segments", "count_audience", "search_contacts", "list_campaigns", "get_campaign_report", "list_flows", "list_needs_attention", "create_segment", "create_campaign_draft", "create_flow_draft", "list_products", "list_aiden_questions"])
      expect(answers.get(name)!.isError, `${name}: ${answers.get(name)!.text.slice(0, 200)}`).toBe(false);
    expect(answers.get("list_workspaces")!.text).toContain(ORG);
    expect(answers.get("list_campaigns")!.text).toContain("Navratri");
    const made = w().proofDb.userClients;
    expect(made.length).toBeGreaterThanOrEqual(EVERY_TOOL.length);
    for (const c of made) expect(c.proof).toBe(nodeDbProof(SECRET));
  });

  it("with a wrong proof, or none stored yet (fail closed), no tool reads a thing", async () => {
    for (const stored of [sha256Hex("an old or wrong proof"), null]) {
      h.world = mcpWorld();
      w().proofDb.dbProofHash = stored;
      for (const [name, args] of EVERY_TOOL) {
        const a = await call("u-owner", name, args);
        expect(a.text, name).not.toContain("Navratri");
        expect(a.text, name).not.toContain("+91");
        if (name !== "list_workspaces") expect(a.isError, `${name}: ${a.text.slice(0, 160)}`).toBe(true);
      }
      expect(w().rows("segments").some((s) => s["name"] === "Proof VIPs")).toBe(false);
      expect(w().rows("campaigns").some((c) => c["name"] === "Proof")).toBe(false);
    }
  });
});
