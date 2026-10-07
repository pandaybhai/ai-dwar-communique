/**
 * Batch 16 item 7 — the free daily price check, and the free "did this
 * browser-only page change?" check.
 *
 * Both read a product page's raw HTML with our own fetch (no AI, no paid
 * reader) and take only what the page states in its structured data
 * (structuredProduct: JSON-LD, then Open Graph product tags).
 *
 * Daily price check (runPriceCheck, nightly from knowledge-backfill, while
 * platform_settings.price_check_daily is on): a crawled product's price,
 * stock and photo follow its page. A price that moves by more than half
 * (PRICE_JUMP) is never applied: it is kept on products.price_review for
 * the merchant (Knowledge → "Prices to check") and logged for admin
 * (activity "price_jump_flagged"). Live: The Architect ZLRG-0005 ₹26,446 →
 * the site now says ₹1,75,932 for 1.38 g.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** A move larger than this share of the stored price is flagged, not applied. */
export const PRICE_JUMP = 0.5;
/** Products checked per nightly run, oldest-checked first. */
export const PRICE_CHECK_BATCH = 200;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML = 1_500_000;

export type PageSignals = {
  title: string | null;
  price: number | null;
  availability: "in_stock" | "out_of_stock" | null;
  imageUrl: string | null;
};

/** The page's own structured product data, or null when it states none. */
export async function pageSignals(html: string, url: string): Promise<PageSignals | null> {
  const { structuredProduct } = await import("@/lib/product-extract.server");
  const draft = structuredProduct(html, url);
  if (!draft) return null;
  return {
    title: draft.title?.trim() || null,
    price: typeof draft.price === "number" && draft.price > 0 ? draft.price : null,
    availability: draft.availability ?? null,
    imageUrl: draft.imageUrl && /^https?:\/\//i.test(draft.imageUrl) ? draft.imageUrl : null,
  };
}

/** Raw HTML with our own fetch (public addresses only), or null. */
export async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { guardedFetch } = await import("@/lib/safe-fetch.server");
    const res = await guardedFetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; AiDwarBot/1.0; +https://aidwar.in)", accept: "text/html" },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await res.text();
    return text.slice(0, MAX_HTML);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when the move from `stored` to `seen` is too large to apply without a person. */
export function isPriceJump(stored: number | null, seen: number): boolean {
  if (stored === null || !Number.isFinite(stored) || stored <= 0) return false;
  return Math.abs(seen - stored) / stored > PRICE_JUMP;
}

const sameTitle = (a: string | null, b: string | null) =>
  Boolean(a && b) && a!.trim().toLowerCase().replace(/\s+/g, " ") === b!.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * A browser-only page on a re-read: what the free raw HTML states against
 * what we saved. "unchanged" only when the page states a title and a price
 * and both match the saved product; anything else ("changed", "unknown")
 * still goes to the paid reader.
 */
export function compareSignals(
  signals: PageSignals | null,
  stored: { title: string | null; price: number | null } | null,
): "unchanged" | "changed" | "unknown" {
  if (!signals || !stored || signals.price === null || !signals.title) return "unknown";
  const priceSame = stored.price !== null && Math.abs(Number(stored.price) - signals.price) < 1;
  return priceSame && sameTitle(signals.title, stored.title) ? "unchanged" : "changed";
}

/** platform_settings.price_check_daily (a missing row or failed read = off). */
export async function loadPriceCheckDaily(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("platform_settings").select("price_check_daily").eq("id", true).maybeSingle();
    if (error) return false;
    return (data as { price_check_daily?: unknown } | null)?.price_check_daily === true;
  } catch {
    return false;
  }
}

type ProductRow = {
  id: string;
  organization_id: string;
  title: string | null;
  sku: string | null;
  price: number | null;
  availability: string | null;
  image_url: string | null;
  product_url: string;
};

export type PriceCheckResult = {
  checked: number;
  updated: number;
  flagged: number;
  unreadable: number;
  skipped?: string;
};

