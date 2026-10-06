import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 13A — the website reader never stalls, never forgets, and one site has
 * one identity:
 *  (a) www/no-www, http/https, trailing slash, fragments, tracking and listing
 *      params are one address; the source follows the site's redirect.
 *  (b) robots Sitemap: lines → /sitemap.xml → indexes, before any link crawl;
 *      info pages are read first.
 *  (c) runs of ≤25 pages / ~60 s, every page saved as it is read, resume and
 *      requeue; a run never outlives its deadline.
 *  (d) a read stuck in "syncing" resumes; its progress never goes back to 0.
 *  (e) own fetch first; paid readers only for near-empty pages.
 *  (f) deleting a website is soft and restorable for 7 days.
 *  (g) "Re-read this page": one page now, same pipeline, 20 a day.
 *  (h) coverage line from what was read.
 * Replays: myzoori.com (www redirect, broken robots Sitemap line, real
 * sitemap, real pages), a small static site, a Shopify store.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/ai-run.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-run.server")>()),
  embedTexts: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  executeRun: async () => ({ status: "error", output: "", costAmount: 0, inputTokens: 0, outputTokens: 0 }),
  meterAiUsage: async () => undefined,
}));
vi.mock("@/lib/merchant-channel.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/merchant-channel.server")>()),
  notifyOwnerOnOnboardingChannel: async () => true,
}));

import {
  discoverSite,
  followSiteRedirect,
  isSoftDeleted,
  pageRereadsToday,
  PAGE_REREADS_PER_DAY,
  purgeDeletedSources,
  rereadOnePage,
  resetStaleReads,
  restoreWebsiteSource,
  softDeleteWebsiteSource,
  staleResetPatch,
  syncSource,
} from "./knowledge.server";
import { aliasOrigins, canonicalPageUrl, infoCoverage, parseRobots, parseSitemap } from "./site-urls";
import { urlPriority } from "./reading.server";
import { readPages } from "./web-reader.server";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";

const FIX = "src/lib/test-support/reader-fixtures/myzoori";
const fixture = (name: string) => readFileSync(`${FIX}/${name}`, "utf8");
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (url: URL) => Response | null | Promise<Response | null>;
let fetched: string[] = [];
function stubFetch(route: Route) {
  fetched = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Public-address check (DNS over HTTPS) before every page fetch.
    if (raw.includes("type=A") || raw.includes("type=AAAA"))
      return json({ Status: 0, Answer: raw.includes("type=AAAA") ? [] : [{ type: 1, data: "104.21.32.1" }] });
    fetched.push(raw);
    return (await route(new URL(raw))) ?? new Response("", { status: 404 });
  });
}

