import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 13B — merchant controls for website reading:
 *  - Add website: crawl from homepage / use sitemap / individual links, and
 *    the query-parameter switch.
 *  - Links list (Read / Not found / Excluded / Waiting), exclude/include a
 *    link or a folder, exclude rules (starts with / contains / ends with / exact).
 *  - "Re-read whole site" reads only pages whose sitemap date moved (the
 *    weekly refresh still reads them all); "Change website address".
 *  - Swap rule: a full re-read replaces the live version only with the same
 *    info pages and ≥80% of the products.
 *  - Plan limits count paid-reader pages only.
 *  - Site-change alerts; super-admin force full read and read log.
 * Not in this batch (by decision): a daily price/stock re-check — no
 * automatic daily reading — and any change to the weekly refresh.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown }, notified: [] as string[] }));
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
  notifyOwnerOnOnboardingChannel: async (_s: unknown, _o: string, body: string) => {
    h.notified.push(body);
    return true;
  },
}));

import {
  changeWebsiteAddress,
  changeWebsiteLinks,
  forceFullRead,
  listWebsiteLinks,
  readingLog,
  syncSource,
} from "./knowledge.server";
import { decideSwap, folderRule, isExcluded, pageType, readExcludeRules } from "./site-urls";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";

const ORG = "org-13b";
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (title: string, extra = "") =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${`${title} — we deliver across India in 3 to 5 days. `.repeat(10)}</p>${extra}</body></html>`;

type Route = (url: URL) => Response | null | Promise<Response | null>;
let fetched: string[] = [];
function stubFetch(route: Route) {
  fetched = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (raw.includes("type=A") || raw.includes("type=AAAA"))
      return json({ Status: 0, Answer: raw.includes("type=AAAA") ? [] : [{ type: 1, data: "104.21.32.1" }] });
    fetched.push(raw);
    return (await route(new URL(raw))) ?? new Response("", { status: 404 });
  });
}

function world(source: Row, extra: Record<string, Row[]> = {}, opts: { paid?: boolean; pages?: number; day0?: number; tavily?: boolean } = {}): MemoryDb {
  const db = memoryDb(
    {
      knowledge_sources: [source],
      organizations: [{ id: ORG, plan_status: opts.paid === false ? "trial" : "active", plan_version_id: opts.paid === false ? null : "pv-1" }],
      plan_versions: [{ id: "pv-1", plan_id: "growth", limits: { pages: opts.pages ?? 2000 } }],
      platform_settings: [
        {
          id: true,
          reader_primary: "tavily",
          reader_fallback_order: ["tavily", "firecrawl", "own"],
          map_engine: "own",
          day0_page_limit: opts.day0 ?? 15,
          day0_crawl_cost_cap: 2,
        },
      ],
      ...extra,
    },
    {
      reader_try_spend: () => ({ data: opts.tavily === true, error: null }),
      firecrawl_try_spend: () => ({ data: false, error: null }),
    },
  );
  h.db = db;
  return db;
}
const src = (db: MemoryDb, id: string) => db.rows("knowledge_sources").find((r) => r["id"] === id)!;
const cfg = (db: MemoryDb, id: string) => src(db, id)["config"] as Record<string, unknown>;

async function readToTheEnd(db: MemoryDb, id: string, maxRuns = 30) {
  let runs = 0;
  for (let i = 0; i < maxRuns; i += 1) {
    const row = src(db, id);
    if (i > 0 && row["status"] !== "pending") break;
    row["status"] = "syncing";
    const result = await syncSource(db.supabase, id, { preserveError: true, deadlineAt: Date.now() + 90_000 });
    expect(result.error ?? null).toBeNull();
    runs += 1;
  }
  return runs;
}

beforeEach(() => {
  clearSafeFetchDnsCache();
  h.notified = [];
  for (const k of ["TAVILY_API_KEY", "FIRECRAWL_API_KEY"]) delete process.env[k];
});
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------ pure helpers
describe("page types, exclude rules, swap rule", () => {
  const O = "https://www.myzoori.com";
  it("types pages from their address", () => {
    expect(pageType(`${O}/`)).toBe("home");
    expect(pageType(`${O}/policy/refund-policy`)).toBe("info");
    expect(pageType(`${O}/size-guide`)).toBe("info");
    expect(pageType(`${O}/store`)).toBe("info");
    expect(pageType(`${O}/product-detail/a2d714f5`)).toBe("product");
    expect(pageType(`${O}/listing?categories=rings`)).toBe("category");
    expect(pageType(`${O}/blog/gold-trends`)).toBe("blog");
    expect(pageType(`${O}/cart`)).toBe("junk");
    expect(pageType(`${O}/login`)).toBe("junk");
  });

  it("starts with / contains / ends with / exact; a link included by hand wins", () => {
    const rules = readExcludeRules([
      { op: "starts_with", value: "/blog/" },
      { op: "contains", value: "?ref=" },
      { op: "ends_with", value: ".html" },
      { op: "exact", value: `${O}/careers` },
      { op: "nope", value: "x" },
      { op: "exact", value: "  " },
    ]);
    expect(rules).toHaveLength(4);
    expect(isExcluded(`${O}/blog/gold`, rules)).toBe(true);
    expect(isExcluded(`${O}/blogs`, rules)).toBe(false);
    expect(isExcluded(`${O}/listing?ref=ig`, rules)).toBe(true);
    expect(isExcluded(`${O}/old/page.html`, rules)).toBe(true);
    expect(isExcluded(`${O}/careers`, rules)).toBe(true);
    expect(isExcluded(`${O}/careers/jobs`, rules)).toBe(false);
    expect(isExcluded(`${O}/blog/gold`, rules, [`${O}/blog/gold`])).toBe(false);
    expect(folderRule(`${O}/blog/gold`)).toEqual({ op: "starts_with", value: "/blog/" });
    expect(folderRule(`${O}/faq`)).toBeNull();
  });

  it("swaps only with the same info pages and ≥80% of the products", () => {
    expect(decideSwap({ previousTopics: ["faq", "shipping"], newTopics: ["faq", "shipping", "returns"], previousProducts: 100, newProducts: 80 })).toEqual({
      swap: true,
      reasons: [],
      missingTopics: [],
    });
    const lost = decideSwap({ previousTopics: ["faq", "returns"], newTopics: ["faq"], previousProducts: 100, newProducts: 79 });
    expect(lost.swap).toBe(false);
    expect(lost.missingTopics).toEqual(["returns"]);
    expect(lost.reasons.join(" ")).toContain("Returns");
    expect(lost.reasons.join(" ")).toContain("79 of 100 products");
    // A first read has nothing to lose.
    expect(decideSwap({ previousTopics: [], newTopics: [], previousProducts: 0, newProducts: 0 }).swap).toBe(true);
  });
});

// --------------------------------------------------- Add website: discovery
describe("Add website: how the site is found", () => {
  const site: Record<string, string> = {
    "/": page("Home", `<a href="/about">About</a><a href="/blog/one">Blog</a><a href="/shop?page=2">Shop 2</a><a href="/shop?page=3">Shop 3</a>`),
    "/about": page("About", `<a href="/hidden">Hidden</a>`),
    "/shipping": page("Shipping"),
    "/returns": page("Returns"),
    "/hidden": page("Hidden"),
    "/blog/one": page("Blog one"),
    "/shop": page("Shop"),
  };
  const sitemap = `<urlset><url><loc>https://shop.example/about</loc></url><url><loc>https://shop.example/shipping</loc></url></urlset>`;
  const serve: Route = (u) => {
    if (u.pathname === "/sitemap.xml" || u.pathname === "/custom-map.xml") return new Response(sitemap);
    const body = site[u.pathname];
    return body ? html(body) : null;
  };
  const refs = (db: MemoryDb) => db.rows("knowledge_documents").map((d) => String(d["source_ref"])).sort();

  it("Individual links: only the pages listed, no sitemap, no links followed", async () => {
    stubFetch(serve);
    const db = world({
      id: "s",
      organization_id: ORG,
      type: "website",
      name: "shop.example",
      status: "syncing",
      config: { url: "https://shop.example/shipping", mode: "full", discovery: "links", links: ["https://shop.example/shipping", "https://shop.example/returns/", "https://other.example/x"] },
    });
    await readToTheEnd(db, "s");
    expect(refs(db)).toEqual(["https://shop.example/returns", "https://shop.example/shipping"]);
    expect(fetched.some((f) => /sitemap|robots/.test(f))).toBe(false);
    expect(fetched.some((f) => f.includes("other.example"))).toBe(false);
  });

  it("Use sitemap (its own address): what the sitemap lists, plus the homepage; links on pages aren't followed", async () => {
    stubFetch(serve);
    const db = world({
      id: "s",
      organization_id: ORG,
      type: "website",
      name: "shop.example",
      status: "syncing",
      config: { url: "https://shop.example/custom-map.xml", mode: "full", discovery: "sitemap" },
    });
    await readToTheEnd(db, "s");
    expect(refs(db)).toEqual(["https://shop.example/", "https://shop.example/about", "https://shop.example/shipping"]);
    expect(fetched).toContain("https://shop.example/custom-map.xml");
    expect(fetched).not.toContain("https://shop.example/hidden");
  });

  it("Crawl from homepage follows links; page=2/page=3 are one page unless query params are kept; excluded pages are never fetched", async () => {
    stubFetch(serve);
    const db = world({
      id: "s",
      organization_id: ORG,
      type: "website",
      name: "shop.example",
      status: "syncing",
      config: { url: "https://shop.example/", mode: "full", exclude_rules: [{ op: "starts_with", value: "/blog/" }] },
    });
    await readToTheEnd(db, "s");
    expect(refs(db)).toContain("https://shop.example/hidden");
    expect(refs(db)).toContain("https://shop.example/shop");
    expect(refs(db).filter((r) => new URL(r).pathname === "/shop")).toEqual(["https://shop.example/shop"]);
    expect(fetched.some((f) => f.includes("/blog/"))).toBe(false);

    stubFetch(serve);
    const kept = world({ id: "k", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: "https://shop.example/", mode: "full", keep_query: true } });
    await readToTheEnd(kept, "k");
    const shopRefs = kept.rows("knowledge_documents").map((d) => String(d["source_ref"])).filter((r) => new URL(r).pathname === "/shop");
    expect(shopRefs.sort()).toEqual(["https://shop.example/shop?page=2", "https://shop.example/shop?page=3"]);
  });

  it("the Add website route passes the mode, the links and the switch through", () => {
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain('{ mode: "full", discovery, links, keepQuery: payload["keep_query"] === true }');
    expect(route).toContain("Every link must be on the same website as");
  });
});

