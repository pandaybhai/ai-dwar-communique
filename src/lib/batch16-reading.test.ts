import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 16 item 7 — re-reading: the weekly changed-only re-read on paid
 * plans only, the free daily price check (a >50% move is flagged, never
 * applied), and the free check before a paid read of a browser-only page.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/whatsapp-webhook.server");
  vi.resetModules();
});

const page = (p: { name: string; price: number; availability?: string; image?: string }) =>
  `<html><head><title>${p.name}</title><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    image: p.image ?? "https://shop.example/img/a.jpg",
    offers: { "@type": "Offer", price: String(p.price), priceCurrency: "INR", availability: p.availability ?? "https://schema.org/InStock" },
  })}</script></head><body>${"x".repeat(300)}</body></html>`;

describe("(a) the weekly re-read: paid plans only, changed pages only", () => {
  it("a trial workspace's site is not queued; a paid one is, with changed_only", async () => {
    process.env["CRON_SECRET"] = "s";
    const old = new Date(Date.now() - 30 * 864e5).toISOString();
    const db = fakeDb((op: FakeOp) => {
      if (op.table === "platform_settings") return { data: { knowledge_auto_refresh: true, refresh_days: 7 }, error: null };
      if (op.table === "knowledge_sources" && op.kind === "select")
        return {
          data: [
            { id: "s-paid", organization_id: "org-paid", type: "website", refresh_days: null, last_synced_at: old, config: { url: "https://paid.example" }, status: "ready" },
            { id: "s-trial", organization_id: "org-trial", type: "website", refresh_days: null, last_synced_at: old, config: { url: "https://trial.example" }, status: "ready" },
          ],
          error: null,
        };
      if (op.table === "organizations") {
        const paid = op.filters.some(([n, a]) => n === "eq" && a[1] === "org-paid");
        return { data: paid ? { plan_version_id: "pv1", plan_status: "active" } : { plan_version_id: null, plan_status: "trialing" }, error: null };
      }
      if (op.table === "plan_versions") return { data: { limits: {}, plan_id: "p1" }, error: null };
      return undefined;
    });
    vi.doMock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => db.supabase }));
    const { Route } = await import("../routes/api/internal/knowledge-refresh");
    const post = (Route.options as unknown as { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }).server.handlers.POST;
    const res = await post({ request: new Request("https://x/api/internal/knowledge-refresh", { method: "POST", headers: { "x-cron-secret": "s" } }) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ queued: 1, trial_skipped: 1 });
    const updates = db.ops.filter((o) => o.table === "knowledge_sources" && o.kind === "update");
    expect(updates).toHaveLength(1);
    expect(db.has(updates[0]!, "eq", "id", "s-paid")).toBe(true);
    expect((updates[0]!.payload as { config: Record<string, unknown> }).config).toMatchObject({ refresh: true, changed_only: true });
  });

  it("the Knowledge screen promises a refresh only on a paid plan with it on", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/routes/api/ai/knowledge.ts", "utf8")).toMatch(/refresh_days: autoRefresh && plan\.paid \?/);
    expect(readFileSync("src/components/employee/knowledge-manager.tsx", "utf8")).toMatch(/automatic re-reading comes with a paid plan/);
  });
});

