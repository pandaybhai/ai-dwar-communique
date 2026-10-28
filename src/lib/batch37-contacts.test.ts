import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG, OTHER_ORG, publicApiWorld } from "./test-support/public-api-world";
import { forgetApiEventsWanted } from "./public-api-webhooks.server";

/**
 * Batch 37 item 4 — the Contacts API: upsert by phone (one, or up to 1,000
 * with a result per row), list with a cursor and filters, read one, add /
 * remove tags. opted_in records consent with source "api" and only ever moves
 * "unknown" to "opted_in": an opt-out is never flipped, not even one landing
 * mid-call. Always the key's own workspace. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as ContactsRoute } from "../routes/api/v1/contacts/index";
import { Route as BulkRoute } from "../routes/api/v1/contacts/bulk";
import { Route as OneRoute } from "../routes/api/v1/contacts/$phone";
import { Route as TagsRoute } from "../routes/api/v1/contacts/$phone.tags";
import { Route as TagRoute } from "../routes/api/v1/contacts/$phone.tags.$tag";

type Handler = (a: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handlers = (route: unknown) =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers;

async function call(
  route: unknown,
  method: string,
  path: string,
  options: { body?: unknown; params?: Record<string, string>; key?: string } = {},
) {
  const res = await handlers(route)[method]!({
    request: new Request(`https://aidwar.in${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.key ?? h.world!.keys.a}`,
        "content-type": "application/json",
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
    params: options.params ?? {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const contact = (phone: string, org = ORG) =>
  h.world!.db.rows("contacts").find((c) => c["phone"] === phone && c["organization_id"] === org);

beforeEach(() => {
  h.world = publicApiWorld();
  forgetApiEventsWanted();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/v1/contacts", () => {
  it("creates by phone: name, attributes, tags, opted in with consent source api", async () => {
    const res = await call(ContactsRoute, "POST", "/api/v1/contacts", {
      body: {
        phone: "+91 98765 43210",
        name: "Asha",
        attributes: { city: "Pune", orders: 3 },
        tags: ["VIP", "diwali"],
        opted_in: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "created",
      contact: {
        phone: "+919876543210",
        wa_id: "919876543210",
        name: "Asha",
        opt_in_status: "opted_in",
        attributes: { city: "Pune", orders: 3 },
        tags: ["VIP", "diwali"],
        source: "api",
      },
    });
    expect(contact("+919876543210")).toMatchObject({
      opt_in_status: "opted_in",
      opt_in_source: "api",
      source: "api",
    });
    const log = h.world!.db.rows("activity_log").find((a) => a["action"] === "contacts_opted_in")!;
    expect(log["details"]).toMatchObject({ source: "api", api_key_id: "key-a", changed: 1 });
  });

  it("upserts an existing contact: attributes merged (null removes a key), name kept when not given; unknown -> opted_in", async () => {
    h.world!.db.rows("contacts").push({
      id: "c-1",
      organization_id: ORG,
      phone: "+919876543210",
      wa_id: "919876543210",
      name: "Asha",
      attributes: { city: "Pune", plan: "gold" },
      opt_in_status: "unknown",
      source: "import",
    });
    const res = await call(ContactsRoute, "POST", "/api/v1/contacts", {
      body: { phone: "919876543210", attributes: { plan: null, size: "M" }, opted_in: true },
    });
    expect(res.status).toBe(200);
    expect(res.body["contact"]).toMatchObject({
      name: "Asha",
      attributes: { city: "Pune", size: "M" },
      opt_in_status: "opted_in",
      source: "import",
    });
  });

  it("opted_in never flips an opt-out; opted_in false never lowers an opt-in", async () => {
    const out = await call(ContactsRoute, "POST", "/api/v1/contacts", {
      body: { phone: "+919800000009", opted_in: true, name: "Ravi" },
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      opt_out_kept: true,
      contact: { opt_in_status: "opted_out", name: "Ravi" },
    });
    expect(contact("+919800000009")!["opt_in_status"]).toBe("opted_out");

    await call(ContactsRoute, "POST", "/api/v1/contacts", {
      body: { phone: "+919811111111", opted_in: true },
    });
    await call(ContactsRoute, "POST", "/api/v1/contacts", {
      body: { phone: "+919811111111", opted_in: false },
    });
    expect(contact("+919811111111")!["opt_in_status"]).toBe("opted_in");
  });

  it("a bad contact: 400 with the reason", async () => {
    for (const body of [
      { phone: "12" },
      { phone: "+919811111111", attributes: [1] },
      { phone: "+919811111111", opted_in: "yes" },
    ]) {
      const res = await call(ContactsRoute, "POST", "/api/v1/contacts", { body });
      expect([res.status, res.body["code"]]).toEqual([400, "invalid_contact"]);
    }
  });
});

describe("POST /api/v1/contacts/bulk", () => {
  it("1,000 contacts in a few queries, a result per row; never flips an opt-out", async () => {
    const w = h.world!;
    for (let i = 0; i < 50; i += 1)
      w.db.rows("contacts").push({
        id: `out-${i}`,
        organization_id: ORG,
        phone: `+9198000${String(i).padStart(5, "0")}`,
        wa_id: `9198000${String(i).padStart(5, "0")}`,
        opt_in_status: "opted_out",
      });
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      phone: `+9198000${String(i).padStart(5, "0")}`,
      name: `Customer ${i}`,
      tags: ["sale"],
      opted_in: true,
    }));
    const before = w.db.log.length;
    const res = await call(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      body: { contacts: rows },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 950, updated: 50, errors: 0 });
    expect(w.db.log.length - before).toBeLessThan(60); // batched, never a query per row
    const results = res.body["results"] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1000);
    expect(results[0]).toMatchObject({ index: 0, status: "updated", opt_out_kept: true });
    for (let i = 0; i < 50; i += 1)
      expect(contact(`+9198000${String(i).padStart(5, "0")}`)!["opt_in_status"]).toBe("opted_out");
    expect(w.db.rows("contacts").filter((c) => c["opt_in_status"] === "opted_in")).toHaveLength(
      950,
    );
  });

  it("an opt-out landing between our read and our write still wins", async () => {
    const w = h.world!;
    w.db.rows("contacts").push({
      id: "c-race",
      organization_id: ORG,
      phone: "+919822222222",
      opt_in_status: "unknown",
    });
    // The customer's STOP is stored just before our conditional update runs.
    const from = w.db.supabase.from.bind(w.db.supabase);
    (w.db.supabase as unknown as { from: unknown }).from = (table: string) => {
      const builder = from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (table !== "contacts") return builder;
      const update = builder["update"]!;
      builder["update"] = (...a: unknown[]) => {
        contact("+919822222222")!["opt_in_status"] = "opted_out";
        return update(...a);
      };
      return builder;
    };
    const res = await call(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      body: { contacts: [{ phone: "+919822222222", opted_in: true }] },
    });
    expect(res.status).toBe(200);
    expect(contact("+919822222222")!["opt_in_status"]).toBe("opted_out");
  });

  it("over 1,000: 400; bad and repeated rows answer on their own", async () => {
    const tooMany = await call(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      body: {
        contacts: Array.from({ length: 1001 }, (_, i) => ({
          phone: `+91981${String(i).padStart(7, "0")}`,
        })),
      },
    });
    expect([tooMany.status, tooMany.body["code"]]).toEqual([400, "too_many_contacts"]);
    const mixed = await call(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      body: { contacts: [{ phone: "+919833333333" }, { phone: "bad" }, { phone: "919833333333" }] },
    });
    expect(mixed.body).toMatchObject({ created: 1, errors: 2 });
    expect(
      (mixed.body["results"] as Array<Record<string, unknown>>).map((r) => r["status"]),
    ).toEqual(["created", "error", "error"]);
  });

  it("contact.opted_in reaches the webhook when one is set", async () => {
    const w = h.world!;
    w.db
      .rows("workspace_connections")
      .push({ id: "wc-1", organization_id: ORG, provider: "api_webhook", status: "active" });
    await call(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      body: {
        contacts: [
          { phone: "+919844444444", opted_in: true },
          { phone: "+919800000009", opted_in: true },
        ],
      },
    });
    const events = w.db.rows("api_webhook_deliveries");
    expect(events.map((e) => e["event"])).toEqual(["contact.opted_in"]);
    expect(events[0]!["payload"]).toMatchObject({
      contact: { phone: "+919844444444", opt_in_status: "opted_in" },
    });
  });
});

describe("GET /api/v1/contacts and /api/v1/contacts/{phone}", () => {
  async function seed() {
    const res = await call(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      body: {
        contacts: [
          { phone: "+919800000101", tags: ["vip"], opted_in: true },
          { phone: "+919800000102" },
          { phone: "+919800000103", tags: ["VIP"] },
          { phone: "+919800000104", opted_in: true },
          { phone: "+919800000105" },
        ],
      },
    });
    expect(res.status).toBe(200);
    // Distinct change times, oldest first.
    h.world!.db.rows("contacts").forEach((c, i) => {
      c["updated_at"] = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    });
  }

  it("pages with a cursor, oldest change first; never another workspace's", async () => {
    await seed();
    h.world!.db.rows("contacts").push({
      id: "c-b",
      organization_id: OTHER_ORG,
      phone: "+919800000199",
      updated_at: "2026-10-01T00:00:00.500Z",
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await call(
        ContactsRoute,
        "GET",
        `/api/v1/contacts?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(res.status).toBe(200);
      seen.push(...(res.body["data"] as Array<{ phone: string }>).map((c) => c.phone));
      cursor = res.body["next_cursor"] as string | null;
      if (!cursor) break;
    }
    expect(seen).toEqual([
      "+919800000009",
      "+919800000101",
      "+919800000102",
      "+919800000103",
      "+919800000104",
      "+919800000105",
    ]);
  });

  it("filters: tag (any case), opt-in status, updated_since; a made-up cursor is 400", async () => {
    await seed();
    const phones = async (q: string) =>
      (
        (await call(ContactsRoute, "GET", `/api/v1/contacts?${q}`)).body["data"] as Array<{
          phone: string;
        }>
      ).map((c) => c.phone);
    expect(await phones("tag=vip")).toEqual(["+919800000101", "+919800000103"]);
    expect(await phones("opt_in=opted_in")).toEqual(["+919800000101", "+919800000104"]);
    expect(await phones(`updated_since=${encodeURIComponent("2026-10-01T00:00:04Z")}`)).toEqual([
      "+919800000104",
      "+919800000105",
    ]);
    expect((await call(ContactsRoute, "GET", "/api/v1/contacts?cursor=nope")).body["code"]).toBe(
      "invalid_cursor",
    );
    expect((await call(ContactsRoute, "GET", "/api/v1/contacts?limit=500")).body["code"]).toBe(
      "invalid_limit",
    );
  });

  it("before 20261150 is applied: the list answers 503 (nothing else needs it)", async () => {
    h.world!.flags.listMissing = true;
    const res = await call(ContactsRoute, "GET", "/api/v1/contacts");
    expect([res.status, res.body["code"]]).toEqual([503, "unavailable"]);
  });

  it("one contact by phone, with its tags; another workspace's contact is a 404", async () => {
    await seed();
    const one = await call(OneRoute, "GET", "/api/v1/contacts/%2B919800000101", {
      params: { phone: "+919800000101" },
    });
    expect(one.body["contact"]).toMatchObject({
      phone: "+919800000101",
      tags: ["vip"],
      opt_in_status: "opted_in",
    });
    const other = await call(OneRoute, "GET", "/api/v1/contacts/919800000101", {
      params: { phone: "919800000101" },
      key: h.world!.keys.b,
    });
    expect([other.status, other.body["code"]]).toEqual([404, "not_found"]);
  });
});

describe("tags", () => {
  it("add (new tags made in the workspace), remove one; another workspace's contact is a 404", async () => {
    await call(ContactsRoute, "POST", "/api/v1/contacts", { body: { phone: "+919855555555" } });
    const added = await call(TagsRoute, "POST", "/api/v1/contacts/919855555555/tags", {
      params: { phone: "919855555555" },
      body: { tags: ["vip", "returning"] },
    });
    expect(added.body["contact"]).toMatchObject({ tags: ["returning", "vip"] });
    const removed = await call(TagRoute, "DELETE", "/api/v1/contacts/919855555555/tags/VIP", {
      params: { phone: "919855555555", tag: "VIP" },
    });
    expect(removed.body["contact"]).toMatchObject({ tags: ["returning"] });
    expect(
      h
        .world!.db.rows("tags")
        .map((t) => t["name"])
        .sort(),
    ).toEqual(["returning", "vip"]);
    const other = await call(TagsRoute, "POST", "/api/v1/contacts/919855555555/tags", {
      params: { phone: "919855555555" },
      body: { tags: ["x"] },
      key: h.world!.keys.b,
    });
    expect(other.status).toBe(404);
  });
});