// ------------------------------------------------ paid pages only count
describe("plan limits count paid-reader pages only", () => {
  const shell = `<html><head><title>Shell</title></head><body><div id="root"></div>Loading…</body></html>`;
  it("own-fetch pages aren't capped by the plan; paid reads stop at the plan's paid pages and the source says why", async () => {
    process.env["TAVILY_API_KEY"] = "t";
    const good: Record<string, string> = { "/": page("Home", Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">P${i}</a>`).join("") + `<a href="/s1">S1</a><a href="/s2">S2</a><a href="/s3">S3</a>`) };
    for (let i = 0; i < 8; i += 1) good[`/p${i}`] = page(`Page ${i}`);
    stubFetch((u) => {
      if (u.host === "api.tavily.com") return json({ results: [] });
      if (/^\/s\d$/.test(u.pathname)) return html(shell);
      return good[u.pathname] ? html(good[u.pathname]!) : null;
    });
    // Trial: the paid budget is the day-one budget (2 here); the plan's page cap (3) doesn't stop own reads.
    const db = world({ id: "t", organization_id: ORG, type: "website", name: "site.example", status: "syncing", config: { url: "https://site.example/", mode: "full" } }, {}, { paid: false, day0: 2, tavily: true });
    await readToTheEnd(db, "t");
    const saved = db.rows("knowledge_documents").length;
    expect(saved).toBe(9); // home + 8 pages, all by our own fetch
    const tavilyCalls = fetched.filter((f) => f.includes("api.tavily.com/extract")).length;
    expect(tavilyCalls).toBe(2 * 2); // basic + advanced, for exactly the 2 paid pages
    expect(cfg(db, "t")["paid_capped"]).toBe(true);
    expect(cfg(db, "t")["paid_pages"]).toBe(2);
  });

  it("an admin's forced read with the limit ignored keeps asking the paid reader", async () => {
    process.env["TAVILY_API_KEY"] = "t";
    stubFetch((u) => {
      if (u.host === "api.tavily.com") return json({ results: [] });
      if (u.pathname === "/") return html(page("Home", `<a href="/s1">1</a><a href="/s2">2</a><a href="/s3">3</a><a href="/s4">4</a>`));
      return html(shell);
    });
    const db = world({ id: "t", organization_id: ORG, type: "website", name: "site.example", status: "syncing", config: { url: "https://site.example/", mode: "full", force_paid: true } }, {}, { paid: false, day0: 1, tavily: true });
    await readToTheEnd(db, "t");
    expect(cfg(db, "t")["paid_capped"]).toBe(false);
    // The switch is used up by the read.
    expect(cfg(db, "t")["force_paid"]).toBeUndefined();
  });

  it("'Read more pages' is no longer a paid-only button", () => {
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain("can_read_more: unread > 0,");
    expect(route).not.toContain("Your plan's page limit is reached — upgrade to read the rest.");
  });
});

// ------------------------------------------- Re-read whole site, changed-only
describe('"Re-read whole site" reads only what changed; the weekly refresh is unchanged', () => {
  const lastRead = "2026-10-05T10:00:00.000Z";
  const seed = (config: Record<string, unknown>) =>
    world(
      { id: "r", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: "https://shop.example/", mode: "full", ...config } },
      {
        knowledge_urls: ["/", "/old", "/new", "/nodate"].map((p) => ({
          organization_id: ORG,
          source_id: "r",
          url: `https://shop.example${p}`,
          priority: 50,
          status: "read",
          read_at: lastRead,
          read_via: "full",
        })),
      },
    );
  const sitemap = `<urlset>
    <url><loc>https://shop.example/old</loc><lastmod>2026-10-01</lastmod></url>
    <url><loc>https://shop.example/new</loc><lastmod>2026-10-06T08:00:00+05:30</lastmod></url>
    <url><loc>https://shop.example/nodate</loc></url></urlset>`;
  const serve: Route = (u) => (u.pathname === "/sitemap.xml" ? new Response(sitemap) : ["/", "/old", "/new", "/nodate"].includes(u.pathname) ? html(page(u.pathname)) : null);

  it("the button: pages whose sitemap date is older than their last read are skipped", async () => {
    stubFetch(serve);
    const db = seed({ refresh: true, changed_only: true, fill_products: true });
    await readToTheEnd(db, "r");
    expect(fetched).toContain("https://shop.example/new");
    expect(fetched).toContain("https://shop.example/nodate");
    expect(fetched).not.toContain("https://shop.example/old");
    expect(cfg(db, "r")["unchanged_skipped"]).toBe(1);
    expect(cfg(db, "r")["changed_only"]).toBeUndefined();
    // The sitemap dates are kept for next time.
    expect(db.rows("knowledge_urls").find((u) => u["url"] === "https://shop.example/new")!["lastmod"]).toBe("2026-10-06T02:30:00.000Z");
  });

  it("the weekly refresh (no changed_only) reads every page, as before", async () => {
    stubFetch(serve);
    const db = seed({ refresh: true });
    await readToTheEnd(db, "r");
    for (const p of ["/old", "/new", "/nodate"]) expect(fetched).toContain(`https://shop.example${p}`);
  });

  it("the button and (Batch 16, Vinay: weekly changed-only re-read on paid plans) the scheduled refresh ask for changed-only; the backfill doesn't", () => {
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain('config["changed_only"] = true;');
    expect(readFileSync("src/routes/api/internal/knowledge-refresh.ts", "utf8")).toContain("changed_only: true");
    expect(readFileSync("src/routes/api/internal/knowledge-backfill.ts", "utf8")).not.toContain("changed_only");
  });

  it("Batch 16 (Vinay): the only daily check is the free price check — own fetch, no AI, no paid reader, behind its switch", () => {
    const internal = readFileSync("src/routeTree.gen.ts", "utf8");
    expect(internal).not.toMatch(/price-check|stock-check|daily-recheck/);
    const backfill = readFileSync("src/routes/api/internal/knowledge-backfill.ts", "utf8");
    expect(backfill).toContain("runPriceCheck(supabase)");
    const check = readFileSync("src/lib/price-check.server.ts", "utf8");
    expect(check).toContain("loadPriceCheckDaily");
    expect(check).not.toMatch(/executeRun|tavily|firecrawl|readPages/i);
  });
});

// ------------------------------------------------------------- swap rule
describe("swap rule on a full re-read", () => {
  const O = "https://shop.example";
  const seed = (siteHasReturns: boolean, liveProducts: number) => {
    const pages: Record<string, string> = {
      "/": page("Home"),
      "/faq": page("FAQ"),
      "/shipping-policy": page("Shipping policy"),
      ...(siteHasReturns ? { "/refund-policy": page("Refund policy") } : {}),
      "/old-page": page("Old page"),
    };
    stubFetch((u) => (u.pathname === "/sitemap.xml" ? new Response(`<urlset>${Object.keys(pages).map((p) => `<url><loc>${O}${p}</loc></url>`).join("")}</urlset>`) : pages[u.pathname] ? html(pages[u.pathname]!) : null));
    return world(
      { id: "w", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: `${O}/`, mode: "full" } },
      {
        knowledge_documents: ["/faq", "/shipping-policy", "/refund-policy", "/gone-page"].map((p, i) => ({
          id: `d${i}`,
          organization_id: ORG,
          source_id: "w",
          source_ref: `${O}${p}`,
          title: p,
          content: "old",
          metadata: {},
        })),
        products: Array.from({ length: liveProducts }, (_, i) => ({
          id: `p${i}`,
          organization_id: ORG,
          source: "crawl",
          external_id: `${O}/products/p${i}`,
          product_url: `${O}/products/p${i}`,
          is_visible: true,
          category: "rings",
          synced_at: "2026-09-01T00:00:00.000Z",
        })),
      },
    );
  };

  it("a re-read that lost the returns page and most products keeps the live version and says why", async () => {
    const db = seed(false, 10);
    await readToTheEnd(db, "w");
    const blocked = cfg(db, "w")["swap_blocked"] as { reasons: string[] };
    expect(blocked.reasons.join(" ")).toContain("Returns");
    expect(blocked.reasons.join(" ")).toContain("0 of 10 products");
    // Nothing forgotten, nothing hidden.
    expect(db.rows("knowledge_documents").some((d) => d["source_ref"] === `${O}/gone-page`)).toBe(true);
    expect(db.rows("products").every((p) => p["is_visible"] === true)).toBe(true);
    expect(db.rows("activity_log").some((a) => a["action"] === "reading_swap_blocked")).toBe(true);
  });

  it("a re-read that covers the same info pages (no products before) replaces the live version", async () => {
    const db = seed(true, 0);
    await readToTheEnd(db, "w");
    expect(cfg(db, "w")["swap_blocked"]).toBeNull();
    expect(cfg(db, "w")["prev_snapshot"]).toBeUndefined();
  });
});

