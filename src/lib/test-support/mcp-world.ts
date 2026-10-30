/**
 * Test-only: the Batch 38 world (two workspaces, templates, opted-in /
 * opted-out / unknown contacts, a VIP tag, a wallet, the rate limiter) with
 * what AiDwar MCP reads and writes on top: roles and permissions, a segment,
 * campaigns, chat flows and their versions (flow_publish_version as the SQL
 * does it), conversations that need a person, feature flags — and a fake
 * Supabase Auth: tokens are JWT-shaped strings whose payload is the claims.
 * Nothing reaches the live database, WhatsApp or Meta. Never used by the app.
 */
import { batch38World, ORG, OTHER_ORG } from "./batch38-world";
import type { McpDeps } from "../mcp-server.server";
import type { McpTokenClaims } from "../mcp-auth.server";

export { ORG, OTHER_ORG };

export const ISSUER = "https://hcsacmqzspnfqoftoifu.supabase.co/auth/v1";
export const ORIGIN = "https://aidwar.in";
export const CLIENT_ID = "9a8b7c6d-0000-4000-8000-000000000052";
export const SECRET = "test-service-role-key-for-hkdf";
/** Tag ids are uuids (segments only read uuid tag rules). */
export const TAG_VIP = "00000000-0000-4000-8000-0000000052a1";
export const TAG_B = "00000000-0000-4000-8000-0000000052b1";

const ALL_KEYS = [
  "inbox.view",
  "contacts.view",
  "contacts.export",
  "segments.manage",
  "campaigns.view",
  "campaigns.create",
  "campaigns.send",
  "billing.view",
  "flows.view",
  "flows_v2.edit",
  "mcp.use",
  "public_api.manage",
];
const ROLE_KEYS: Record<string, string[]> = {
  admin: ALL_KEYS.filter((k) => k !== "billing.view"),
  marketer: ["inbox.view", "contacts.view", "segments.manage", "campaigns.view", "campaigns.create", "campaigns.send", "flows.view", "mcp.use"],
  agent: ["inbox.view", "contacts.view", "mcp.use"],
};

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A JWT-shaped token: the fake getClaims reads its payload; "bad" signature = invalid. */
export function token(claims: Partial<McpTokenClaims> & { sub: string }, signature = "sig"): string {
  return `${b64({ alg: "ES256" })}.${b64({
    iss: ISSUER,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    client_id: CLIENT_ID,
    ...claims,
  })}.${signature}`;
}

