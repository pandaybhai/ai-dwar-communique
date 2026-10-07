import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "./test-support/memory-db";
import { NOT_ARCHIVED_DUPLICATE } from "./catalog";

/**
 * Batch 21 item 4 — duplicate products (the same page under myzoori.com and
 * www.myzoori.com): the migration archives the extra row (status 'archived'
 * + hidden), the website reader updates the same page's row under any way of
 * writing its address, and an archived row is never brought back or shown.
 */

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const WWW = "https://www.myzoori.com/product-detail/a1";
const BARE = "https://myzoori.com/product-detail/a1";

const product = (over: Row): Row => ({
  organization_id: ORG,
  source: "crawl",
  title: "Pearl Ring",
  price: 18000,
  currency: "INR",
  image_url: "https://img/a1.jpg",
  category: "Rings",
  gender: "women",
  availability: "in_stock",
  sku: null,
  status: null,
  is_visible: true,
  ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  externalId: WWW,
  productUrl: WWW,
  title: "Pearl Ring",
  price: 19000,
  currency: "INR",
  imageUrl: null,
  category: null,
  gender: null,
  availability: "in_stock" as const,
  sku: null,
  brand: null,
  description: null,
  ...over,
});

describe("addressTwins", () => {
  it("lists the other spellings of one page address", async () => {
    const { addressTwins } = await import("./product-extract.server");
    const twins = addressTwins(WWW);
    expect(twins).toContain(BARE);
    expect(twins).toContain(`${BARE}/`);
    expect(twins).toContain("http://myzoori.com/product-detail/a1");
    expect(twins).toContain("http://www.myzoori.com/product-detail/a1/");
    expect(twins).not.toContain(WWW);
    expect(twins.length).toBe(7);
    // Query kept; path case kept (another path is another page); host case folded.
    expect(addressTwins("https://Shop.Example/p/Ring?id=7")).toContain("https://www.shop.example/p/Ring?id=7");
    expect(addressTwins("https://shop.example/p/Ring")).not.toContain("https://shop.example/p/ring");
    expect(addressTwins("not a url")).toEqual([]);
  });
});

describe("item 4 — the website reader keys a product on its page, however the address is written", () => {
  it("a page read at www.… updates the old no-www row and moves it there — no second row", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({ products: [product({ id: "old", external_id: BARE, product_url: BARE, is_visible: false })] });
    await saveCrawledProducts(db.supabase, ORG, [draft()]);
    const rows = db.rows("products");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id: "old", external_id: WWW, product_url: WWW, price: 19000 });
  });

  it("13A/15A rules hold on the twin: gender never changed, nothing blanked, the photo kept", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({ products: [product({ id: "old", external_id: `${BARE}/`, product_url: `${BARE}/`, sku: "ZLRG-0002" })] });
    await saveCrawledProducts(db.supabase, ORG, [draft({ gender: "men", price: null, category: null, imageUrl: "https://img/new.jpg", sku: "ZLRG-0002" })]);
    expect(db.rows("products")[0]).toMatchObject({ gender: "women", price: 18000, category: "Rings", image_url: "https://img/a1.jpg", sku: "ZLRG-0002" });
  });

  it("an archived duplicate is never chosen while the live row exists, and never brought back", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({
      products: [
        product({ id: "live", external_id: WWW, product_url: WWW, sku: "ZGRG-0005" }),
        product({ id: "dup", external_id: BARE, product_url: BARE, sku: "ZGRG-0005-1", status: "archived", is_visible: false, price: 1 }),
      ],
    });
    await saveCrawledProducts(db.supabase, ORG, [draft({ sku: "ZGRG-0005" })]);
    const byId = new Map(db.rows("products").map((r) => [r["id"], r]));
    expect(byId.get("live")).toMatchObject({ price: 19000, is_visible: true });
    expect(byId.get("dup")).toMatchObject({ status: "archived", is_visible: false, price: 1, external_id: BARE });
    expect(db.rows("products").length).toBe(2);
  });

  it("the page's own address held by an archived row: the live twin is updated where it is", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({
      products: [
        product({ id: "dup", external_id: WWW, product_url: WWW, status: "archived", is_visible: false, price: 1 }),
        product({ id: "live", external_id: BARE, product_url: BARE }),
      ],
    });
    await saveCrawledProducts(db.supabase, ORG, [draft()]);
    const byId = new Map(db.rows("products").map((r) => [r["id"], r]));
    expect(byId.get("live")).toMatchObject({ price: 19000, external_id: BARE, product_url: BARE });
    expect(byId.get("dup")).toMatchObject({ status: "archived", is_visible: false, price: 1 });
  });

  it("only an archived row for the page: left archived, nothing new inserted", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({ products: [product({ id: "dup", external_id: WWW, product_url: WWW, status: "archived", is_visible: false })] });
    const saved = await saveCrawledProducts(db.supabase, ORG, [draft()]);
    expect(saved).toBe(0);
    expect(db.rows("products")).toEqual([expect.objectContaining({ id: "dup", status: "archived", is_visible: false })]);
  });

  it("another workspace's row at the same address is never touched; a shop platform's row never overwritten", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({
      products: [
        product({ id: "theirs", organization_id: "other", external_id: BARE, product_url: BARE }),
        product({ id: "shopify", source: "shopify", external_id: BARE.replace("a1", "s1"), product_url: BARE.replace("a1", "s1") }),
      ],
    });
    await saveCrawledProducts(db.supabase, ORG, [draft(), draft({ externalId: WWW.replace("a1", "s1"), productUrl: WWW.replace("a1", "s1") })]);
    const byId = new Map(db.rows("products").map((r) => [r["id"], r]));
    expect(byId.get("theirs")).toMatchObject({ external_id: BARE, price: 18000 });
    expect(byId.get("shopify")).toMatchObject({ price: 18000, source: "shopify" });
    // Ours is a new row (the other workspace's isn't ours to move).
    expect(db.rows("products").filter((r) => r["organization_id"] === ORG && r["source"] === "crawl").map((r) => r["external_id"])).toEqual([WWW]);
  });
});