describe("swap rule on a Shopify store re-read", () => {
  it("policy pages that arrive with the catalogue count: the re-read replaces the live version", async () => {
    const O = "https://shop.example";
    const long = `<p>${"Freshly roasted coffee. ".repeat(20)}</p>`;
    stubFetch((u) => {
      if (u.pathname === "/") return html(`<html><head><title>Shop</title><script src="https://cdn.shopify.com/s/x.js"></script></head><body>${long}</body></html>`);
      if (u.pathname === "/products.json" && u.searchParams.get("page") === "1")
        return json({ products: [{ handle: "arabica", title: "Arabica", body_html: "x", variants: [{ title: "250g", price: "499.00" }] }] });
      if (u.pathname === "/policies/refund-policy") return html(`<html><head><title>Refund policy</title></head><body>${long}</body></html>`);
      if (u.pathname === "/policies/shipping-policy") return html(`<html><head><title>Shipping policy</title></head><body>${long}</body></html>`);
      return null;
    });
    const db = world(
      { id: "s", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: `${O}/`, mode: "full" } },
      {
        knowledge_documents: [
          { id: "d1", organization_id: ORG, source_id: "s", source_ref: `${O}/policies/refund-policy`, title: "Refund policy", content: "old", metadata: {} },
          { id: "d2", organization_id: ORG, source_id: "s", source_ref: `${O}/policies/shipping-policy`, title: "Shipping policy", content: "old", metadata: {} },
        ],
      },
    );
    await readToTheEnd(db, "s");
    expect(cfg(db, "s")["platform"]).toBe("shopify");
    expect(cfg(db, "s")["swap_blocked"]).toBeNull();
  });
});

