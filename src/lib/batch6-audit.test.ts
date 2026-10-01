import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { assertPublicUrl, BlockedUrlError, clearSafeFetchDnsCache, guardedFetch, urlBlocked } from "./safe-fetch.server";
import { fetchWithTimeout, mapSite, readPages } from "./web-reader.server";
import { firecrawlMap, firecrawlScrape } from "./firecrawl.server";
import { tavilyExtract, tavilyMap } from "./tavily.server";
import { runHttpRequest } from "./flow-http.server";
import { redactShopCustomer, redactShopData } from "./shopify-compliance.server";
import { processShopifyWebhook } from "./shopify-webhook.server";

// ------------------------------------------------------------------ Task A: SSRF

type Call = { url: string; init?: RequestInit };
/** DNS-over-HTTPS answers from `dns`; any other request answered by `reply`. */
function stubFetch(dns: Record<string, string[]>, reply: (url: string) => Response = () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } })) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).startsWith("https://cloudflare-dns.com/")) {
      const u = new URL(String(url));
      const type = u.searchParams.get("type") === "AAAA" ? 28 : 1;
      const addrs = (dns[u.searchParams.get("name") ?? ""] ?? []).filter((a) => (type === 28) === a.includes(":"));
      return Response.json({ Status: 0, Answer: addrs.map((data) => ({ type, data })) });
    }
    return reply(String(url));
  });
  return calls;
}
const requests = (calls: Call[]) => calls.filter((c) => !c.url.startsWith("https://cloudflare-dns.com/"));
const PUBLIC = { "shop.example.com": ["93.184.216.34"], "cdn.example.net": ["151.101.1.1"] };

beforeEach(() => clearSafeFetchDnsCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const PRIVATE_URLS = [
  "http://127.0.0.1/",
  "http://10.1.2.3/admin",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://localhost:3000/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://metadata/",
  "http://192.168.0.10/",
  "http://172.16.0.1/",
  "http://2130706433/",
  "file:///etc/passwd",
];

describe("website reader: private/internal addresses (same guard as the Flows HTTP step)", () => {
  it("urlBlocked refuses literal private hosts, metadata names and non-http schemes", () => {
    for (const u of PRIVATE_URLS) expect(urlBlocked(u), u).toBe(true);
    expect(urlBlocked("not a url")).toBe(true);
    expect(urlBlocked("https://shop.example.com/products/x")).toBe(false);
  });

  it("fetchWithTimeout never requests a private address", async () => {
    for (const u of PRIVATE_URLS) {
      const calls = stubFetch(PUBLIC);
      expect(await fetchWithTimeout(u, 1000), u).toBeNull();
      expect(requests(calls), u).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("refuses a public-looking name that resolves to a private address", async () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"]) {
      clearSafeFetchDnsCache();
      const calls = stubFetch({ "sneaky.example.com": [ip] });
      expect(await fetchWithTimeout("https://sneaky.example.com/", 1000), ip).toBeNull();
      expect(requests(calls), ip).toEqual([]);
      vi.unstubAllGlobals();
    }
    stubFetch({ "sneaky.example.com": ["10.0.0.5"] });
    await expect(assertPublicUrl("https://sneaky.example.com/")).rejects.toMatchObject({ code: "private_address_blocked" });
  });

  it("re-checks every redirect hop and stops at a private target", async () => {
    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/", "https://inside.example.com/"]) {
      clearSafeFetchDnsCache();
      const calls = stubFetch({ ...PUBLIC, "inside.example.com": ["10.9.9.9"] }, (url) =>
        url.startsWith("https://shop.example.com/") ? new Response(null, { status: 302, headers: { location: target } }) : new Response("secret"),
      );
      expect(await fetchWithTimeout("https://shop.example.com/go", 1000), target).toBeNull();
      expect(requests(calls).map((c) => c.url), target).toEqual(["https://shop.example.com/go"]);
      expect(requests(calls)[0]!.init?.redirect).toBe("manual");
      vi.unstubAllGlobals();
    }
  });

  it("follows a redirect to another public address (relative Location too)", async () => {
    const calls = stubFetch(PUBLIC, (url) => {
      if (url === "https://shop.example.com/a") return new Response(null, { status: 301, headers: { location: "/b" } });
      if (url === "https://shop.example.com/b") return new Response(null, { status: 302, headers: { location: "https://cdn.example.net/c" } });
      return new Response("<html>final</html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const res = await fetchWithTimeout("https://shop.example.com/a", 1000);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("<html>final</html>");
    expect(requests(calls).map((c) => c.url)).toEqual(["https://shop.example.com/a", "https://shop.example.com/b", "https://cdn.example.net/c"]);
  });

  it("gives up after too many redirects without throwing", async () => {
    stubFetch(PUBLIC, () => new Response(null, { status: 302, headers: { location: "https://shop.example.com/loop" } }));
    const res = await guardedFetch("https://shop.example.com/loop");
    expect(res.status).toBe(302);
  });

  it("public URL is still fetched as before, with browser headers", async () => {
    const calls = stubFetch(PUBLIC);
    const res = await fetchWithTimeout("https://shop.example.com/products/x", 1000);
    expect(res?.ok).toBe(true);
    const req = requests(calls);
    expect(req).toHaveLength(1);
    expect(req[0]!.url).toBe("https://shop.example.com/products/x");
    expect((req[0]!.init?.headers as Record<string, string>)["User-Agent"]).toMatch(/Mozilla/);
  });

  it("guardedFetch throws BlockedUrlError for callers that want the reason", async () => {
    stubFetch(PUBLIC);
    await expect(guardedFetch("http://10.0.0.1/")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("readPages returns null for private addresses without asking any engine", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubEnv("TAVILY_API_KEY", "tv-test");
    const calls = stubFetch(PUBLIC);
    const out = await readPages(["http://169.254.169.254/", "http://localhost/"], { order: ["firecrawl", "tavily", "own"] });
    expect(out.get("http://169.254.169.254/")).toBeNull();
    expect(out.get("http://localhost/")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("Firecrawl, Tavily and site mapping refuse private URLs before any call", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubEnv("TAVILY_API_KEY", "tv-test");
    const calls = stubFetch(PUBLIC);
    expect(await firecrawlScrape("http://10.0.0.1/", undefined)).toBeNull();
    expect(await firecrawlMap("http://127.0.0.1/", undefined)).toEqual([]);
    expect(await tavilyMap("http://[::1]/", undefined)).toEqual([]);
    expect((await tavilyExtract(["http://169.254.169.254/"], "basic", undefined)).pages.size).toBe(0);
    expect((await mapSite("http://metadata.google.internal/", "firecrawl", { sitemap: [] })).urls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("Flows HTTP step behaviour is unchanged (still refuses, still never follows redirects)", async () => {
    const ctx = { vars: {}, contact: { name: "A", phone: "9", attributes: {} }, tags: [], now: new Date(), timezone: "UTC" };
    stubFetch({ "sneaky.example.com": ["10.0.0.5"] });
    expect((await runHttpRequest({ url: "https://sneaky.example.com/" }, ctx)).error).toBe("private_address_blocked");
    vi.unstubAllGlobals();
    stubFetch(PUBLIC, () => new Response(null, { status: 302, headers: { location: "https://shop.example.com/x" } }));
    expect((await runHttpRequest({ url: "https://shop.example.com/" }, ctx)).error).toBe("redirect_not_followed");
  });
});

// ------------------------------------------------------------------ Task B: Shopify

const SHOP = "shop-a.myshopify.com";
const OTHER = "shop-b.myshopify.com";

/** A DB where only SHOP has a Shopify integration (int-a in org-a). */
function shopDb(extra: (op: FakeOp, has: (f: string, ...a: unknown[]) => boolean) => { data: unknown; error: null } | undefined = () => undefined) {
  const db = fakeDb((op) => {
    const has = (f: string, ...a: unknown[]) => db.has(op, f, ...a);
    const custom = extra(op, has);
    if (custom) return custom;
    if (op.table === "integrations" && op.kind === "select")
      return { data: has("eq", "shop_domain", SHOP) ? [{ id: "int-a", organization_id: "org-a", shop_domain: SHOP }] : [], error: null };
    return undefined;
  });
  return db;
}
const deletes = (ops: FakeOp[], table: string) => ops.filter((o) => o.table === table && o.kind === "delete");

describe("Shopify app/uninstalled", () => {
  it("destroys the token, stops sync jobs and marks the connection disconnected — for that shop only", async () => {
    const db = shopDb((op, has) =>
      op.table === "integrations" && op.kind === "select" && has("limit", 1)
        ? { data: { id: "int-a", organization_id: "org-a", shop_domain: SHOP }, error: null }
        : undefined,
    );
    await processShopifyWebhook({ supabase: db.supabase, topic: "app/uninstalled", shopDomain: SHOP, payload: {}, eventRowId: "ev-1" });

    const cred = deletes(db.ops, "integration_credentials");
    expect(cred).toHaveLength(1);
    expect(db.has(cred[0]!, "eq", "integration_id", "int-a")).toBe(true);

    const jobs = db.ops.filter((o) => o.table === "integration_sync_jobs" && o.kind === "update");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ status: "failed" });
    expect(db.has(jobs[0]!, "eq", "integration_id", "int-a")).toBe(true);
    expect(db.has(jobs[0]!, "in", "status", ["queued", "running"])).toBe(true);

    const conn = db.ops.find((o) => o.table === "integrations" && o.kind === "update" && (o.payload as Record<string, unknown>)["status"] === "disconnected");
    expect(conn && db.has(conn, "eq", "id", "int-a")).toBe(true);

    // Imported data stays until shop/redact.
    for (const t of ["orders", "products", "abandoned_checkouts", "contacts", "integrations"]) expect(deletes(db.ops, t), t).toEqual([]);
  });
});

describe("Shopify shop/redact", () => {
  it("deletes everything imported from that shop, scoped by its integration and org", async () => {
    const db = shopDb((op, has) => {
      if (op.table === "orders" && op.kind === "select") return { data: [{ id: "o1" }, { id: "o2" }], error: null };
      if (op.table === "contacts" && op.kind === "select")
        return {
          data: [
            { id: "c-shop", source: "shopify", source_detail: { shop_domain: SHOP } },
            { id: "c-chatted", source: "shopify", source_detail: { shop_domain: SHOP } },
          ],
          error: null,
        };
      if (op.table === "conversations" && op.kind === "select") return { data: [{ contact_id: "c-chatted" }], error: null };
      void has;
      return undefined;
    });
    const out = await redactShopData(db.supabase, SHOP, "ev-redact");
    expect(out).toEqual([{ organizationId: "org-a", integrationId: "int-a", ordersDeleted: 2, contactsDeleted: 1 }]);

    for (const t of ["orders", "abandoned_checkouts", "products", "integration_sync_jobs"]) {
      const d = deletes(db.ops, t);
      expect(d, t).toHaveLength(1);
      expect(db.has(d[0]!, "eq", "integration_id", "int-a"), t).toBe(true);
      expect(db.has(d[0]!, "eq", "organization_id", "org-a"), t).toBe(true);
    }
    expect(db.has(deletes(db.ops, "order_items")[0]!, "in", "order_id", ["o1", "o2"])).toBe(true);
    expect(db.has(deletes(db.ops, "integration_credentials")[0]!, "eq", "integration_id", "int-a")).toBe(true);
    const integ = deletes(db.ops, "integrations")[0]!;
    expect(db.has(integ, "eq", "id", "int-a") && db.has(integ, "eq", "organization_id", "org-a")).toBe(true);

    // Contacts: only this shop's imports, only in that org, never one that chatted.
    const contactSel = db.ops.find((o) => o.table === "contacts" && o.kind === "select")!;
    expect(db.has(contactSel, "eq", "source", "shopify")).toBe(true);
    expect(db.has(contactSel, "eq", "source_detail->>shop_domain", SHOP)).toBe(true);
    expect(db.has(contactSel, "eq", "organization_id", "org-a")).toBe(true);
    const cdel = deletes(db.ops, "contacts");
    expect(cdel).toHaveLength(1);
    expect(db.has(cdel[0]!, "in", "id", ["c-shop"])).toBe(true);

    // Raw webhook deliveries for that shop, but not the redact record itself.
    const ev = deletes(db.ops, "webhook_events")[0]!;
    expect(db.has(ev, "eq", "payload->>shop_domain", SHOP)).toBe(true);
    expect(db.has(ev, "neq", "id", "ev-redact")).toBe(true);
  });

  it("touches nothing of another shop", async () => {
    const db = shopDb();
    expect(await redactShopData(db.supabase, OTHER)).toEqual([]);
    const touched = db.ops.filter((o) => o.kind !== "select" && o.table !== "webhook_events");
    expect(touched).toEqual([]);
    expect(db.has(deletes(db.ops, "webhook_events")[0]!, "eq", "payload->>shop_domain", OTHER)).toBe(true);
  });

  it("the general webhook route uses the same redaction", async () => {
    const db = shopDb();
    await processShopifyWebhook({ supabase: db.supabase, topic: "shop/redact", shopDomain: SHOP, payload: {}, eventRowId: "ev-2" });
    expect(db.has(deletes(db.ops, "products")[0]!, "eq", "integration_id", "int-a")).toBe(true);
    expect(db.has(deletes(db.ops, "webhook_events")[0]!, "neq", "id", "ev-2")).toBe(true);
  });
});

describe("Shopify customers/redact", () => {
  const payload = { customer: { id: 777, email: "Asha@Example.com", phone: "+91 98765 43210" } };

  it("deletes that customer's orders/checkouts in that shop and only shop-created contacts", async () => {
    const db = shopDb((op, has) => {
      if (op.table === "contacts" && op.kind === "select")
        return has("eq", "phone", "+919876543210")
          ? {
              data: [
                { id: "c-wa", source: "whatsapp", source_detail: null },
                { id: "c-shop", source: "shopify", source_detail: { shop_domain: SHOP } },
                { id: "c-othershop", source: "shopify", source_detail: { shop_domain: OTHER } },
              ],
              error: null,
            }
          : { data: [], error: null };
      if (op.table === "orders" && op.kind === "select")
        return { data: has("eq", "external_customer_id", "777") ? [{ id: "o1" }] : has("in", "contact_id") ? [{ id: "o2" }] : [], error: null };
      if (op.table === "abandoned_checkouts" && op.kind === "select")
        return { data: has("eq", "raw->customer->>id", "777") ? [{ id: "k1" }] : [], error: null };
      if (op.table === "conversations") return { data: [], error: null };
      return undefined;
    });
    const out = await redactShopCustomer(db.supabase, SHOP, payload, "ev-c");
    expect(out).toEqual([{ organizationId: "org-a", integrationId: "int-a", ordersDeleted: 2, checkoutsDeleted: 1, contactsDeleted: 1 }]);

    // Every order/checkout lookup is inside this shop's integration and org.
    for (const sel of db.ops.filter((o) => (o.table === "orders" || o.table === "abandoned_checkouts") && o.kind === "select")) {
      expect(db.has(sel, "eq", "integration_id", "int-a")).toBe(true);
      expect(db.has(sel, "eq", "organization_id", "org-a")).toBe(true);
    }
    const orderDel = deletes(db.ops, "orders")[0]!;
    expect(db.has(orderDel, "in", "id", ["o1", "o2"]) && db.has(orderDel, "eq", "integration_id", "int-a")).toBe(true);
    expect(db.has(deletes(db.ops, "order_items")[0]!, "in", "order_id", ["o1", "o2"])).toBe(true);
    expect(db.has(deletes(db.ops, "abandoned_checkouts")[0]!, "in", "id", ["k1"])).toBe(true);

    // WhatsApp-sourced and other-shop contacts are kept; no chats deleted.
    const cdel = deletes(db.ops, "contacts");
    expect(cdel).toHaveLength(1);
    expect(db.has(cdel[0]!, "in", "id", ["c-shop"])).toBe(true);
    expect(deletes(db.ops, "conversations")).toEqual([]);
    expect(deletes(db.ops, "messages")).toEqual([]);

    // Raw deliveries about that customer from that shop only.
    const ev = deletes(db.ops, "webhook_events");
    expect(ev).toHaveLength(2);
    for (const e of ev) {
      expect(db.has(e, "eq", "payload->>shop_domain", SHOP)).toBe(true);
      expect(db.has(e, "neq", "id", "ev-c")).toBe(true);
    }
    // Email matched case-insensitively.
    expect(db.ops.some((o) => o.table === "orders" && db.has(o, "ilike", "raw->>email", "asha@example.com"))).toBe(true);
  });

  it("a contact the sync created but who chatted on WhatsApp is kept", async () => {
    const db = shopDb((op) => {
      if (op.table === "contacts" && op.kind === "select") return { data: [{ id: "c-shop", source: "shopify", source_detail: { shop_domain: SHOP } }], error: null };
      if (op.table === "conversations") return { data: [{ contact_id: "c-shop" }], error: null };
      return undefined;
    });
    const out = await redactShopCustomer(db.supabase, SHOP, payload);
    expect(out[0]!.contactsDeleted).toBe(0);
    expect(deletes(db.ops, "contacts")).toEqual([]);
  });

  it("does nothing for an unknown shop", async () => {
    const db = shopDb();
    expect(await redactShopCustomer(db.supabase, OTHER, payload)).toEqual([]);
    expect(db.ops.filter((o) => o.kind === "delete" && o.table !== "webhook_events")).toEqual([]);
  });
});
