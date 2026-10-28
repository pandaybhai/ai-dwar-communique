/**
 * Test-only: the Batch 34 Public API world (public-api-world.ts) with what
 * Batch 38's endpoints read — opted-in / opted-out / unknown contacts, a tag,
 * a marketing template with two values, team members with emails,
 * conversations — in workspace A, and the same kinds of rows in workspace B
 * to prove nothing crosses over. Never used by the app.
 */
import { ORG, OTHER_ORG, publicApiWorld } from "./public-api-world";

export { ORG, OTHER_ORG };

export const OFFER_COMPONENTS = [
  { type: "BODY", text: "Hi {{1}}, {{2}} off today only.", example: { body_text: [["A", "B"]] } },
];

export function batch38World(options: Parameters<typeof publicApiWorld>[0] = {}) {
  const w = publicApiWorld(options);
  const rows = (t: string) => w.db.rows(t);
  rows("message_templates").push(
    {
      id: "t-offer",
      organization_id: ORG,
      waba_id: "waba-a",
      name: "festive_offer",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      components: OFFER_COMPONENTS,
    },
    {
      id: "t-link",
      organization_id: ORG,
      waba_id: "waba-a",
      name: "shop_link",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      components: [
        { type: "BODY", text: "New arrivals" },
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Shop", url: "https://x.example/{{1}}" }],
        },
      ],
    },
  );
  rows("contacts").push(
    {
      id: "c1",
      organization_id: ORG,
      phone: "+919800000001",
      wa_id: "919800000001",
      name: "Asha",
      opt_in_status: "opted_in",
      attributes: { city: "Pune" },
      created_at: "2026-10-01T00:00:01Z",
    },
    {
      id: "c2",
      organization_id: ORG,
      phone: "+919800000002",
      wa_id: "919800000002",
      name: "Ravi",
      opt_in_status: "opted_in",
      attributes: {},
      created_at: "2026-10-01T00:00:02Z",
    },
    {
      id: "c3",
      organization_id: ORG,
      phone: "+919800000003",
      wa_id: "919800000003",
      name: "Meera",
      opt_in_status: "unknown",
      attributes: {},
      created_at: "2026-10-01T00:00:03Z",
    },
    {
      id: "cb1",
      organization_id: OTHER_ORG,
      phone: "+919800000001",
      wa_id: "919800000001",
      name: "B's Asha",
      opt_in_status: "opted_in",
      attributes: {},
      created_at: "2026-10-01T00:00:01Z",
    },
  );
  rows("tags").push(
    { id: "tag-vip", organization_id: ORG, name: "VIP" },
    { id: "tag-b", organization_id: OTHER_ORG, name: "vip" },
  );
  rows("contact_tags").push(
    { organization_id: ORG, contact_id: "c1", tag_id: "tag-vip" },
    { organization_id: ORG, contact_id: "c3", tag_id: "tag-vip" },
    { organization_id: OTHER_ORG, contact_id: "cb1", tag_id: "tag-b" },
  );
  rows("organization_members").push(
    { organization_id: ORG, user_id: "u-owner", role: "owner", created_at: "2026-01-01T00:00:00Z" },
    {
      organization_id: OTHER_ORG,
      user_id: "u-b",
      role: "owner",
      created_at: "2026-01-01T00:00:00Z",
    },
  );
  rows("profiles").push(
    { id: "u-owner", email: "owner@shop-a.example", is_super_admin: false },
    { id: "u-b", email: "owner@shop-b.example", is_super_admin: false },
  );
  for (const p of rows("profiles")) {
    if (p["id"] === "u-admin") p["email"] = "admin@shop-a.example";
    if (p["id"] === "u-agent") p["email"] = "Agent@Shop-A.example";
  }
  // Batch 38's functions (20261160), written in JS as the SQL reads; `sql.applied`
  // false answers PGRST202, as a database without the file does.
  const sql = { applied: true };
  const rpc = w.db.supabase.rpc.bind(w.db.supabase);
  const changedAt = (r: Record<string, unknown>) =>
    String(r["updated_at"] ?? r["last_message_at"] ?? r["created_at"] ?? "");
  (w.db.supabase as unknown as { rpc: unknown }).rpc = (name: string, args: Record<string, unknown>) => {
    if (name !== "api_list_conversations") return rpc(name as never, args as never);
    if (!sql.applied)
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "not found" } });
    const after = args["p_after_at"] ? [String(args["p_after_at"]), String(args["p_after_id"] ?? "")] : null;
    const out = rows("conversations")
      .filter((r) => r["organization_id"] === args["p_org"])
      .filter((r) => !args["p_status"] || r["status"] === args["p_status"])
      .filter((r) => !args["p_assignee"] || r["assigned_to"] === args["p_assignee"])
      .filter((r) => !args["p_unassigned"] || r["assigned_to"] == null)
      .filter((r) => !args["p_changed_since"] || Date.parse(changedAt(r)) >= Date.parse(String(args["p_changed_since"])))
      .filter((r) => {
        if (!after) return true;
        const t = Date.parse(changedAt(r)) - Date.parse(after[0]!);
        return t > 0 || (t === 0 && String(r["id"]) > after[1]!);
      })
      .sort((x, y) => Date.parse(changedAt(x)) - Date.parse(changedAt(y)) || String(x["id"]).localeCompare(String(y["id"])))
      .slice(0, Math.min(Math.max(Number(args["p_limit"] ?? 25), 1), 101))
      .map((r) => ({ ...r, changed_at: changedAt(r) }));
    return Promise.resolve({ data: out, error: null });
  };
  return { ...w, sql };
}

/** A route's handler, from its file's Route (as the router calls it). */
export function handler<A>(route: unknown, method: string): (a: A) => Promise<Response> {
  return (
    route as { options: { server: { handlers: Record<string, (a: A) => Promise<Response>> } } }
  ).options.server.handlers[method]!;
}

export async function call(
  route: unknown,
  method: string,
  url: string,
  init: {
    key?: string;
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const request = new Request(`https://aidwar.in${url}`, {
    method,
    headers: {
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const res = await handler<{ request: Request; params: Record<string, string> }>(
    route,
    method,
  )({
    request,
    params: init.params ?? {},
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}
