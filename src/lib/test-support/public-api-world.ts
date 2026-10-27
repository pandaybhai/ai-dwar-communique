/**
 * Test-only world for the Batch 34 Public API: one workspace (Zoori-like,
 * but nothing here is about any kind of shop) with a member, an API key, a
 * connected number and templates, on the in-memory database; a second
 * workspace to prove nothing crosses over. Meta, the merchant's file host,
 * DNS and the merchant's webhook are a fake fetch. Never used by the app.
 */
import { memoryDb, type MemoryDb, type Row } from "./memory-db";
import { fakeStorage, withStorage } from "./fake-storage";
import { generateApiKey } from "../public-api.server";

export const ORG = "org-a";
export const OTHER_ORG = "org-b";
export const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

export const INVOICE_TEMPLATE_COMPONENTS = [
  { type: "HEADER", format: "DOCUMENT", example: { header_handle: ["h"] } },
  {
    type: "BODY",
    text: "Hi {{1}}, your invoice {{2}} for {{3}} is attached. Thank you.",
    example: { body_text: [["A", "B", "C"]] },
  },
];

export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};
export type FetchRoute = (call: FetchCall) => Response | Promise<Response> | undefined;

export function publicApiWorld(
  options: { flagOn?: boolean; balance?: number; rate?: number; billing?: boolean } = {},
) {
  const keyA = generateApiKey();
  const keyRevoked = generateApiKey();
  const keyB = generateApiKey();
  const flags = { on: options.flagOn ?? true, billing: options.billing ?? true };
  const rate = { windows: new Map<string, number>(), limits: true };
  const vault = new Map<string, string>();
  const seed: Record<string, Row[]> = {
    organizations: [
      { id: ORG, name: "Shop A", plan_status: "active" },
      { id: OTHER_ORG, name: "Shop B", plan_status: "active" },
    ],
    organization_members: [
      {
        organization_id: ORG,
        user_id: "u-admin",
        role: "admin",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        organization_id: ORG,
        user_id: "u-agent",
        role: "agent",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    profiles: [
      { id: "u-admin", is_super_admin: false },
      { id: "u-agent", is_super_admin: false },
    ],
    permissions: [{ key: "public_api.manage" }, { key: "inbox.view" }],
    role_permissions: [
      { role: "admin", permission_key: "public_api.manage" },
      { role: "admin", permission_key: "inbox.view" },
      { role: "agent", permission_key: "inbox.view" },
    ],
    api_keys: [
      {
        id: "key-a",
        organization_id: ORG,
        name: "Billing",
        prefix: keyA.prefix,
        key_hash: keyA.hash,
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: null,
        revoked_at: null,
      },
      {
        id: "key-r",
        organization_id: ORG,
        name: "Old",
        prefix: keyRevoked.prefix,
        key_hash: keyRevoked.hash,
        created_at: "2026-09-01T00:00:00Z",
        last_used_at: null,
        revoked_at: "2026-10-02T00:00:00Z",
      },
      {
        id: "key-b",
        organization_id: OTHER_ORG,
        name: "B",
        prefix: keyB.prefix,
        key_hash: keyB.hash,
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: null,
        revoked_at: null,
      },
    ],
    whatsapp_accounts: [
      {
        id: "acc-a",
        organization_id: ORG,
        waba_id: "waba-a",
        phone_number_id: "pn-a",
        display_phone_number: "+91 90000 00000",
        status: "active",
        is_default: true,
        connected_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "acc-b",
        organization_id: OTHER_ORG,
        waba_id: "waba-b",
        phone_number_id: "pn-b",
        display_phone_number: null,
        status: "active",
        is_default: true,
        connected_at: "2026-01-01T00:00:00Z",
      },
    ],
    whatsapp_credentials: [
      { organization_id: ORG, waba_id: "waba-a", access_token: "meta-token-a" },
      { organization_id: OTHER_ORG, waba_id: "waba-b", access_token: "meta-token-b" },
    ],
    message_templates: [
      {
        id: "t1",
        organization_id: ORG,
        waba_id: "waba-a",
        name: "invoice_ready",
        language: "en",
        category: "UTILITY",
        status: "APPROVED",
        components: INVOICE_TEMPLATE_COMPONENTS,
      },
      {
        id: "t2",
        organization_id: ORG,
        waba_id: "waba-a",
        name: "plain_hello",
        language: "en",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hello {{1}}" }],
      },
      {
        id: "t3",
        organization_id: ORG,
        waba_id: "waba-a",
        name: "invoice_pending",
        language: "en",
        category: "UTILITY",
        status: "PENDING",
        components: INVOICE_TEMPLATE_COMPONENTS,
      },
      {
        id: "t4",
        organization_id: OTHER_ORG,
        waba_id: "waba-b",
        name: "b_invoice",
        language: "en",
        category: "UTILITY",
        status: "APPROVED",
        components: INVOICE_TEMPLATE_COMPONENTS,
      },
    ],
    contacts: [
      {
        id: "c-out",
        organization_id: ORG,
        phone: "+919800000009",
        wa_id: "919800000009",
        opt_in_status: "opted_out",
      },
    ],
    wallet_balances: [
      { organization_id: ORG, balance: options.balance ?? 100, held: 0, currency: "INR" },
    ],
    organization_billing_settings: [{ organization_id: ORG, overdraft_limit: 0 }],
  };
  const db: MemoryDb = memoryDb(seed, {
    org_flag_enabled: (args) => ({
      data:
        args["p_flag"] === "public_api"
          ? flags.on
          : args["p_flag"] === "billing"
            ? flags.billing
            : false,
      error: null,
    }),
    client_rate_for: () => ({
      data: [{ rate: options.rate ?? 0.15, currency: "INR" }],
      error: null,
    }),
    api_rate_take: (args) => {
      const bucket = String(args["p_bucket"]);
      const n = (rate.windows.get(bucket) ?? 0) + 1;
      rate.windows.set(bucket, n);
      const allowed = !rate.limits || n <= Number(args["p_limit"]);
      return { data: [{ allowed, retry_after: allowed ? 0 : 42 }], error: null };
    },
    // Vault, as the workspace_connection_* functions use it.
    workspace_connection_set_secret: (args, mem) => {
      vault.set(`workspace_conn_${String(args["p_id"])}`, String(args["p_secret"]));
      const row = mem.rows("workspace_connections").find((r) => r["id"] === args["p_id"]);
      if (row) row["secret_vault_name"] = `workspace_conn_${String(args["p_id"])}`;
      return { data: null, error: null };
    },
    workspace_connection_secret: (args, mem) => {
      const row = mem
        .rows("workspace_connections")
        .find(
          (r) => r["organization_id"] === args["p_org"] && r["provider"] === args["p_provider"],
        );
      return {
        data: row
          ? [
              {
                id: row["id"],
                status: row["status"] ?? "active",
                public_config: row["public_config"] ?? {},
                secret: vault.get(String(row["secret_vault_name"])) ?? null,
              },
            ]
          : [],
        error: null,
      };
    },
    workspace_connection_delete: (args, mem) => {
      vault.delete(`workspace_conn_${String(args["p_id"])}`);
      const rows = mem.rows("workspace_connections");
      const i = rows.findIndex((r) => r["id"] === args["p_id"]);
      if (i >= 0) rows.splice(i, 1);
      return { data: null, error: null };
    },
    // api_webhook_claim: due, unleased, pending rows, leased for 2 minutes.
    api_webhook_claim: (args, mem) => {
      const now = Date.now();
      const due = mem
        .rows("api_webhook_deliveries")
        .filter(
          (r) =>
            r["state"] === "pending" &&
            Date.parse(String(r["next_attempt_at"])) <= now &&
            (!r["lease_until"] || Date.parse(String(r["lease_until"])) < now),
        )
        .slice(0, Number(args["p_limit"] ?? 25));
      for (const r of due) r["lease_until"] = new Date(now + 120_000).toISOString();
      return { data: due.map((r) => ({ attempts: 0, ...r })), error: null };
    },
  });
  // Bearer tokens for the signed-in settings routes are user ids here.
  (db.supabase as unknown as { auth: unknown }).auth = {
    getUser: async (token: string) =>
      token.startsWith("u-")
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "bad jwt" } },
  };
  const storage = fakeStorage();
  withStorage(db.supabase, storage);
  return {
    db,
    storage,
    flags,
    rate,
    vault,
    keys: { a: keyA.key, revoked: keyRevoked.key, b: keyB.key },
  };
}