// ------------------------------------------------------- site-change alerts
describe("site-change alerts", () => {
  it("more than 20% of pages gone after a full read: the owner and the admin hear, once a day", async () => {
    const O = "https://shop.example";
    const live = Array.from({ length: 7 }, (_, i) => `/ok${i}`);
    const dead = Array.from({ length: 4 }, (_, i) => `/dead${i}`);
    stubFetch((u) =>
      u.pathname === "/sitemap.xml"
        ? new Response(`<urlset>${[...live, ...dead].map((p) => `<url><loc>${O}${p}</loc></url>`).join("")}</urlset>`)
        : u.pathname === "/" || live.includes(u.pathname)
          ? html(page(u.pathname))
          : new Response("", { status: 404 }),
    );
    const db = world({ id: "a", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: `${O}/`, mode: "full" } });
    await readToTheEnd(db, "a");
    const alerts = db.rows("activity_log").filter((a) => a["action"] === "reading_site_changed");
    expect(alerts).toHaveLength(1);
    expect((alerts[0]!["details"] as Row)["kind"]).toBe("dead_links");
    expect(h.notified.some((b) => b.includes("4 of 12 pages"))).toBe(true);
    expect(db.rows("billing_notifications")).toEqual([expect.objectContaining({ audience: "admin", kind: "site_change_alert", channel: "whatsapp" })]);
    // The admin notice uses the approved admin template.
    expect(readFileSync("src/lib/billing-notify.server.ts", "utf8")).toContain('"admin:site_change_alert": "admin_ai_provider_alert"');
  });

  it("every run is in the read log: pages, engines, credits, cost, errors", async () => {
    stubFetch((u) => (u.pathname === "/" ? html(page("Home")) : null));
    const db = world({ id: "l", organization_id: ORG, type: "website", name: "shop.example", status: "syncing", config: { url: "https://shop.example/", mode: "full" } });
    await readToTheEnd(db, "l");
    const runs = db.rows("activity_log").filter((a) => a["action"] === "reading_run");
    expect(runs).toHaveLength(1);
    expect(runs[0]!["details"]).toMatchObject({ source_id: "l", pages: 1, saved: 1, engines: { own: 1 }, more: false });
    const log = await readingLog(db.supabase, ORG);
    expect(log.sources[0]).toMatchObject({ id: "l", status: "ready", discovery: "crawl" });
    expect(log.log[0]).toMatchObject({ source_id: "l", action: "reading_run" });
  });
});