beforeEach(() => {
  clearSafeFetchDnsCache();
  for (const k of ["TAVILY_API_KEY", "FIRECRAWL_API_KEY"]) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------- (a) URLs
describe("(a) one site, one identity", () => {
  const O = "https://www.myzoori.com";
  it("www/no-www, http/https, trailing slash, fragment and tracking tags are one address", () => {
    for (const raw of [
      "https://myzoori.com/about-us",
      "http://myzoori.com/about-us/",
      "https://www.myzoori.com/about-us#team",
      "http://www.myzoori.com/about-us/?utm_source=ig&fbclid=x",
      "/about-us/",
    ])
      expect(canonicalPageUrl(raw, `${O}/`, O)).toBe(`${O}/about-us`);
    expect(canonicalPageUrl("https://myzoori.com", O, O)).toBe(`${O}/`);
  });

  it("listing/filter variants collapse; a category listing keeps its category", () => {
    expect(canonicalPageUrl("/listing?categories=chains&sortBy=price&page=3&price[min]=10", O, O)).toBe(`${O}/listing?categories=chains`);
    expect(canonicalPageUrl("/listing?categories=rings", O, O)).toBe(`${O}/listing?categories=rings`);
    // …unless the merchant keeps query params.
    expect(canonicalPageUrl("/listing?page=3", O, O, { keepQuery: true })).toBe(`${O}/listing?page=3`);
    // Multi-value filters and links that still carry "&amp;" (both on myzoori.com today).
    expect(canonicalPageUrl("/listing?subcategories%5B%5D=a23adca3&tags[]=Pearl", O, O)).toBe(`${O}/listing`);
    expect(canonicalPageUrl("/listing?categories=chains&amp;sortBy=desc", O, O)).toBe(`${O}/listing?categories=chains`);
    // Product addresses keep their query.
    expect(canonicalPageUrl("/products/ring?variant=2", O, O)).toBe(`${O}/products/ring?variant=2`);
  });

  it("another site, another port or a non-web address is not this site", () => {
    expect(canonicalPageUrl("https://instagram.com/myzoori", O, O)).toBeNull();
    expect(canonicalPageUrl("https://shop.myzoori.com/x", O, O)).toBeNull();
    expect(canonicalPageUrl("https://myzoori.com:8443/x", O, O)).toBeNull();
    expect(canonicalPageUrl("mailto:hi@myzoori.com", O, O)).toBeNull();
  });

  it("the other ways the origin is written", () => {
    expect(aliasOrigins(O).sort()).toEqual(["http://myzoori.com", "http://www.myzoori.com", "https://myzoori.com"]);
  });

  it("the source follows the site's redirect (myzoori.com → www.myzoori.com)", async () => {
    stubFetch((u) =>
      u.host === "myzoori.com" ? new Response("", { status: 301, headers: { location: `https://www.myzoori.com${u.pathname}` } }) : html("<html>home</html>"),
    );
    expect(await followSiteRedirect("https://myzoori.com/")).toBe("https://www.myzoori.com/");
    // A redirect onto a marketplace or social page is not the site moving.
    stubFetch((u) => (u.host === "myzoori.com" ? new Response("", { status: 302, headers: { location: "https://www.instagram.com/myzoori" } }) : html("x")));
    expect(await followSiteRedirect("https://myzoori.com/")).toBeNull();
  });
});

// ------------------------------------------------------------ (b) discovery
describe("(b) discover before reading", () => {
  it("parses a sitemap with lastmod, and a sitemap index", () => {
    const real = parseSitemap(fixture("sitemap.xml"));
    expect(real.isIndex).toBe(false);
    expect(real.entries.length).toBe(497);
    expect(real.entries[1]).toEqual({ loc: "https://www.myzoori.com/about-us", lastmod: "2026-10-01T00:00:00+05:30" });
    const index = parseSitemap(
      `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.in/s1.xml</loc><lastmod>2026-09-01</lastmod></sitemap><sitemap><loc><![CDATA[https://a.in/s2.xml?x=1&amp;y=2]]></loc></sitemap></sitemapindex>`,
    );
    expect(index).toEqual({
      isIndex: true,
      entries: [
        { loc: "https://a.in/s1.xml", lastmod: "2026-09-01" },
        { loc: "https://a.in/s2.xml?x=1&y=2", lastmod: null },
      ],
    });
  });

  it("robots: closed paths for *, and every Sitemap line as written", () => {
    const robots = parseRobots(fixture("robots.txt"));
    expect(robots.sitemaps).toEqual(["http://localhost/sitemap.xml"]);
    expect(robots.disallow).toContain("/checkout");
    expect(robots.disallow).toContain("/login");
  });

  it("a robots Sitemap line on another host (localhost) is ignored and /sitemap.xml is used", async () => {
    stubFetch((u) => {
      if (u.pathname === "/robots.txt") return new Response(fixture("robots.txt"));
      if (u.pathname === "/sitemap.xml") return new Response(fixture("sitemap.xml"));
      return null;
    });
    const site = await discoverSite("https://www.myzoori.com");
    expect(fetched.some((f) => f.includes("localhost"))).toBe(false);
    expect(site.sitemap.length).toBe(497);
    expect(site.sitemap.filter((e) => e.loc.includes("/product-detail/")).length).toBe(472);
    expect(site.sitemap[0]!.lastmod).toBe("2026-10-06T13:29:16+05:30");
    expect(site.disallow).toContain("/checkout");
  });

  it("follows a sitemap index named in robots.txt, writing every address on the site's own host", async () => {
    stubFetch((u) => {
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /cart\nSitemap: https://shop.example/sitemap_index.xml");
      if (u.pathname === "/sitemap_index.xml")
        return new Response(`<sitemapindex><sitemap><loc>https://shop.example/pages.xml</loc></sitemap><sitemap><loc>https://other.example/x.xml</loc></sitemap></sitemapindex>`);
      if (u.pathname === "/pages.xml")
        return new Response(`<urlset><url><loc>https://shop.example/faq/</loc><lastmod>2026-10-01</lastmod></url><url><loc>http://shop.example/about</loc></url></urlset>`);
      return null;
    });
    const site = await discoverSite("https://www.shop.example");
    expect(site.sitemap).toEqual([
      { loc: "https://www.shop.example/faq", lastmod: "2026-10-01" },
      { loc: "https://www.shop.example/about", lastmod: null },
    ]);
    expect(fetched.some((f) => f.includes("other.example"))).toBe(false);
  });

  it("info pages first, then categories, products, the rest, blogs last; junk never", () => {
    const O = "https://www.myzoori.com";
    const p = (path: string) => urlPriority(`${O}${path}`, O);
    for (const info of ["/about-us", "/contact-us", "/store", "/careers", "/faq", "/size-guide", "/policy/shipping-policy", "/policy/refund-policy", "/policy/terms-and-condition", "/policy/privacy-policy"])
      expect(p(info)!).toBeGreaterThan(p("/listing?categories=rings")!);
    expect(p("/listing?categories=rings")!).toBeGreaterThan(p("/product-detail/a2d714f5")!);
    expect(p("/product-detail/a2d714f5")!).toBeGreaterThan(p("/blog/gold-jewellery")!);
    for (const junk of ["/cart", "/checkout", "/login", "/my-account"]) expect(p(junk)).toBeNull();
  });
});

// ----------------------------------------------------------- replay worlds

const ORG = "org-zoori";
const SKUS = ["ZTNM", "ZNEK", "ZERN", "ZLRG", "ZPND", "ZBSL"];
const SHELF: Record<string, string> = { ZTNM: "tanmaniya", ZNEK: "necklaces", ZERN: "earrings", ZLRG: "rings", ZPND: "pendants", ZBSL: "bracelets" };
const INFO: Record<string, string> = {
  "/about-us": "about-us.html",
  "/contact-us": "contact-us.html",
  "/store": "store.html",
  "/careers": "careers.html",
  "/faq": "faq.html",
  "/size-guide": "size-guide.html",
  "/policy/terms-and-condition": "policy-terms-and-condition.html",
  "/policy/privacy-policy": "policy-privacy-policy.html",
  "/policy/shipping-policy": "policy-shipping-policy.html",
  "/policy/refund-policy": "policy-refund-policy.html",
  "/blogs": "blogs.html",
  "/listing": "listing-chains.html",
};
const productUuids = parseSitemap(fixture("sitemap.xml"))
  .entries.map((e) => e.loc)
  .filter((l) => l.includes("/product-detail/"))
  .map((l) => l.split("/").pop()!);
const skuFor = (uuid: string) => {
  const i = productUuids.indexOf(uuid);
  return `${SKUS[i % SKUS.length]}-${String(i).padStart(4, "0")}`;
};

/** myzoori.com as it answers today: the bare host redirects to www, pages are served from fixtures. */
function zooriSite(opts: { delayMs?: number } = {}): Route {
  const template = fixture("product-ztnm-0030.html");
  return async (u) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (u.host === "myzoori.com")
      return new Response("", { status: 301, headers: { location: `https://www.myzoori.com${u.pathname}${u.search}` } });
    if (u.host !== "www.myzoori.com") return null;
    if (u.pathname === "/robots.txt") return new Response(fixture("robots.txt"));
    if (u.pathname === "/sitemap.xml") return new Response(fixture("sitemap.xml"), { headers: { "content-type": "application/xml" } });
    if (u.pathname === "/") return html(fixture("home.html"));
    if (INFO[u.pathname]) return html(fixture(INFO[u.pathname]!));
    const product = u.pathname.match(/^\/product-detail\/([0-9a-f-]+)$/)?.[1];
    if (product && productUuids.includes(product))
      return html(
        template
          .split("a2d714f5-9e82-4407-a07a-3d75b8c3d766")
          .join(product)
          .split("ZTNM-0030")
          .join(skuFor(product))
          // The photo is named after the item code too (ztnm-303747-….jpg).
          .split("ztnm-")
          .join(`${skuFor(product).slice(0, 4).toLowerCase()}-`),
      );
    return null;
  };
}

function world(source: Row, extra: Record<string, Row[]> = {}): MemoryDb {
  const db = memoryDb(
    {
      knowledge_sources: [source],
      organizations: [{ id: ORG, plan_status: "active", plan_version_id: "pv-1" }],
      plan_versions: [{ id: "pv-1", plan_id: "growth", limits: { pages: 2000 } }],
      platform_settings: [
        {
          id: true,
          reader_primary: "tavily",
          reader_fallback_order: ["tavily", "firecrawl", "own"],
          map_engine: "own",
          day0_page_limit: 15,
          day0_crawl_cost_cap: 2,
        },
      ],
      ...extra,
    },
    {
      // No paid credits in these worlds unless a test says so.
      reader_try_spend: () => ({ data: false, error: null }),
      firecrawl_try_spend: () => ({ data: false, error: null }),
    },
  );
  h.db = db;
  return db;
}

const src = (db: MemoryDb, id: string) => db.rows("knowledge_sources").find((r) => r["id"] === id)!;

/** What the worker does each minute, for one source, until it stops requeueing. */
async function readToTheEnd(db: MemoryDb, id: string, maxRuns = 40) {
  const runs: Array<{ read: number; pagesDone: number; fetchedPages: string[] }> = [];
  for (let i = 0; i < maxRuns; i += 1) {
    const row = src(db, id);
    if (i > 0 && row["status"] !== "pending") break;
    row["status"] = "syncing";
    row["sync_started_at"] = new Date().toISOString();
    const before = db.rows("knowledge_urls").filter((u) => u["status"] === "read").length;
    fetched = [];
    const result = await syncSource(db.supabase, id, { preserveError: true, deadlineAt: Date.now() + 90_000 });
    expect(result.error ?? null).toBeNull();
    const after = db.rows("knowledge_urls").filter((u) => u["status"] === "read").length;
    runs.push({
      read: after - before,
      pagesDone: Number((src(db, id)["config"] as Row)["pages_done"] ?? 0),
      fetchedPages: fetched.filter((f) => !/robots\.txt|sitemap|products\.json/.test(f)),
    });
  }
  return runs;
}

describe("myzoori.com replay (www redirect, broken robots Sitemap line, 497-address sitemap)", () => {
  it("reads the whole site in bounded runs: info first, every product under www with its shelf, old address hidden not deleted", async () => {
    stubFetch(zooriSite());
    const SID = "eee17015-8d10-4d34-a9e3-41b0b246f5e7";
    const twinUuid = productUuids[1]!;
    const db = world(
      { id: SID, organization_id: ORG, type: "website", name: "myzoori.com", status: "pending", config: { url: "https://myzoori.com/", mode: "full" }, refresh_days: 7 },
      {
        products: [
          // Saved by an earlier read under the bare host.
          { id: "old-twin", organization_id: ORG, source: "crawl", external_id: `https://myzoori.com/product-detail/${twinUuid}`, product_url: `https://myzoori.com/product-detail/${twinUuid}`, title: "old", is_visible: true },
        ],
      },
    );

    const runs = await readToTheEnd(db, SID);
    const row = src(db, SID);
    const config = row["config"] as Record<string, unknown>;

    // (a) the source followed the redirect; same source, new address.
    expect(row["name"]).toBe("www.myzoori.com");
    expect(config["url"]).toBe("https://www.myzoori.com/");
    expect(config["previous_origins"]).toEqual(["https://myzoori.com"]);

    // (c) bounded runs, progress only ever goes up, and it finished.
    expect(runs.length).toBeGreaterThan(15);
    for (const run of runs) expect(run.read).toBeLessThanOrEqual(25);
    for (let i = 1; i < runs.length; i += 1) expect(runs[i]!.pagesDone).toBeGreaterThanOrEqual(runs[i - 1]!.pagesDone);
    expect(row["status"]).toBe("ready");
    expect(config["resume"]).toBe(false);
    expect(row["last_full_read_at"]).toBeTruthy();

    // (b) info pages were read before any product page.
    const order = runs.flatMap((r) => r.fetchedPages);
    const lastInfo = Math.max(...Object.keys(INFO).filter((p) => !["/blogs", "/listing"].includes(p)).map((p) => order.indexOf(`https://www.myzoori.com${p}`)));
    const firstProduct = order.findIndex((f) => f.includes("/product-detail/"));
    expect(lastInfo).toBeGreaterThan(-1);
    expect(firstProduct).toBeGreaterThan(lastInfo);

    // Every info page is a document under www.
    const refs = new Set(db.rows("knowledge_documents").map((d) => String(d["source_ref"])));
    for (const p of Object.keys(INFO)) if (p !== "/listing") expect(refs.has(`https://www.myzoori.com${p}`)).toBe(true);
    expect([...refs].some((r) => r.startsWith("https://myzoori.com"))).toBe(false);

    // Every product from the sitemap, under www, on its shelf.
    const products = db.rows("products").filter((p) => p["is_visible"] === true);
    expect(products.length).toBe(472);
    expect(products.every((p) => String(p["external_id"]).startsWith("https://www.myzoori.com/product-detail/"))).toBe(true);
    const shelves = new Set(products.map((p) => p["category"]));
    for (const shelf of ["necklaces", "earrings", "tanmaniya", "rings", "pendants", "bracelets"]) expect(shelves.has(shelf)).toBe(true);
    const one = products.find((p) => String(p["external_id"]).endsWith(productUuids[0]!))!;
    expect(one).toMatchObject({ title: skuFor(productUuids[0]!), price: 33419.02, category: SHELF[skuFor(productUuids[0]!).slice(0, 4)] });
    expect(String(one["image_url"])).toContain(`/storage/images/products/${productUuids[0]}/`);
    expect(row["products_found"]).toBe(472);

    // The old bare-host copy is hidden, never deleted.
    const old = db.rows("products").find((p) => p["id"] === "old-twin")!;
    expect(old["is_visible"]).toBe(false);

    // (e) every page here has enough text: no paid reader was asked.
    expect(fetched.some((f) => /tavily|firecrawl|r\.jina\.ai/.test(f))).toBe(false);
    // Robots-closed paths were never fetched.
    expect(runs.flatMap((r) => r.fetchedPages).some((f) => /\/(?:login|checkout|signup)\b/.test(f))).toBe(false);
  }, 120_000);

  it("(d) a run that dies resumes where it got to: saved pages aren't read again and progress never resets", async () => {
    stubFetch(zooriSite());
    const SID = "src-dies";
    const db = world({ id: SID, organization_id: ORG, type: "website", name: "www.myzoori.com", status: "syncing", config: { url: "https://www.myzoori.com/", mode: "full" } });
    // First run reads normally…
    await syncSource(db.supabase, SID, { preserveError: true, deadlineAt: Date.now() + 90_000 });
    const readFirst = db.rows("knowledge_urls").filter((u) => u["status"] === "read").map((u) => String(u["url"]));
    expect(readFirst.length).toBe(25);
    expect(db.rows("knowledge_documents").length).toBeGreaterThan(0);
    // …then pretend it died before its last write: still "syncing", 11 minutes old,
    // its end-of-run config lost.
    const row = src(db, SID);
    const startedAt = (row["config"] as Row)["full_read_started_at"];
    expect(startedAt).toBeTruthy();
    Object.assign(row, {
      status: "syncing",
      sync_started_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      pages_seen: 25,
      config: { url: "https://www.myzoori.com/", mode: "full", full_read_started_at: startedAt },
    });

    expect(await resetStaleReads(db.supabase)).toBe(1);
    expect(row["status"]).toBe("pending");
    expect((row["config"] as Row)["resume"]).toBe(true);
    expect((row["config"] as Row)["pages_done"]).toBe(25);

    fetched = [];
    row["status"] = "syncing";
    await syncSource(db.supabase, SID, { preserveError: true, deadlineAt: Date.now() + 90_000 });
    for (const url of readFirst) expect(fetched).not.toContain(url);
    // No second discovery: the saved address list is the queue.
    expect(fetched.some((f) => f.endsWith("/sitemap.xml"))).toBe(false);
    expect((src(db, SID)["config"] as Row)["pages_done"]).toBe(50);
    expect(db.rows("knowledge_urls").filter((u) => u["status"] === "read").length).toBe(50);
  }, 60_000);

  it("(c) a run is cut at its deadline: nothing taken is lost, the rest waits for the next run", async () => {
    stubFetch(zooriSite({ delayMs: 400 }));
    const SID = "src-deadline";
    const db = world({ id: SID, organization_id: ORG, type: "website", name: "www.myzoori.com", status: "syncing", config: { url: "https://www.myzoori.com/", mode: "full", resume: true, pages_done: 7 } }, {
      knowledge_urls: [
        { organization_id: ORG, source_id: SID, url: "https://www.myzoori.com/faq", priority: 70, status: "unread" },
        { organization_id: ORG, source_id: SID, url: "https://www.myzoori.com/store", priority: 65, status: "unread" },
      ],
    });
    const started = Date.now();
    await syncSource(db.supabase, SID, { preserveError: true, deadlineAt: Date.now() + 1_500 });
    expect(Date.now() - started).toBeLessThan(5_000);
    const row = src(db, SID);
    expect(row["status"]).toBe("pending");
    expect((row["config"] as Row)["resume"]).toBe(true);
    expect((row["config"] as Row)["pages_done"]).toBeGreaterThanOrEqual(7);
    expect(db.rows("knowledge_urls").filter((u) => u["status"] !== "read").length).toBeGreaterThan(0);
  });
});

describe("Day-0 read is unchanged", () => {
  it("one pass of at most day0_page_limit pages, never requeued, Reading-tab order kept", async () => {
    stubFetch(zooriSite());
    const db = world({ id: "d0", organization_id: ORG, type: "website", name: "www.myzoori.com", status: "syncing", config: { url: "https://www.myzoori.com/", mode: "day0" } });
    db.rows("organizations")[0]!["plan_status"] = "trial";
    db.rows("organizations")[0]!["plan_version_id"] = null;
    const result = await syncSource(db.supabase, "d0", { preserveError: true });
    expect(result.ok).toBe(true);
    const row = src(db, "d0");
    expect(row["status"]).toBe("ready");
    expect((row["config"] as Row)["resume"]).toBe(false);
    expect((row["config"] as Row)["mode"]).toBe("day0");
    const read = db.rows("knowledge_urls").filter((u) => u["status"] === "read");
    expect(read.length).toBe(15);
    expect(result.itemCount).toBe(db.rows("knowledge_documents").length);
    expect(result.itemCount).toBeGreaterThan(10);
    // The rest of the site is remembered as unread for later reads.
    expect(db.rows("knowledge_urls").filter((u) => u["status"] !== "read").length).toBeGreaterThan(400);
    const code = readFileSync("src/lib/knowledge.server.ts", "utf8");
    expect(code).toContain("const day0Limit = Math.max(Number(reading.day0_page_limit) || 15, 1);");
  }, 60_000);
});

describe("(d) stall reset", () => {
  it("a full read resumes with its progress; a refresh carries on; anything else just goes back in the queue", () => {
    const full = staleResetPatch({ type: "website", config: { mode: "full", pages_done: 40 }, pages_seen: 65 });
    expect(full).toMatchObject({ status: "pending", sync_started_at: null, config: { mode: "full", resume: true, pages_done: 65 } });
    const kept = staleResetPatch({ type: "website", config: { mode: "full", pages_done: 80 }, pages_seen: 10 });
    expect((kept["config"] as Row)["pages_done"]).toBe(80);
    expect(staleResetPatch({ type: "website", config: { mode: "full", refresh: true, refresh_started_at: "t" }, pages_seen: 5 })["config"]).toBeUndefined();
    expect(staleResetPatch({ type: "website", config: { mode: "day0" }, pages_seen: 5 })["config"]).toBeUndefined();
    expect(staleResetPatch({ type: "pdf", config: {}, pages_seen: 0 })["config"]).toBeUndefined();
  });

  it("only reads stuck over 10 minutes are reset", async () => {
    const db = memoryDb({
      knowledge_sources: [
        { id: "old", type: "website", status: "syncing", sync_started_at: new Date(Date.now() - 11 * 60_000).toISOString(), config: { mode: "full" }, pages_seen: 3 },
        { id: "fresh", type: "website", status: "syncing", sync_started_at: new Date(Date.now() - 60_000).toISOString(), config: { mode: "full" }, pages_seen: 3 },
      ],
    });
    expect(await resetStaleReads(db.supabase)).toBe(1);
    expect(db.rows("knowledge_sources").map((r) => r["status"])).toEqual(["pending", "syncing"]);
  });

  it("the worker claims one source at a time and never starts one it has no time for", () => {
    const worker = readFileSync("src/routes/api/internal/knowledge-worker.ts", "utf8");
    expect(worker).toContain("resetStaleReads(supabase)");
    expect(worker).toContain("deadlineAt: tickEnds - 5_000");
    expect(worker).toMatch(/while \(claimed\.length < 3 && tickEnds - Date\.now\(\) >= MIN_READ_MS\)/);
    expect(worker).toContain("const TICK_BUDGET_MS = 95_000;");
  });
});

// ------------------------------------------------------- small static site
describe("small static site replay", () => {
  it("no sitemap: the links are crawled, duplicates collapse, one pass, done", async () => {
    const long = (t: string) => `<p>${`${t} — we deliver across India in 3 to 5 days. `.repeat(12)}</p>`;
    const pages: Record<string, string> = {
      "/": `<html><head><title>Static Co</title></head><body>${long("Home")}<a href="/about/">About</a><a href="/about#team">Team</a><a href="/shipping?utm_source=x">Shipping</a><a href="https://www.static.example/contact">Contact</a><a href="/blog/post-1">Post</a><a href="/cart">Cart</a><a href="https://facebook.com/static">FB</a></body></html>`,
      "/about": `<html><head><title>About</title></head><body>${long("About us")}</body></html>`,
      "/shipping": `<html><head><title>Shipping</title></head><body>${long("Shipping")}</body></html>`,
      "/contact": `<html><head><title>Contact</title></head><body>${long("Contact")}</body></html>`,
      "/blog/post-1": `<html><head><title>Post</title></head><body>${long("Post")}</body></html>`,
    };
    stubFetch((u) => (u.host.endsWith("static.example") && pages[u.pathname.replace(/\/$/, "") || "/"] ? html(pages[u.pathname.replace(/\/$/, "") || "/"]!) : null));
    const db = world({ id: "s", organization_id: ORG, type: "website", name: "static.example", status: "syncing", config: { url: "https://static.example/", mode: "full" } });
    const runs = await readToTheEnd(db, "s");
    expect(runs.length).toBe(1);
    const refs = db.rows("knowledge_documents").map((d) => d["source_ref"]).sort();
    expect(refs).toEqual([
      "https://static.example/",
      "https://static.example/about",
      "https://static.example/blog/post-1",
      "https://static.example/contact",
      "https://static.example/shipping",
    ]);
    const urls = db.rows("knowledge_urls").map((u) => u["url"]);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).not.toContain("https://static.example/cart");
    expect(src(db, "s")["status"]).toBe("ready");
    expect(src(db, "s")["item_count"]).toBe(5);
  });
});

