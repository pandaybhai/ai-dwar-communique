import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunMedia } from "@/lib/ai-run.server";
import type { productQueryOf } from "@/lib/flow-graph";
import type { ReplyTimer } from "@/lib/reply-timing";
import { formatPrice, isSkuLike, readableName } from "@/lib/product-facts";

/**
 * Flows v2 "Show products": no AI. The workspace's own products are searched
 * with the same search Aiden's catalogue tool uses, and each match goes out as
 * a picture with its name, price and link (the same pictures Aiden sends).
 * Nothing at that budget: the nearest real products are offered with their
 * real starting price. Nothing is ever made up.
 *
 * Newer, opt-in settings (a step saved without them searches and sends
 * exactly as before): a keyword the products' own words must have, the order
 * (cheapest / spread across the budget / newest), products with a photo
 * first, and coded titles shown by their readable name (product-facts.ts).
 */

export type ProductQuery = ReturnType<typeof productQueryOf>;

type Row = Record<string, unknown>;

/** A whole-unit price in the products' own currency ("₹25,000", "$1,250"). */
const money = (n: number, currency: unknown = "INR") => formatPrice(Math.floor(n), currency) ?? String(Math.floor(n));

/** "under ₹25,000", "between ₹25,000 and ₹50,000", "from ₹1,00,000", or "" — in the products' currency. */
export function budgetWords(q: Pick<ProductQuery, "minPrice" | "maxPrice">, currency: unknown = "INR"): string {
  if (q.minPrice !== null && q.maxPrice !== null) return `between ${money(q.minPrice, currency)} and ${money(q.maxPrice, currency)}`;
  if (q.maxPrice !== null) return `under ${money(q.maxPrice, currency)}`;
  if (q.minPrice !== null) return `from ${money(q.minPrice, currency)}`;
  return "";
}

/** How many products a step reads to pick photos first / spread across the budget from. */
export const PRODUCT_POOL = 100;

/** The step uses one of the newer settings (keyword, sort, photos first, readable names). */
function extended(q: ProductQuery): boolean {
  return Boolean(q.keyword || q.sort || q.photosFirst || q.readableNames);
}

/** The catalogue search arguments for a step's query. */
export function searchArgs(q: ProductQuery, shelf: string): Record<string, unknown> {
  // A step without the newer settings searches exactly as it always has.
  if (extended(q)) {
    const wide = Boolean(q.photosFirst) || q.sort === "spread";
    return {
      limit: wide ? PRODUCT_POOL : q.limit,
      ...(wide ? { pool: true } : {}),
      order: q.sort === "newest" ? "newest" : "price_asc",
      ...(shelf ? { category: q.category } : q.category ? { query: q.category } : {}),
      ...(q.keyword ? { keyword: q.keyword } : {}),
      ...(q.maxPrice !== null ? { max_price: q.maxPrice } : {}),
      ...(q.minPrice !== null ? { min_price: q.minPrice } : {}),
    };
  }
  return {
    limit: q.limit,
    // Cheapest first (the filters and the limit are unchanged).
    order: "price_asc",
    // A shelf the search knows filters by category; any other word is
    // searched for by name.
    ...(shelf ? { category: q.category } : q.category ? { query: q.category } : {}),
    ...(q.maxPrice !== null ? { max_price: q.maxPrice } : {}),
    ...(q.minPrice !== null ? { min_price: q.minPrice } : {}),
  };
}

const hasPhoto = (row: Row) =>
  typeof row["image_url"] === "string" && /^https?:\/\//i.test(row["image_url"].trim()) && Boolean(String(row["title"] ?? "").trim());