// --------------------------------------------- links list, exclude, address
describe("links list, exclude/include, change address", () => {
  const O = "https://shop.example";
  const seed = () =>
    world(
      { id: "w", organization_id: ORG, type: "website", name: "shop.example", status: "ready", config: { url: `${O}/`, mode: "full" } },
      {
        knowledge_urls: [
          { organization_id: ORG, source_id: "w", url: `${O}/faq`, status: "read", read_at: "2026-10-05T10:00:00.000Z", read_via: "full", title: "FAQ" },
          { organization_id: ORG, source_id: "w", url: `${O}/blog/one`, status: "read", read_at: "2026-10-05T10:00:00.000Z", read_via: "full" },
          { organization_id: ORG, source_id: "w", url: `${O}/blog/two`, status: "read", read_at: "2026-10-05T10:00:00.000Z", read_via: "full" },
          { organization_id: ORG, source_id: "w", url: `${O}/products/ring`, status: "read", read_at: "2026-10-05T10:00:00.000Z", read_via: "full" },
          { organization_id: ORG, source_id: "w", url: `${O}/gone`, status: "read", read_at: "2026-10-05T10:00:00.000Z", read_via: "gone" },
          { organization_id: ORG, source_id: "w", url: `${O}/later`, status: "unread" },
        ],
        knowledge_documents: [
          { id: "d1", organization_id: ORG, source_id: "w", source_ref: `${O}/faq`, title: "FAQ", content: "x", metadata: { chars: 5018 } },
          { id: "d2", organization_id: ORG, source_id: "w", source_ref: `${O}/blog/one`, title: "One", content: "x", metadata: { chars: 900 } },
          { id: "d3", organization_id: ORG, source_id: "w", source_ref: `${O}/blog/two`, title: "Two", content: "x", metadata: {} },
          { id: "d4", organization_id: ORG, source_id: "w", source_ref: `${O}/products/ring`, title: "Ring", content: "x", metadata: {} },
        ],
        products: [{ id: "p1", organization_id: ORG, source: "crawl", external_id: `${O}/products/ring`, product_url: `${O}/products/ring`, is_visible: true }],
      },
    );

  it("tabs with counts, characters and last read", async () => {
    const db = seed();
    const read = await listWebsiteLinks(db.supabase, ORG, "w", { tab: "read" });
    expect(read.counts).toEqual({ read: 4, not_found: 1, excluded: 0, waiting: 1 });
    expect(read.rows.find((r) => r.url === `${O}/faq`)).toMatchObject({ type: "info", chars: 5018, read_at: "2026-10-05T10:00:00.000Z" });
    expect((await listWebsiteLinks(db.supabase, ORG, "w", { tab: "not_found" })).rows.map((r) => r.url)).toEqual([`${O}/gone`]);
    expect((await listWebsiteLinks(db.supabase, ORG, "w", { tab: "read", q: "blog" })).total).toBe(2);
    expect((await listWebsiteLinks(db.supabase, "other-org", "w")).ok).toBe(false);
  });

  it("exclude a folder: its pages leave Aiden's knowledge; include one back: it waits to be read", async () => {
    const db = seed();
    const folder = await changeWebsiteLinks(db.supabase, ORG, "w", { exclude_url: `${O}/blog/one`, folder: true });
    expect(folder).toMatchObject({ ok: true, rules: [{ op: "starts_with", value: "/blog/" }], forgotten: { pages: 2, products: 0 } });
    expect(db.rows("knowledge_documents").map((d) => d["id"]).sort()).toEqual(["d1", "d4"]);
    const ex = await listWebsiteLinks(db.supabase, ORG, "w", { tab: "excluded" });
    expect(ex.rows.map((r) => r.url)).toEqual([`${O}/blog/one`, `${O}/blog/two`]);

    const back = await changeWebsiteLinks(db.supabase, ORG, "w", { include_url: `${O}/blog/two` });
    expect(back).toMatchObject({ ok: true, waiting: 1 });
    expect(cfg(db, "w")["include_urls"]).toEqual([`${O}/blog/two`]);
    expect(db.rows("knowledge_urls").find((u) => u["url"] === `${O}/blog/two`)!["status"]).toBe("unread");

    // Excluding a product link hides the product too.
    const product = await changeWebsiteLinks(db.supabase, ORG, "w", { exclude_url: `${O}/products/ring` });
    expect(product.forgotten).toEqual({ pages: 1, products: 1 });
    expect(db.rows("products")[0]!["is_visible"]).toBe(false);

    // Removing the rule lets the folder back in.
    const removed = await changeWebsiteLinks(db.supabase, ORG, "w", { remove_rule: { op: "starts_with", value: "/blog/" } });
    expect(removed.rules).toEqual([{ op: "exact", value: "/products/ring" }]);
    expect(db.rows("knowledge_urls").find((u) => u["url"] === `${O}/blog/one`)!["status"]).toBe("unread");
  });

  it("a rule by hand; another site's link is refused", async () => {
    const db = seed();
    const r = await changeWebsiteLinks(db.supabase, ORG, "w", { exclude: { op: "contains", value: "two" } });
    expect(r.forgotten).toEqual({ pages: 1, products: 0 });
    expect((await changeWebsiteLinks(db.supabase, ORG, "w", { exclude_url: "https://other.example/x" })).ok).toBe(false);
    expect((await changeWebsiteLinks(db.supabase, ORG, "w", { exclude: { op: "starts_with", value: " " } })).ok).toBe(false);
  });

  it("change website address: same source, old address remembered, read queued; refused mid-read or for a marketplace", async () => {
    const db = seed();
    const changed = await changeWebsiteAddress(db.supabase, ORG, "w", "https://www.newshop.example/");
    expect(changed).toEqual({ ok: true, url: "https://www.newshop.example/" });
    const row = src(db, "w");
    expect(row).toMatchObject({ name: "www.newshop.example", status: "pending" });
    expect(cfg(db, "w")).toMatchObject({ url: "https://www.newshop.example/", previous_origins: [O], pages_done: 0 });
    expect(db.rows("knowledge_documents")).toHaveLength(4); // nothing lost
    row["status"] = "syncing";
    expect((await changeWebsiteAddress(db.supabase, ORG, "w", "https://x.example/")).ok).toBe(false);
    row["status"] = "ready";
    expect((await changeWebsiteAddress(db.supabase, ORG, "w", "https://www.instagram.com/shop")).ok).toBe(false);
    expect((await changeWebsiteAddress(db.supabase, ORG, "w", "http://localhost/")).ok).toBe(false);
  });
});