// ------------------------------------------------------------ Shopify store
describe("Shopify store replay", () => {
  it("the catalogue still arrives as data; product pages aren't crawled", async () => {
    const long = `<p>${"Freshly roasted coffee from Chikmagalur. ".repeat(15)}</p>`;
    stubFetch((u) => {
      if (u.pathname === "/") return html(`<html><head><title>Shop</title><script src="https://cdn.shopify.com/s/x.js"></script></head><body>${long}<a href="/products/arabica">Arabica</a><a href="/pages/about">About</a><a href="/collections/all">All</a></body></html>`);
      if (u.pathname === "/products.json" && u.searchParams.get("page") === "1")
        return json({
          products: [
            { handle: "arabica", title: "Arabica 250g", body_html: "<p>Medium roast</p>", variants: [{ title: "250g", price: "499.00", available: true }] },
            { handle: "robusta", title: "Robusta 250g", body_html: "<p>Dark roast</p>", variants: [{ title: "250g", price: "399.00", available: false }] },
          ],
        });
      if (u.pathname === "/pages/about") return html(`<html><head><title>About</title></head><body>${long}</body></html>`);
      return null;
    });
    const db = world({ id: "shop", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: "https://shop.example/", mode: "full" } });
    await readToTheEnd(db, "shop");
    expect(fetched.some((f) => f.endsWith("/products/arabica"))).toBe(false);
    const docs = db.rows("knowledge_documents");
    const arabica = docs.find((d) => d["source_ref"] === "https://shop.example/products/arabica")!;
    expect(arabica["content"]).toContain("Arabica 250g\nPrice: 499");
    expect((arabica["metadata"] as Row)["kind"]).toBe("product");
    expect(docs.some((d) => d["source_ref"] === "https://shop.example/pages/about")).toBe(true);
    expect((src(db, "shop")["config"] as Row)["platform"]).toBe("shopify");
    expect(src(db, "shop")["status"]).toBe("ready");
  });
});