/**
 * A fetch stand-in: routes are tried in order, the first answer wins. DNS
 * over HTTPS answers public addresses unless `dns` says otherwise. Every call
 * is recorded (body as text, FormData or bytes).
 */
export function fakeFetch(routes: FetchRoute[], dns: Record<string, string[]> = {}) {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = {
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      body: init.body ?? null,
    };
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const u = new URL(url);
      const name = u.searchParams.get("name") ?? "";
      const type = u.searchParams.get("type");
      const addrs = dns[name] ?? ["93.184.216.34"];
      const answer =
        type === "A"
          ? addrs.filter((a) => !a.includes(":")).map((data) => ({ type: 1, data }))
          : addrs.filter((a) => a.includes(":")).map((data) => ({ type: 28, data }));
      return Response.json({ Status: 0, Answer: answer });
    }
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res) return res;
    }
    return new Response("no route", { status: 599 });
  };
  return { impl, calls };
}

/** Meta's answers: media upload gives an id, a send gives a wamid. */
export function metaRoutes(
  state: { sendError?: Record<string, unknown> | null; uploadError?: boolean } = {},
): FetchRoute {
  let n = 0;
  return (call) => {
    if (!call.url.startsWith("https://graph.facebook.com/")) return undefined;
    if (call.url.endsWith("/media") && call.method === "POST") {
      return state.uploadError
        ? Response.json({ error: { message: "bad file", code: 100 } }, { status: 400 })
        : Response.json({ id: "meta-media-1" });
    }
    if (call.url.endsWith("/messages") && call.method === "POST") {
      if (state.sendError) return Response.json({ error: state.sendError }, { status: 400 });
      n += 1;
      return Response.json({ messages: [{ id: `wamid.${n}` }] });
    }
    return undefined;
  };
}