// --------------------------------------------------------- admin
describe("super admin: force full read", () => {
  it("queues every live website from scratch (any plan, no cooldown), optionally past the paid-page limit", async () => {
    const db = memoryDb({
      knowledge_sources: [
        { id: "a", organization_id: ORG, type: "website", status: "ready", config: { url: "https://a.example/", mode: "day0", refresh_started_at: "x" } },
        { id: "b", organization_id: ORG, type: "website", status: "syncing", config: { url: "https://b.example/" } },
        { id: "c", organization_id: ORG, type: "website", status: "disabled", config: { url: "https://c.example/", deleted_at: "2026-10-06" } },
        { id: "d", organization_id: ORG, type: "pdf", status: "ready", config: {} },
      ],
    });
    const result = await forceFullRead(db.supabase, ORG, { ignorePaidCaps: true, userId: "admin" });
    expect(result).toEqual({ queued: 1, skipped: 2 });
    const a = db.rows("knowledge_sources").find((r) => r["id"] === "a")!;
    expect(a["status"]).toBe("pending");
    expect(a["config"]).toMatchObject({ mode: "full", resume: false, pages_done: 0, force_paid: true });
    expect((a["config"] as Row)["refresh_started_at"]).toBeUndefined();
    expect(db.rows("activity_log")[0]).toMatchObject({ action: "reading_force_full" });
    const route = readFileSync("src/routes/api/admin/ai.ts", "utf8");
    expect(route).toContain('if (action === "reading_log" || action === "reading_force_full")');
  });
});