/**
 * One nightly pass: the crawled, visible products checked longest ago.
 * Never throws; a page that can't be read is just marked checked.
 */
export async function runPriceCheck(
  supabase: SupabaseClient,
  deps: { fetchHtml?: (url: string) => Promise<string | null>; now?: Date; limit?: number; force?: boolean } = {},
): Promise<PriceCheckResult> {
  const result: PriceCheckResult = { checked: 0, updated: 0, flagged: 0, unreadable: 0 };
  if (!deps.force && !(await loadPriceCheckDaily(supabase))) return { ...result, skipped: "price_check_off" };
  const now = (deps.now ?? new Date()).toISOString();
  const { data, error } = await supabase
    .from("products")
    .select("id, organization_id, title, sku, price, availability, image_url, product_url")
    .eq("source", "crawl")
    .eq("is_visible", true)
    .not("product_url", "is", null)
    .order("price_checked_at", { ascending: true, nullsFirst: true })
    .limit(deps.limit ?? PRICE_CHECK_BATCH);
  if (error) return { ...result, skipped: "products_read_failed" };
  const rows = (data ?? []) as ProductRow[];
  const read = deps.fetchHtml ?? fetchHtml;

  let next = 0;
  const worker = async () => {
    for (;;) {
      const row = rows[next++];
      if (!row) return;
      result.checked += 1;
      const html = await read(row.product_url);
      const signals = html ? await pageSignals(html, row.product_url) : null;
      const update: Record<string, unknown> = { price_checked_at: now };
      if (!signals) result.unreadable += 1;
      else {
        if (signals.price !== null && Number(row.price) !== signals.price) {
          if (isPriceJump(row.price, signals.price)) {
            update["price_review"] = { old_price: row.price, new_price: signals.price, url: row.product_url, seen_at: now };
            result.flagged += 1;
            try {
              const { logServerActivity } = await import("@/lib/whatsapp-api.server");
              await logServerActivity(supabase, row.organization_id, null, "price_jump_flagged", {
                product_id: row.id,
                title: row.title,
                sku: row.sku,
                old_price: row.price,
                new_price: signals.price,
                url: row.product_url,
              });
            } catch {
              // the review row is what matters
            }
          } else {
            update["price"] = signals.price;
            update["price_review"] = null;
          }
        }
        if (signals.availability && signals.availability !== row.availability) update["availability"] = signals.availability;
        if (signals.imageUrl && signals.imageUrl !== row.image_url) update["image_url"] = signals.imageUrl;
        if (Object.keys(update).some((k) => k === "price" || k === "availability" || k === "image_url")) result.updated += 1;
      }
      await supabase.from("products").update(update).eq("id", row.id);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log("[price-check]", JSON.stringify(result));
  return result;
}

/** Products whose page moved its price by more than half, waiting for the merchant. */
export async function priceReviews(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("products")
    .select("id, title, sku, price, product_url, image_url, price_review")
    .eq("organization_id", organizationId)
    .not("price_review", "is", null)
    .limit(100);
  if (error) return [];
  return (data ?? []) as Array<{ id: string; title: string; sku: string | null; price: number | null; product_url: string | null; image_url: string | null; price_review: { old_price: number | null; new_price: number; url: string; seen_at: string } }>;
}

/** The merchant's call: use the page's new price, or keep ours. Either way the flag goes. */
export async function resolvePriceReview(
  supabase: SupabaseClient,
  organizationId: string,
  productId: string,
  apply: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { data } = await supabase
    .from("products")
    .select("id, price_review")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const review = (data as { price_review?: { new_price?: number } | null } | null)?.price_review;
  if (!data || !review) return { ok: false, error: "Nothing to review for this product." };
  const update: Record<string, unknown> = { price_review: null };
  if (apply && typeof review.new_price === "number") update["price"] = review.new_price;
  const { error } = await supabase.from("products").update(update).eq("id", productId).eq("organization_id", organizationId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