describe("item 4 — archived rows are left out everywhere", () => {
  const rows = () => [
    product({ id: "live", external_id: WWW, product_url: WWW, title: "Pearl Ring" }),
    product({ id: "dup", external_id: BARE, product_url: BARE, title: "Pearl Ring", status: "archived", is_visible: false }),
  ];

  it("Aiden's catalogue search and the flows' Show products never see one", async () => {
    vi.resetModules();
    const { AI_TOOL_HANDLERS } = await import("./ai-tools.server");
    const db = memoryDb({ products: rows() });
    const out = (await AI_TOOL_HANDLERS["catalogSearch"]!(
      { supabase: db.supabase, organizationId: ORG, actorUserId: null, initiatedBy: "ai" },
      { keyword: "Pearl", limit: 10 },
    )) as { items?: Array<{ id: string }>; products?: Array<{ id: string }> };
    const ids = JSON.stringify(out);
    expect(ids).toContain("live");
    expect(ids).not.toContain('"dup"');
  });

  it("the merchant's catalogue list and counts leave archived duplicates out (a visible Shopify 'archived' stays)", () => {
    // NOT (status = 'archived' AND is_visible = false)
    const pass = (r: Row) => NOT_ARCHIVED_DUPLICATE.split(",").some((part) => {
      const [col, op, ...v] = part.split(".");
      const value = v.join(".");
      if (op === "is") return r[col!] == null;
      if (op === "neq") return r[col!] != null && String(r[col!]) !== value;
      return String(r[col!]) === value;
    });
    expect(pass({ status: null, is_visible: false })).toBe(true);
    expect(pass({ status: "active", is_visible: true })).toBe(true);
    expect(pass({ status: "archived", is_visible: true })).toBe(true);
    expect(pass({ status: "archived", is_visible: false })).toBe(false);
    for (const file of ["components/catalog/catalog-view.tsx", "components/catalog/products-summary.tsx", "components/catalog/collections-view.tsx"]) {
      expect(readFileSync(resolve(import.meta.dirname, "..", file), "utf8")).toContain(".or(NOT_ARCHIVED_DUPLICATE)");
    }
  });
});

describe("item 4 — the migration (not applied)", () => {
  const sql = readFileSync(resolve(import.meta.dirname, "../../supabase/aidwar-migrations/20261051_batch21_archive_duplicate_products.sql"), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("never deletes, waits at most 5 s for a lock, never touches a shop platform's rows", () => {
    expect(code).toMatch(/SET lock_timeout = '5s'/);
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).toContain("source NOT IN ('shopify', 'meta_catalog')");
  });

  it("keeps the visible, then www, then un-suffixed SKU row; acts only when the kept row is visible; idempotent", () => {
    expect(code).toMatch(/ORDER BY is_visible DESC, is_www DESC, \(coalesce\(sku, ''\) ~ '-\[0-9\]\+\$'\) ASC/);
    expect(code).toContain("r.kept_visible");
    expect(code).toContain("coalesce(status, '') <> 'archived'");
    expect(code).toContain("SET status = 'archived', is_visible = false");
  });
});
