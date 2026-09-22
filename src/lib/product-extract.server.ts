/**
 * Reading a shop that has no catalogue feed.
 *
 * Big platforms hand us their catalogue as data. Everyone else only has their
 * own pages, so we read one product off a product page the same way a person
 * would: the structured data if the page publishes any, the social preview
 * tags if not, and finally the plain shape of the page — one price next to one
 * heading with one picture. Nothing here asks a model anything.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "@/lib/web-reader.server";

export type ProductDraft = {
  /** Canonical page address — the key this product is remembered by. */
  externalId: string;
  title: string;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  productUrl: string;
  category: string | null;
  availability: "in_stock" | "out_of_stock";
  sku: string | null;
  brand: string | null;
};

const PRICE_RE = /(?:₹|Rs\.?|INR)\s*([\d][\d,]*(?:\.\d{1,2})?)/gi;

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[₹,\s]/g, "").replace(/^(?:Rs\.?|INR)/i, "");
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function absolute(href: string | null | undefined, pageUrl: string): string | null {
  if (!href || typeof href !== "string") return null;
  try {
    const url = new URL(href.trim(), pageUrl);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Category from the address: the segment before the product's own slug. */
function categoryFromUrl(pageUrl: string): string | null {
  try {
    const parts = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const parent = parts[parts.length - 2] ?? "";
    if (!parent || /^(products?|item|shop|p|collections?)$/i.test(parent)) return null;
    return decode(parent.replace(/[-_]+/g, " ")).slice(0, 80);
  } catch {
    return null;
  }
}

function soldOut(html: string): boolean {
  return /sold\s*out|out\s*of\s*stock|currently unavailable|"?OutOfStock"?/i.test(html);
}

// ------------------------------------------------------------- a) JSON-LD

function* jsonLdNodes(html: string): Generator<Record<string, unknown>> {
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse((block[1] ?? "").trim());
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
      } else if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (Array.isArray(record["@graph"])) stack.push(...(record["@graph"] as unknown[]));
        yield record;
      }
    }
  }
}

function isProductNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === "string" && /^product$/i.test(t.trim()));
}

function firstOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const offers = node["offers"];
  if (Array.isArray(offers)) return (offers[0] as Record<string, unknown>) ?? null;
  if (offers && typeof offers === "object") return offers as Record<string, unknown>;
  return null;
}

function nameOf(value: unknown): string | null {
  if (typeof value === "string") return decode(value) || null;
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>)["name"];
    if (typeof name === "string") return decode(name) || null;
  }
  return null;
}

function fromJsonLd(html: string, pageUrl: string): ProductDraft | null {
  for (const node of jsonLdNodes(html)) {
    if (!isProductNode(node)) continue;
    const title = nameOf(node["name"]);
    if (!title) continue;
    const offer = firstOffer(node);
    const price = toNumber(offer?.["price"] ?? offer?.["lowPrice"] ?? node["price"]);
    const image = node["image"];
    const imageRaw = Array.isArray(image)
      ? typeof image[0] === "string"
        ? image[0]
        : ((image[0] as Record<string, unknown> | undefined)?.["url"] as string | undefined)
      : typeof image === "string"
        ? image
        : ((image as Record<string, unknown> | undefined)?.["url"] as string | undefined);
    const availabilityRaw = String(offer?.["availability"] ?? "");
    return {
      externalId: pageUrl,
      title: title.slice(0, 300),
      price,
      currency: String(offer?.["priceCurrency"] ?? "INR").slice(0, 8) || "INR",
      imageUrl: absolute(imageRaw ?? null, pageUrl),
      productUrl: absolute(typeof node["url"] === "string" ? node["url"] : pageUrl, pageUrl) ?? pageUrl,
      category: nameOf(node["category"]) ?? categoryFromUrl(pageUrl),
      availability:
        /outofstock|soldout|discontinued/i.test(availabilityRaw) ||
        (!availabilityRaw && soldOut(html))
          ? "out_of_stock"
          : "in_stock",
      sku: typeof node["sku"] === "string" ? decode(node["sku"]).slice(0, 100) : null,
      brand: nameOf(node["brand"]),
    };
  }
  return null;
}

// ------------------------------------------------------- b) Open Graph tags

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[:]/g, "\\:")}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decode(content) : null;
}