describe("(b) the free daily price check", () => {
  function world(products: Array<Record<string, unknown>>, on = true) {
    return fakeDb((op: FakeOp) => {
      if (op.table === "platform_settings") return { data: { price_check_daily: on }, error: null };
      if (op.table === "products" && op.kind === "select") return { data: products, error: null };
      return undefined;
    });
  }
  const architect = {
    id: "p-arch", organization_id: "org", title: "The Architect", sku: "ZLRG-0005", price: 26446,
    availability: "in_stock", image_url: "https://shop.example/img/a.jpg", product_url: "https://shop.example/p/architect",
  };

  it("a price that moved by more than 50% is flagged for review, never applied (The Architect ₹26,446 → ₹1,75,932)", async () => {
    const { runPriceCheck } = await import("./price-check.server");
    const db = world([architect]);
    const out = await runPriceCheck(db.supabase, { fetchHtml: async () => page({ name: "The Architect", price: 175932 }) });
    expect(out).toMatchObject({ checked: 1, flagged: 1, updated: 0 });
    const upd = db.ops.find((o) => o.table === "products" && o.kind === "update")!;
    const payload = upd.payload as Record<string, unknown>;
    expect(payload["price"]).toBeUndefined();
    expect(payload["price_review"]).toMatchObject({ old_price: 26446, new_price: 175932, url: architect.product_url });
    expect(payload["price_checked_at"]).toBeTruthy();
    // Admin sees it in the activity log.
    expect(db.ops.some((o) => o.table === "activity_log" && JSON.stringify(o.payload).includes("price_jump_flagged"))).toBe(true);
  });

  it("a normal move updates price, stock and photo (no AI, own fetch only)", async () => {
    const { runPriceCheck } = await import("./price-check.server");
    const db = world([architect]);
    const out = await runPriceCheck(db.supabase, {
      fetchHtml: async () => page({ name: "The Architect", price: 27999, availability: "https://schema.org/OutOfStock", image: "https://shop.example/img/new.jpg" }),
    });
    expect(out).toMatchObject({ checked: 1, flagged: 0, updated: 1 });
    expect(db.ops.find((o) => o.table === "products" && o.kind === "update")!.payload).toMatchObject({
      price: 27999,
      price_review: null,
      availability: "out_of_stock",
      image_url: "https://shop.example/img/new.jpg",
    });
  });

  it("off (or migration not applied): nothing is read", async () => {
    const { runPriceCheck } = await import("./price-check.server");
    const db = world([architect], false);
    const fetchHtml = vi.fn(async () => null);
    expect(await runPriceCheck(db.supabase, { fetchHtml })).toMatchObject({ skipped: "price_check_off", checked: 0 });
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("the merchant's call: use the new price or keep ours; the flag goes either way", async () => {
    const { resolvePriceReview } = await import("./price-check.server");
    const db = fakeDb((op) =>
      op.table === "products" && op.kind === "select" ? { data: { id: "p-arch", price_review: { new_price: 175932 } }, error: null } : undefined,
    );
    expect(await resolvePriceReview(db.supabase, "org", "p-arch", true)).toEqual({ ok: true });
    expect(db.ops.find((o) => o.kind === "update")!.payload).toEqual({ price_review: null, price: 175932 });
    const keep = fakeDb((op) =>
      op.table === "products" && op.kind === "select" ? { data: { id: "p-arch", price_review: { new_price: 175932 } }, error: null } : undefined,
    );
    await resolvePriceReview(keep.supabase, "org", "p-arch", false);
    expect(keep.ops.find((o) => o.kind === "update")!.payload).toEqual({ price_review: null });
  });
});

describe("(c) a browser-only page: the free signals first, the paid reader only when something changed", () => {
  it("compareSignals: same price and title → unchanged; a moved price → changed; nothing stated → unknown", async () => {
    const { compareSignals, pageSignals } = await import("./price-check.server");
    const signals = await pageSignals(page({ name: "The Architect", price: 26446 }), "https://shop.example/p/architect");
    expect(compareSignals(signals, { title: "The Architect", price: 26446 })).toBe("unchanged");
    expect(compareSignals(signals, { title: "the  architect", price: 26446.4 })).toBe("unchanged");
    expect(compareSignals(signals, { title: "The Architect", price: 24000 })).toBe("changed");
    expect(compareSignals(await pageSignals("<html>" + "x".repeat(400) + "</html>", "https://shop.example/p/x"), { title: "A", price: 1 })).toBe("unknown");
  });

  it("the crawl asks the paid reader only after the free check (source pin)", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("src/lib/knowledge.server.ts", "utf8");
    const at = code.indexOf("const readInRun");
    const body = code.slice(at, at + 1200);
    expect(body.indexOf("unchangedForFree(url)")).toBeGreaterThan(-1);
    expect(body.indexOf("unchangedForFree(url)")).toBeLessThan(body.indexOf("paidPages += 1"));
  });
});