// ------------------------------------------------- (e) cheapest reader first
describe("(e) own fetch first, paid readers only for near-empty pages", () => {
  it("a page with enough text is never sent to a paid reader in a run, even when it looks client-rendered", async () => {
    process.env["TAVILY_API_KEY"] = "t";
    const db = memoryDb({}, { reader_try_spend: () => ({ data: true, error: null }) });
    h.db = db;
    const body = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script><p>${"Plenty of words about rings. ".repeat(20)}</p></body></html>`;
    stubFetch((u) => (u.host === "api.tavily.com" ? json({ results: [] }) : html(body)));
    const budget = { supabase: db.supabase, organizationId: ORG };
    const pages = await readPages(["https://x.example/a"], { order: ["own", "tavily"], tavilyBudget: budget, rerender: false });
    expect(pages.get("https://x.example/a")?.engine).toBe("own");
    expect(fetched.some((f) => f.includes("tavily"))).toBe(false);
    // The day-one read keeps reading client-rendered pages again, rendered.
    await readPages(["https://x.example/a"], { order: ["own", "tavily"], tavilyBudget: budget });
    expect(fetched.some((f) => f.includes("tavily"))).toBe(true);
  });

  it("a near-empty shell goes to the paid reader", async () => {
    process.env["TAVILY_API_KEY"] = "t";
    const db = memoryDb({}, { reader_try_spend: () => ({ data: true, error: null }) });
    h.db = db;
    stubFetch((u) =>
      u.host === "api.tavily.com"
        ? json({ results: [{ url: "https://x.example/b", title: "B", raw_content: "Rendered text. ".repeat(40) }] })
        : html(`<html><body><div id="root"></div>Loading…</body></html>`),
    );
    const pages = await readPages(["https://x.example/b"], { order: ["own", "tavily"], tavilyBudget: { supabase: db.supabase, organizationId: ORG }, rerender: false });
    expect(pages.get("https://x.example/b")?.engine).toBe("tavily");
  });

  it("website runs read own-first whatever the Reading tab's primary is; the day-one read keeps the tab's order", () => {
    const code = readFileSync("src/lib/knowledge.server.ts", "utf8");
    expect(code).toContain(`? (["own", ...settingsOrder.filter((engine) => engine !== "own")] as ReaderEngine[])
    : settingsOrder;`);
    expect(code).toContain("...(staged ? { timeoutMs: PAGE_TIMEOUT_MS, rerender: false } : {}),");
  });
});

// ----------------------------------------------------------- (f) safe delete
describe("(f) deleting a website is soft and restorable", () => {
  const SITE = "https://www.myzoori.com";
  const seed = () =>
    world(
      { id: "w", organization_id: ORG, type: "website", name: "www.myzoori.com", status: "ready", item_count: 3, queued_at: null, sync_started_at: null, config: { url: `${SITE}/`, mode: "full" } },
      {
        knowledge_documents: [1, 2, 3].map((i) => ({ id: `d${i}`, source_id: "w", organization_id: ORG, source_ref: `${SITE}/p${i}`, content: "x" })),
        knowledge_chunks: [1, 2, 3].map((i) => ({ id: `c${i}`, source_id: "w", document_id: `d${i}`, organization_id: ORG })),
        products: [
          { id: "p1", organization_id: ORG, source: "crawl", product_url: `${SITE}/product-detail/1`, is_visible: true },
          { id: "p2", organization_id: ORG, source: "crawl", product_url: "https://myzoori.com/product-detail/2", is_visible: true },
          { id: "p3", organization_id: ORG, source: "crawl", product_url: `${SITE}/product-detail/3`, is_visible: false },
          { id: "p4", organization_id: ORG, source: "shopify", product_url: `${SITE}/product-detail/4`, is_visible: true },
          { id: "p5", organization_id: ORG, source: "crawl", product_url: "https://other.example/x", is_visible: true },
        ],
      },
    );

  it("hides retrieval and search at once, keeps everything, and Undo brings back exactly what was there", async () => {
    const db = seed();
    const before = JSON.parse(JSON.stringify({ source: src(db, "w"), products: db.rows("products") }));
    const removed = await softDeleteWebsiteSource(db.supabase, ORG, "w", "user-1");
    expect(removed).toMatchObject({ ok: true, pages: 3, products: 2 });
    const row = src(db, "w");
    // Retrieval skips disabled sources (match_knowledge_chunks: s.status <> 'disabled').
    expect(row["status"]).toBe("disabled");
    expect(isSoftDeleted(row as { status: string; config: Record<string, unknown> })).toBe(true);
    const purgeAfter = Date.parse(String((row["config"] as Row)["purge_after"]));
    expect(Math.round((purgeAfter - Date.now()) / 86_400_000)).toBe(7);
    // Nothing removed: pages and chunks are all still there.
    expect(db.rows("knowledge_documents")).toHaveLength(3);
    expect(db.rows("knowledge_chunks")).toHaveLength(3);
    // This site's crawled products leave search; a shop platform's and another site's don't.
    const vis = Object.fromEntries(db.rows("products").map((p) => [p["id"], p["is_visible"]]));
    expect(vis).toEqual({ p1: false, p2: false, p3: false, p4: true, p5: true });
    // A deleted source is never read again.
    expect((await syncSource(db.supabase, "w")).ok).toBe(false);

    const restored = await restoreWebsiteSource(db.supabase, ORG, "w");
    expect(restored).toEqual({ ok: true, products: 2 });
    const after = { source: src(db, "w"), products: db.rows("products") };
    const strip = (o: Row) => {
      const { updated_at: _u, ...rest } = o;
      return rest;
    };
    expect(strip(after.source)).toEqual(strip(before.source));
    expect(after.products.map(strip)).toEqual(before.products.map(strip));
  });

  it("a website being read right now can't be deleted mid-read; other members' sources aren't touched", async () => {
    const db = seed();
    src(db, "w")["status"] = "syncing";
    expect((await softDeleteWebsiteSource(db.supabase, ORG, "w", null)).ok).toBe(false);
    expect((await softDeleteWebsiteSource(db.supabase, "other-org", "w", null)).ok).toBe(false);
  });

  it("the nightly job purges only after 7 days", async () => {
    const db = seed();
    await softDeleteWebsiteSource(db.supabase, ORG, "w", null);
    expect(await purgeDeletedSources(db.supabase, new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(db.rows("knowledge_sources")).toHaveLength(1);
    expect(await purgeDeletedSources(db.supabase, new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect(db.rows("knowledge_sources")).toHaveLength(0);
    // Products stay, hidden — never deleted.
    expect(db.rows("products")).toHaveLength(5);
  });

  it("every way of deleting a website goes through the soft delete, and deleted sources stay out of every read path", () => {
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain("knowledge.softDeleteWebsiteSource(getServiceClient(), auth.organizationId, sourceId, auth.userId)");
    const purge = readFileSync("src/routes/api/internal/knowledge-backfill.ts", "utf8");
    expect(purge).toContain("purgeDeletedSources(supabase)");
    expect(readFileSync("src/routes/api/internal/knowledge-refresh.ts", "utf8")).toContain('"(syncing,pending,disabled)"');
    expect(readFileSync("src/lib/plan-purchase.server.ts", "utf8")).toContain('.neq("status", "disabled")');
    expect(readFileSync("supabase/aidwar-migrations/20261008_security_guards.sql", "utf8")).toContain("s.status <> 'disabled'");
    // The only hard delete of a knowledge source outside the purge is for non-website sources.
    const code = readFileSync("src/lib/knowledge.server.ts", "utf8");
    expect(code.match(/from\("knowledge_sources"\)\.delete\(\)/g)).toHaveLength(1);
  });
});

// ----------------------------------------------------- (g) re-read one page
describe("(g) Re-read this page", () => {
  it("reads one page of this site now, replacing its text and its product", async () => {
    stubFetch(zooriSite());
    const uuid = productUuids[3]!;
    const db = world(
      { id: "w", organization_id: ORG, type: "website", name: "www.myzoori.com", status: "ready", config: { url: "https://www.myzoori.com/", mode: "full" } },
      { knowledge_documents: [{ id: "d-faq", organization_id: ORG, source_id: "w", source_ref: "https://www.myzoori.com/faq", title: "FAQ", content: "old text", metadata: {} }] },
    );
    const faq = await rereadOnePage(db.supabase, ORG, "w", "http://myzoori.com/faq/");
    expect(faq).toMatchObject({ ok: true, saved: true });
    const doc = db.rows("knowledge_documents").find((d) => d["source_ref"] === "https://www.myzoori.com/faq")!;
    expect(String(doc["content"])).not.toBe("old text");
    expect(String(doc["content"]).length).toBeGreaterThan(1000);
    expect(db.rows("knowledge_documents")).toHaveLength(1);

    const product = await rereadOnePage(db.supabase, ORG, "w", `https://www.myzoori.com/product-detail/${uuid}#reviews`);
    expect(product).toMatchObject({ ok: true, product: skuFor(uuid) });
    expect(db.rows("products").find((p) => p["external_id"] === `https://www.myzoori.com/product-detail/${uuid}`)).toBeTruthy();
    expect(src(db, "w")["products_found"]).toBe(1);
    expect(db.rows("knowledge_urls").find((u) => u["url"] === "https://www.myzoori.com/faq")).toMatchObject({ status: "read", read_via: "page_reread" });
  });

  it("refuses another site's page, a missing page and a deleted source; a thin page keeps the old text", async () => {
    stubFetch((u) => (u.pathname === "/thin" ? html("<html><body>tiny</body></html>") : zooriSite()(u)));
    const db = world(
      { id: "w", organization_id: ORG, type: "website", name: "www.myzoori.com", status: "ready", config: { url: "https://www.myzoori.com/", mode: "full" } },
      { knowledge_documents: [{ id: "d", organization_id: ORG, source_id: "w", source_ref: "https://www.myzoori.com/thin", title: "T", content: "keep me", metadata: {} }] },
    );
    expect((await rereadOnePage(db.supabase, ORG, "w", "https://instagram.com/myzoori")).error).toContain("isn't on www.myzoori.com");
    expect((await rereadOnePage(db.supabase, ORG, "w", "https://www.myzoori.com/nope")).ok).toBe(false);
    const thin = await rereadOnePage(db.supabase, ORG, "w", "https://www.myzoori.com/thin");
    expect(thin).toMatchObject({ ok: true, saved: false });
    expect(db.rows("knowledge_documents")[0]!["content"]).toBe("keep me");
    src(db, "w")["status"] = "disabled";
    (src(db, "w")["config"] as Row)["deleted_at"] = new Date().toISOString();
    expect((await rereadOnePage(db.supabase, ORG, "w", "https://www.myzoori.com/faq")).ok).toBe(false);
  });

  it("20 a day per workspace; no cooldown otherwise", async () => {
    const now = Date.now();
    const db = memoryDb({
      activity_log: [
        ...Array.from({ length: 20 }, (_, i) => ({ organization_id: ORG, action: "knowledge_page_reread", created_at: new Date(now - i * 60_000).toISOString() })),
        { organization_id: ORG, action: "knowledge_page_reread", created_at: new Date(now - 25 * 3_600_000).toISOString() },
        { organization_id: "other", action: "knowledge_page_reread", created_at: new Date(now).toISOString() },
      ],
    });
    expect(PAGE_REREADS_PER_DAY).toBe(20);
    expect(await pageRereadsToday(db.supabase, ORG, now)).toBe(20);
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain("(await knowledge.pageRereadsToday(service, auth.organizationId)) >= knowledge.PAGE_REREADS_PER_DAY");
    // "Re-read whole site" is the existing refresh, cooldown kept.
    expect(route).toContain("config = { ...(src.config ?? {}), refresh: true, fill_products: true };");
    expect(route).toContain("reading.manual_refresh_cooldown_hours * 36e5");
  });
});

// --------------------------------------------------------------- (h) coverage
describe("(h) coverage line", () => {
  it("✓/✗ for FAQ, Shipping, Returns, Size guide, Contact/Store by address or title", () => {
    const O = "https://www.myzoori.com";
    expect(
      infoCoverage([
        { url: `${O}/faq`, title: "MyZoori Jewellery FAQs" },
        { url: `${O}/policy/shipping-policy`, title: "Shipping & Delivery Policy" },
        { url: `${O}/policy/refund-policy`, title: "Refund & Cancellation Policy" },
        { url: `${O}/size-guide`, title: "Jewellery Size Guide" },
        { url: `${O}/store`, title: "Jewellery Collection Online" },
      ]),
    ).toEqual({ faq: true, shipping: true, returns: true, size_guide: true, contact: true });
    expect(
      infoCoverage([
        { url: `${O}/about-us`, title: "About Zoori" },
        // A product named "Delivery ring" is not a shipping page.
        { url: `${O}/product-detail/x`, title: "Delivery ring" },
      ]),
    ).toEqual({ faq: false, shipping: false, returns: false, size_guide: false, contact: false });
  });
});