/** `n` rows evenly spaced over a price-ordered list: the cheapest, the dearest and steps between. */
export function spreadPick(rows: Row[], n: number): Row[] {
  if (rows.length <= n) return rows;
  if (n === 1) return [rows[Math.floor((rows.length - 1) / 2)]!];
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.round((i * (rows.length - 1)) / (n - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => rows[i]!);
}

/**
 * The step's own pick from what the search found: spread across the budget
 * or the first ones in order, products with a photo before text-only ones
 * (which only fill places the photos can't), at most `limit`.
 */
export function pickProducts(rows: Row[], q: ProductQuery): Row[] {
  const choose = (list: Row[], n: number) => (n <= 0 ? [] : q.sort === "spread" ? spreadPick(list, n) : list.slice(0, n));
  if (!q.photosFirst) return choose(rows, q.limit);
  const photos = choose(rows.filter(hasPhoto), q.limit);
  return [...photos, ...choose(rows.filter((r) => !hasPhoto(r)), q.limit - photos.length)];
}

/** A coded title ("AT-0207") as its readable name first, then the code: "Organic Cotton T-Shirt (AT-0207)". */
export function withReadableName(row: Row): Row {
  const title = String(row["title"] ?? "").trim();
  const sku = typeof row["sku"] === "string" ? row["sku"] : null;
  if (!title || !isSkuLike(title, sku)) return row;
  const name = readableName(row);
  return name ? { ...row, title: `${name} (${title})` } : row;
}

/**
 * Batch 16: a product known only by a code ("ZLRG-0014") and with no photo
 * tells a customer nothing — it is never sent. One with a photo, or a real
 * name, still goes.
 */
export function sendable(rows: Row[]): Row[] {
  return rows.filter((row) => {
    const title = String(row["title"] ?? "").trim();
    const sku = typeof row["sku"] === "string" ? row["sku"] : null;
    return hasPhoto(row) || !isSkuLike(title, sku);
  });
}

/** Rows → pictures (those with a picture) and plain lines (those without). */
function split(rows: Row[], collect: (rows: Row[], into: RunMedia[]) => void): { pictures: RunMedia[]; plain: Row[] } {
  const pictures: RunMedia[] = [];
  collect(rows, pictures);
  const shown = new Set(pictures.map((p) => p.title));
  return { pictures, plain: rows.filter((r) => !shown.has(String(r["title"] ?? "").trim()) && String(r["title"] ?? "").trim()) };
}

function plainLine(row: Row): string {
  const price = Number(row["price"]);
  const url = typeof row["product_url"] === "string" ? row["product_url"] : "";
  return `${String(row["title"]).trim()}${Number.isFinite(price) && price > 0 ? ` — ${money(price, row["currency"])}` : ""}${url ? `\n${url}` : ""}`;
}

export async function showProducts(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string | null;
    conversationId: string;
    to: string;
    phoneNumberId: string;
    accessToken: string;
    windowOpen: boolean;
    timer?: ReplyTimer;
    metadata: Record<string, unknown>;
    query: ProductQuery;
  },
): Promise<{ ok: boolean; found: boolean; shown: number; error: string | null }> {
  const { AI_TOOL_HANDLERS } = await import("@/lib/ai-tools.server");
  const { resolveShelf } = await import("@/lib/shop-categories");
  const { loadShopVocabulary } = await import("@/lib/shop-categories.server");
  const { collectProductMedia } = await import("@/lib/ai-run.server");
  const { enabledFlags } = await import("@/lib/feature-flags.server");
  const { sendProductPictures } = await import("@/lib/product-pictures.server");
  const { sendServiceText } = await import("@/lib/service-text.server");

  const q = args.query;
  // A shelf is one of this shop's own categories (or a word its settings
  // give for one); any other word is searched for by name — and, being the
  // kind of product asked for, never swapped for other products.
  const vocab = q.category ? await loadShopVocabulary(supabase, args.organizationId) : null;
  const shelf = vocab ? (resolveShelf(q.category, vocab)?.name ?? "") : "";
  const search = searchArgs(q, shelf);
  const result = await AI_TOOL_HANDLERS["catalogSearch"]!(
    { supabase, organizationId: args.organizationId, actorUserId: null, initiatedBy: "ai" },
    !shelf && search["query"] ? { ...search, query_is_category: true } : search,
  );
  if (!result.ok) return { ok: false, found: false, shown: 0, error: result.error ?? "product_search_failed" };

  const collect = (rows: Row[], into: RunMedia[]) => collectProductMedia("catalog_search", { ok: true, data: rows }, into);
  const sender = {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.to,
    windowOpen: args.windowOpen,
    ...(args.timer ? { timer: args.timer } : {}),
  };
  // The cards flag plus the Cards page switch (on unless the merchant turned it off).
  const { productCardsOn } = await import("@/lib/customer-cards.server");
  const cards = await productCardsOn(supabase, args.organizationId, await enabledFlags(supabase, args.organizationId).catch(() => new Set<string>()));
  let failure: string | null = null;
  const send = async (rows: Row[]): Promise<number> => {
    const { pictures, plain } = split(rows, collect);
    let shown = await sendProductPictures(supabase, {
      ...sender,
      contactId: args.contactId,
      items: pictures,
      cards,
      withLink: true,
      metadata: args.metadata,
      onFailure: (error) => (failure = error ?? "send_failed"),
    });
    if (plain.length > 0) {
      const res = await sendServiceText(supabase, { ...sender, body: plain.map(plainLine).join("\n\n"), metadata: args.metadata });
      if (res.ok) shown += plain.length;
      else failure = res.error ?? "send_failed";
    }
    return shown;
  };

  const named = (list: Row[]) => (q.readableNames ? list.map(withReadableName) : list);
  const found = sendable(Array.isArray(result.data) ? (result.data as Row[]) : []);
  const rows = named(extended(q) ? pickProducts(found, q) : found.slice(0, q.limit));
  if (rows.length > 0) {
    const shown = await send(rows);
    return shown > 0 ? { ok: true, found: true, shown, error: null } : { ok: false, found: true, shown: 0, error: failure ?? "send_failed" };
  }

  // Nothing matches: say what does exist and what it really costs.
  const data = (result.data ?? {}) as { closest_above?: Row[]; lowest_price?: number | null };
  const closest = named(sendable(data.closest_above ?? []).slice(0, Math.min(q.limit, 3)));
  const lowest = typeof data.lowest_price === "number" ? data.lowest_price : null;
  if (closest.length === 0 || lowest === null) return { ok: true, found: false, shown: 0, error: null };
  const shelfWord = (shelf || q.category || "products").toLowerCase();
  // The keyword was searched for too, so it is part of what we don't have.
  const keywords = (q.keyword ?? "").split(/,|\/|\bor\b|\|/).map((k) => k.trim().toLowerCase()).filter(Boolean);
  const word = keywords.length ? `${keywords.join(" or ")} ${shelfWord}` : shelfWord;
  const currency = closest.find((r) => typeof r["currency"] === "string" && r["currency"])?.["currency"];
  const budget = budgetWords(q, currency);
  const intro = await sendServiceText(supabase, {
    ...sender,
    body: `We don't have ${word}${budget ? ` ${budget}` : ""} right now — our ${word} start at ${money(lowest, currency)}. Here ${closest.length === 1 ? "is the closest one" : "are the closest ones"}:`,
    metadata: args.metadata,
  });
  if (!intro.ok) return { ok: false, found: false, shown: 0, error: intro.error ?? "send_failed" };
  const shown = await send(closest);
  return { ok: true, found: false, shown, error: null };
}