export function mcpWorld() {
  const w = batch38World();
  const rows = (t: string) => w.db.rows(t);
  const tagIds: Record<string, string> = { "tag-vip": TAG_VIP, "tag-b": TAG_B };
  for (const t of rows("tags")) t["id"] = tagIds[String(t["id"])] ?? t["id"];
  for (const l of rows("contact_tags")) l["tag_id"] = tagIds[String(l["tag_id"])] ?? l["tag_id"];
  rows("organization_members").push({ organization_id: ORG, user_id: "u-marketer", role: "marketer", created_at: "2026-01-02T00:00:00Z" });
  // u-owner is also a member of B (two workspaces); u-b only of B.
  rows("organization_members").push({ organization_id: OTHER_ORG, user_id: "u-owner", role: "agent", created_at: "2026-02-01T00:00:00Z" });
  rows("profiles").push({ id: "u-marketer", is_super_admin: false }, { id: "u-super", is_super_admin: true });
  rows("permissions").splice(0, rows("permissions").length, ...ALL_KEYS.map((key) => ({ key })));
  rows("role_permissions").splice(
    0,
    rows("role_permissions").length,
    ...Object.entries(ROLE_KEYS).flatMap(([role, keys]) => keys.map((permission_key) => ({ role, permission_key }))),
  );
  rows("feature_flags").push(
    { key: "flows_v2", default_enabled: true },
    { key: "mcp_access", default_enabled: true },
  );
  rows("ai_agents").push({ organization_id: ORG, is_default: true, mode: "replying" });
  rows("segments").push(
    {
      id: "seg-vip",
      organization_id: ORG,
      name: "VIP",
      description: "Tagged VIP",
      filters: { match: "all", conditions: [{ field: "tag", operator: "has", value: TAG_VIP }] },
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "seg-b",
      organization_id: OTHER_ORG,
      name: "B's VIP",
      filters: { match: "all", conditions: [{ field: "tag", operator: "has", value: TAG_B }] },
      created_at: "2026-10-01T00:00:00Z",
    },
  );
  rows("campaigns").push(
    {
      id: "camp-done",
      organization_id: ORG,
      name: "Navratri",
      status: "completed",
      template_name: "festive_offer",
      total_recipients: 100,
      sent_count: 100,
      delivered_count: 90,
      read_count: 60,
      replied_count: 9,
      failed_count: 10,
      charged_amount: 15,
      created_at: "2026-10-10T00:00:00Z",
    },
    { id: "camp-b", organization_id: OTHER_ORG, name: "B campaign", status: "completed", total_recipients: 5, created_at: "2026-10-10T00:00:00Z" },
  );
  rows("conversations").push(
    {
      id: "conv-1",
      organization_id: ORG,
      contact_id: "c1",
      status: "open",
      needs_human: true,
      needs_human_reason: "price_question",
      needs_human_at: "2026-10-29T10:00:00Z",
    },
    { id: "conv-2", organization_id: ORG, contact_id: "c2", status: "open", needs_human: false },
    { id: "conv-b", organization_id: OTHER_ORG, contact_id: "cb1", status: "open", needs_human: true, needs_human_at: "2026-10-29T10:00:00Z" },
  );
  rows("messages").push(
    { organization_id: ORG, conversation_id: "conv-1", direction: "inbound", body: "Hi, how much is the gold set?", type: "text", created_at: "2026-10-29T09:59:00Z" },
    { organization_id: ORG, conversation_id: "conv-1", direction: "outbound", body: "SECRET staff reply", type: "text", created_at: "2026-10-29T09:59:30Z" },
    { organization_id: ORG, conversation_id: "conv-1", direction: "inbound", body: "Earlier private message", type: "text", created_at: "2026-10-29T09:00:00Z" },
  );
  rows("flows").push({ id: "flow-b", organization_id: OTHER_ORG, key: "v2:b", name: "B flow", is_enabled: false, config: { v2: true } });
  rows("flow_versions").push({ id: "fv-b", organization_id: OTHER_ORG, flow_id: "flow-b", version: 1, status: "draft", graph: { nodes: [], edges: [] } });

  // flow_publish_version (20261015): one transaction — old published archived,
  // this draft published, the flow on.
  const rpcs = w.db as unknown as { supabase: { rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> } };
  const baseRpc = rpcs.supabase.rpc.bind(rpcs.supabase);
  const publishCalls: Array<Record<string, unknown>> = [];
  (w.db.supabase as unknown as { rpc: unknown }).rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === "flow_publish_version") {
      publishCalls.push(args);
      for (const v of rows("flow_versions"))
        if (v["flow_id"] === args["p_flow_id"] && v["status"] === "published") v["status"] = "archived";
      const v = rows("flow_versions").find((x) => x["id"] === args["p_version_id"]);
      if (!v) return { data: null, error: { message: "no version" } };
      Object.assign(v, { status: "published", graph: args["p_graph"], published_at: new Date().toISOString() });
      const f = rows("flows").find((x) => x["id"] === args["p_flow_id"]);
      if (f) f["is_enabled"] = true;
      return { data: null, error: null };
    }
    return baseRpc(name, args);
  };

  // Supabase Auth, faked: getClaims reads the payload (a "bad" signature fails),
  // getUser answers while the session is alive; admin.oauth.getClient names the app.
  const revoked = new Set<string>();
  const decode = (t: string): McpTokenClaims | null => {
    const parts = t.split(".");
    if (parts.length !== 3 || parts[2] === "bad") return null;
    try {
      return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as McpTokenClaims;
    } catch {
      return null;
    }
  };
  const deps: McpDeps = {
    verifier: {
      issuer: ISSUER,
      getClaims: async (t) => {
        const claims = decode(t);
        return claims ? { claims, error: null } : { claims: null, error: "invalid JWT" };
      },
      sessionAlive: async (t) => !revoked.has(t),
    },
    service: w.db.supabase,
    userClient: () => w.db.supabase,
    clientName: async (id) => (id === CLIENT_ID ? "Claude" : null),
    confirmSecret: SECRET,
  };
  return { ...w, rows, deps, revoked, publishCalls };
}

export type McpWorld = ReturnType<typeof mcpWorld>;