function fromOpenGraph(html: string, pageUrl: string): ProductDraft | null {
  const type = metaContent(html, "og:type") ?? "";
  const amount = metaContent(html, "product:price:amount");
  if (!/product/i.test(type) && !amount) return null;
  const title = metaContent(html, "og:title");
  if (!title) return null;
  return {
    externalId: pageUrl,
    title: title.slice(0, 300),
    price: toNumber(amount),
    currency: (metaContent(html, "product:price:currency") ?? "INR").slice(0, 8),
    imageUrl: absolute(metaContent(html, "og:image"), pageUrl),
    productUrl: absolute(metaContent(html, "og:url"), pageUrl) ?? pageUrl,
    category: categoryFromUrl(pageUrl),
    availability: soldOut(html) ? "out_of_stock" : "in_stock",
    sku: null,
    brand: metaContent(html, "og:site_name"),
  };
}

// ------------------------------------------------------------ c) Page shape

/** The biggest picture in the body, ignoring logos, icons and tracking pixels. */
function largestImage(html: string, pageUrl: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const markup = tag[0] ?? "";
    const src =
      markup.match(/\bsrc=["']([^"']+)["']/i)?.[1] ??
      markup.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ??
      null;
    const url = absolute(src, pageUrl);
    if (!url) continue;
    if (/logo|icon|sprite|badge|favicon|pixel|placeholder/i.test(url)) continue;
    const width = Number(markup.match(/\bwidth=["']?(\d+)/i)?.[1] ?? 0);
    const height = Number(markup.match(/\bheight=["']?(\d+)/i)?.[1] ?? 0);
    const score = (width * height || width || 1) + (/\/products?\//i.test(url) ? 1_000_000 : 0);
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url ?? null;
}

function fromPageShape(html: string, pageUrl: string): ProductDraft | null {
  // The page's own headline: an <h1> when it has one, otherwise the first
  // <h2>, which is what most shop themes actually use for a product name.
  const headMatch =
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (!headMatch) return null;
  const title = decode((headMatch[1] ?? "").replace(/<[^>]+>/g, " "));
  if (title.length < 2) return null;

  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  const all = Array.from(plain.matchAll(PRICE_RE));
  const distinct = new Set(all.map((m) => (m[1] ?? "").replace(/,/g, "")));
  // A wall of different prices is a listing page, not one product.
  if (distinct.size === 0 || distinct.size > 6) return null;

  const headAt = html.indexOf(headMatch[0] ?? "");
  const window = html.slice(
    Math.max(0, headAt - 300),
    headAt + (headMatch[0]?.length ?? 0) + 800,
  );
  const near = Array.from(window.replace(/<[^>]+>/g, " ").matchAll(PRICE_RE));
  const nearDistinct = new Set(near.map((m) => (m[1] ?? "").replace(/,/g, "")));
  // Exactly one price belongs to this heading, or we can't tell which is its.
  if (nearDistinct.size !== 1) return null;

  const image = largestImage(html, pageUrl);
  if (!image) return null;

  return {
    externalId: pageUrl,
    title: title.slice(0, 300),
    price: toNumber(near[0]?.[1] ?? null),
    currency: "INR",
    imageUrl: image,
    productUrl: pageUrl,
    category: categoryFromUrl(pageUrl),
    availability: soldOut(html) ? "out_of_stock" : "in_stock",
    sku: null,
    brand: null,
  };
}

/** One product off one page, or nothing. First method that works wins. */
export function extractProduct(html: string, pageUrl: string): ProductDraft | null {
  if (!html || html.length < 200) return null;
  const draft = fromJsonLd(html, pageUrl) ?? fromOpenGraph(html, pageUrl) ?? fromPageShape(html, pageUrl);
  if (!draft || !draft.title) return null;
  if (draft.price === null && !draft.imageUrl) return null;
  return draft;
}

// ------------------------------------------------------------------ storing

const CRAWL_SOURCE = "crawl";

/**
 * Remember what a crawl found. Prices and stock move, so an existing row is
 * updated in place; a product the shop has taken down is hidden, never
 * deleted, so nothing an owner curated is lost.
 */
export async function saveCrawledProducts(
  supabase: SupabaseClient,
  organizationId: string,
  drafts: ProductDraft[],
): Promise<number> {
  if (drafts.length === 0) return 0;
  const unique = new Map<string, ProductDraft>();
  for (const draft of drafts) unique.set(draft.externalId, draft);

  let saved = 0;
  for (const draft of unique.values()) {
    const row = {
      organization_id: organizationId,
      source: CRAWL_SOURCE,
      external_id: draft.externalId,
      title: draft.title,
      price: draft.price,
      currency: draft.currency || "INR",
      image_url: draft.imageUrl,
      product_url: draft.productUrl,
      category: draft.category,
      availability: draft.availability,
      sku: draft.sku,
      brand: draft.brand,
      is_visible: true,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase
      .from("products")
      .select("id, source")
      .eq("organization_id", organizationId)
      .eq("external_id", draft.externalId)
      .maybeSingle();
    const prior = existing as { id: string; source: string } | null;
    if (prior) {
      // A product a shop platform owns is never overwritten by a page read.
      if (prior.source !== CRAWL_SOURCE) continue;
      const { error } = await supabase.from("products").update(row).eq("id", prior.id);
      if (!error) saved += 1;
    } else {
      const { error } = await supabase.from("products").insert(row);
      if (!error) saved += 1;
    }
  }
  return saved;
}

/** Products from this site that the latest read no longer finds. */
export async function hideMissingCrawledProducts(
  supabase: SupabaseClient,
  organizationId: string,
  origin: string,
  since: string,
): Promise<void> {
  await supabase
    .from("products")
    .update({ is_visible: false })
    .eq("organization_id", organizationId)
    .eq("source", CRAWL_SOURCE)
    .eq("is_visible", true)
    .lt("synced_at", since)
    .like("product_url", `${origin}%`);
}

/**
 * Fill the catalogue from a website we have already read. Product pages are
 * fetched again — only those — so a shop that was read before this existed
 * gets its products without a fresh crawl.
 */
export async function backfillProductsFromSource(
  supabase: SupabaseClient,
  sourceId: string,
  limit = 150,
): Promise<number> {
  const { data: sourceRow } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, config")
    .eq("id", sourceId)
    .maybeSingle();
  const source = sourceRow as {
    organization_id: string;
    type: string;
    config: Record<string, unknown> | null;
  } | null;
  if (!source || source.type !== "website") return 0;

  const { data } = await supabase
    .from("knowledge_documents")
    .select("source_ref, metadata")
    .eq("source_id", sourceId)
    .limit(5000);

  const candidates: string[] = [];
  for (const row of (data ?? []) as Array<{
    source_ref: string;
    metadata: Record<string, unknown> | null;
  }>) {
    const ref = row.source_ref;
    if (!/^https?:\/\//i.test(ref)) continue;
    const isProduct =
      (row.metadata ?? {})["kind"] === "product" ||
      /\/(?:products?|product[-_]detail(?:s)?|item|p)\/[^/]+\/?$/i.test(new URL(ref).pathname);
    if (isProduct) candidates.push(ref);
  }
  if (candidates.length === 0) return 0;

  // Anything read recently is left alone, so repeated presses keep going
  // forward through a large catalogue instead of redoing the same pages.
  const fresh = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: known } = await supabase
    .from("products")
    .select("external_id")
    .eq("organization_id", source.organization_id)
    .eq("source", CRAWL_SOURCE)
    .gt("synced_at", fresh)
    .limit(5000);
  const skip = new Set(
    ((known ?? []) as Array<{ external_id: string | null }>).map((r) => r.external_id ?? ""),
  );

  const queue = candidates.filter((url) => !skip.has(url)).slice(0, limit);
  const drafts: ProductDraft[] = [];
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        const res = await fetchWithTimeout(next, 10000);
        if (!res || !res.ok) continue;
        if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) continue;
        const html = await res.text().catch(() => "");
        const draft = extractProduct(html, next);
        if (draft) drafts.push(draft);
      } catch {
        // One unreadable page never stops the rest.
      }
    }
  });
  await Promise.all(workers);

  const saved = await saveCrawledProducts(supabase, source.organization_id, drafts);

  // Keep the count on the source honest so the Knowledge tab matches reality.
  let origin: string | null = null;
  try {
    origin = new URL(String(source.config?.["url"] ?? candidates[0] ?? "")).origin;
  } catch {
    origin = null;
  }
  if (origin) {
    const total = await countCrawledProducts(supabase, source.organization_id, origin);
    await supabase.from("knowledge_sources").update({ products_found: total }).eq("id", sourceId);
  }
  return saved;
}

/** How many products this site currently shows in the catalogue. */
export async function countCrawledProducts(
  supabase: SupabaseClient,
  organizationId: string,
  origin: string,
): Promise<number> {
  const { count } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("source", CRAWL_SOURCE)
    .eq("is_visible", true)
    .like("product_url", `${origin}%`);
  return count ?? 0;
}
