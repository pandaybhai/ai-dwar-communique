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
  /** "men" / "women" when the shop says so, otherwise nothing. */
  gender: string | null;
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

/** The words a shop uses for its shelves, written the same way every time. */
const CATEGORY_WORDS: Array<[RegExp, string]> = [
  [/tanmaniya|tanmania|mangalsutra/i, "tanmaniya"],
  [/\bear[\s-]?ring/i, "earrings"],
  [/\bnecklace/i, "necklaces"],
  [/\bpendant|\bpendent/i, "pendants"],
  [/\bbracelet|\bbangle/i, "bracelets"],
  [/\bchain/i, "chains"],
  [/\bring/i, "rings"],
];

/** Coded item numbers some jewellers use instead of words. */
const SKU_WORDS: Array<[RegExp, string]> = [
  [/\bZ[A-Z]?LRG|\bZGRG|\bZLRG/i, "rings"],
  [/\bZPNDS?\b|\bZPND/i, "pendants"],
  [/\bZBSL/i, "bracelets"],
  [/\bZTNM/i, "tanmaniya"],
  [/\bZERG/i, "earrings"],
  [/\bZNCK/i, "necklaces"],
];

const ROUTE_WORDS =
  /^(home|shop|all|products?|product[-_ ]?details?|collections?|catalogue|catalog|listing|list|page|search|filter|new|sale|category|categories)$/i;

/**
 * A shelf name has to read like one. Anything that is really a page name, an
 * internal id or the product's own title is not a category.
 */
function normalizeCategory(raw: string | null | undefined, title?: string | null): string | null {
  if (!raw) return null;
  const text = decode(String(raw).replace(/[+%]/g, " ").replace(/[-_]+/g, " "));
  if (!text || text.length > 60) return null;
  for (const [pattern, word] of CATEGORY_WORDS) if (pattern.test(text)) return word;
  const clean = text.trim().toLowerCase();
  if (!/^[a-z][a-z '&]*$/.test(clean)) return null; // ids, codes, addresses
  if (clean.split(/\s+/).length > 3) return null;
  if (ROUTE_WORDS.test(clean)) return null;
  if (title && clean === decode(title).toLowerCase()) return null;
  return clean.slice(0, 80);
}

/** The trail a shop prints above a product: Home / Rings / This ring. */
function breadcrumbText(html: string): string | null {
  for (const node of jsonLdNodes(html)) {
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeof t === "string" && /breadcrumblist/i.test(t))) continue;
    const items = node["itemListElement"];
    if (!Array.isArray(items)) continue;
    const names = items
      .map((item) => nameOf((item as Record<string, unknown>)?.["name"] ?? (item as Record<string, unknown>)?.["item"]))
      .filter((name): name is string => Boolean(name));
    if (names.length > 1) return names.slice(0, -1).join(" ");
  }
  const block = html.match(
    /<(?:nav|ol|ul|div)[^>]*breadcrumb[^>]*>([\s\S]{0,1200}?)<\/(?:nav|ol|ul|div)>/i,
  );
  if (!block) return null;
  const text = decode((block[1] ?? "").replace(/<[^>]+>/g, " / "));
  if (!text) return null;
  // The last step of a trail is the product itself, not the shelf it sits on.
  const steps = text
    .split(/\s*(?:\/|›|»|>|\|)\s*/)
    .map((step) => step.trim())
    .filter(Boolean);
  const shelves = steps.slice(0, -1).filter((step) => !/^home$/i.test(step));
  return shelves.length > 0 ? (shelves[shelves.length - 1] ?? null) : null;
}

/** The listing page that pointed us here: /listing?categories[]=rings. */
function categoryFromReferrer(referrer: string | null | undefined, title?: string | null): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    for (const [key, value] of url.searchParams.entries()) {
      if (!/categor|collection|type|filter|shelf/i.test(key)) continue;
      const word = normalizeCategory(value, title);
      if (word) return word;
    }
    const parts = url.pathname.split("/").filter(Boolean).reverse();
    for (const part of parts) {
      const word = normalizeCategory(decodeURIComponent(part), title);
      if (word) return word;
    }
    return null;
  } catch {
    return null;
  }
}

function categoryFromCode(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return null;
  for (const [pattern, word] of SKU_WORDS) if (pattern.test(text)) return word;
  return null;
}

/** Who a shelf is meant for, when the shop says it out loud. */
function genderHint(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return null;
  if (/for\s*him|\bgents?\b|\bmen(?:'s)?\b|\bmens\b/i.test(text)) return "men";
  if (/for\s*her|\bladies\b|\bwomen(?:'s)?\b|\bwomens\b/i.test(text)) return "women";
  return null;
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
      category: nameOf(node["category"]),
      gender: null,
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
    category: null,
    gender: null,
    availability: soldOut(html) ? "out_of_stock" : "in_stock",
    sku: null,
    brand: metaContent(html, "og:site_name"),
  };
}

// ------------------------------------------------------------ c) Page shape

/** Pictures that stand in for a real one. */
const PLACEHOLDER_RE = /default|placeholder|no[-_]?image|noimage|coming[-_]?soon|dummy/i;

function imageCandidates(html: string): Array<{ at: number; url: string }> {
  const found: Array<{ at: number; url: string }> = [];
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const markup = tag[0] ?? "";
    const src =
      markup.match(/\bsrc=["']([^"']+)["']/i)?.[1] ??
      markup.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ??
      null;
    if (!src) continue;
    if (/logo|icon|sprite|badge|favicon|pixel|spacer/i.test(src)) continue;
    found.push({ at: tag.index ?? 0, url: src });
  }
  return found;
}

/**
 * The picture that belongs to this product: the one in its own gallery, which
 * is the picture sitting closest to its price. A big banner somewhere else on
 * the page is exactly the wrong answer, so size is never the test.
 */
function galleryImage(html: string, pageUrl: string, priceAt: number): string | null {
  const images = imageCandidates(html);
  if (images.length === 0) return null;
  let best: { url: string; distance: number } | null = null;
  for (const image of images) {
    const distance = Math.abs(image.at - priceAt);
    // Pictures stored under a product folder are its own by definition.
    const weighted = /\/products?\//i.test(image.url) ? distance / 4 : distance;
    if (!best || weighted < best.distance) best = { url: image.url, distance: weighted };
  }
  return absolute(best?.url ?? null, pageUrl);
}

/** JSON-LD picture, then the social preview, then the product's own gallery. */
function chooseImage(
  html: string,
  pageUrl: string,
  jsonLdImage: string | null,
  priceAt: number,
): string | null {
  const ordered = [jsonLdImage, metaContent(html, "og:image"), galleryImage(html, pageUrl, priceAt)];
  for (const candidate of ordered) {
    const url = absolute(candidate, pageUrl);
    if (!url) continue;
    if (PLACEHOLDER_RE.test(new URL(url).pathname)) continue;
    return url;
  }
  return null;
}

function fromPageShape(html: string, pageUrl: string): ProductDraft | null {
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  const all = Array.from(plain.matchAll(PRICE_RE));
  const distinct = new Set(all.map((m) => (m[1] ?? "").replace(/,/g, "")));
  // A wall of different prices is a listing page, not one product.
  if (distinct.size === 0 || distinct.size > 6) return null;

  // Shop themes put the product name in an <h1> or an <h2>; filter widgets and
  // section labels use the same tags, so the heading we want is the one with a
  // price beside it and only one.
  const headings = [
    ...Array.from(html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)),
    ...Array.from(html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)),
  ];

  for (const heading of headings) {
    const title = decode((heading[1] ?? "").replace(/<[^>]+>/g, " "));
    if (title.length < 2 || title.length > 200) continue;
    if (/^(price|filter|sort|categor|shop by|refine)/i.test(title)) continue;
    const at = html.indexOf(heading[0] ?? "");
    if (at < 0) continue;
    const near = Array.from(
      html
        .slice(Math.max(0, at - 300), at + (heading[0]?.length ?? 0) + 800)
        .replace(/<[^>]+>/g, " ")
        .matchAll(PRICE_RE),
    );
    const nearDistinct = new Set(near.map((m) => (m[1] ?? "").replace(/,/g, "")));
    if (nearDistinct.size !== 1) continue;

    return {
      externalId: pageUrl,
      title: title.slice(0, 300),
      price: toNumber(near[0]?.[1] ?? null),
      currency: "INR",
      imageUrl: null,
      productUrl: pageUrl,
      category: null,
      gender: null,
      availability: soldOut(html) ? "out_of_stock" : "in_stock",
      sku: null,
      brand: null,
    };
  }
  return null;
}

/** Where this page prints its price — the product's own corner of the page. */
function priceAnchor(html: string, price: number | null): number {
  if (price !== null) {
    const written = price % 1 === 0 ? String(price) : price.toFixed(2);
    const grouped = Number(written).toLocaleString("en-IN", {
      minimumFractionDigits: written.includes(".") ? 2 : 0,
    });
    for (const needle of [grouped, written]) {
      const at = html.indexOf(needle);
      if (at > -1) return at;
    }
  }
  // A fresh matcher: the shared one is used elsewhere at the same time.
  return new RegExp(PRICE_RE.source, "i").exec(html)?.index ?? 0;
}

export type ExtractContext = {
  /** The page that linked to this product — usually a category listing. */
  referrer?: string | null;
};

/** One product off one page, or nothing. First method that works wins. */
export function extractProduct(
  html: string,
  pageUrl: string,
  context: ExtractContext = {},
): ProductDraft | null {
  if (!html || html.length < 200) return null;
  const draft =
    fromJsonLd(html, pageUrl) ?? fromOpenGraph(html, pageUrl) ?? fromPageShape(html, pageUrl);
  if (!draft || !draft.title) return null;

  draft.imageUrl = chooseImage(html, pageUrl, draft.imageUrl, priceAnchor(html, draft.price));

  const crumbs = breadcrumbText(html);
  draft.category =
    normalizeCategory(draft.category, draft.title) ??
    normalizeCategory(crumbs, draft.title) ??
    categoryFromReferrer(context.referrer ?? null, draft.title) ??
    categoryFromCode(draft.sku, draft.title, draft.imageUrl) ??
    null;
  draft.gender = genderHint(crumbs, context.referrer ?? null, draft.title);

  if (draft.price === null && !draft.imageUrl) return null;
  return draft;
}

/**
 * One picture used on many pages is the shop's fallback graphic, not a
 * product photo. Better to send a product with no picture than the wrong one.
 */
export function dropSharedImages(drafts: ProductDraft[], limit = 3): void {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    if (!draft.imageUrl) continue;
    counts.set(draft.imageUrl, (counts.get(draft.imageUrl) ?? 0) + 1);
  }
  for (const draft of drafts) {
    if (draft.imageUrl && (counts.get(draft.imageUrl) ?? 0) > limit) draft.imageUrl = null;
  }
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
      gender: draft.gender,
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

/** Which listing page links to which product, read off the listing pages. */
async function referrerMap(listings: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const queue = [...listings];
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const page = queue.shift();
      if (!page) return;
      try {
        const res = await fetchWithTimeout(page, 10000);
        if (!res?.ok) continue;
        const html = await res.text().catch(() => "");
        for (const link of html.matchAll(/href=["']([^"']+)["']/gi)) {
          const href = absolute(decode(link[1] ?? ""), page);
          if (!href) continue;
          if (!/\/(?:products?|product[-_]detail(?:s)?|item|p)\/[^/]+\/?$/i.test(new URL(href).pathname))
            continue;
          if (!map.has(href)) map.set(href, page);
        }
      } catch {
        // A listing we cannot read simply teaches us nothing.
      }
    }
  });
  await Promise.all(workers);
  return map;
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
  /** Listing pages, so we can see which shelf each product was linked from. */
  const listings: string[] = [];
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
    else if (/listing|categor|collection|shop/i.test(ref)) listings.push(ref);
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

  const referrers = await referrerMap(listings.slice(0, 60));

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
        const draft = extractProduct(html, next, { referrer: referrers.get(next) ?? null });
        if (draft) drafts.push(draft);
      } catch {
        // One unreadable page never stops the rest.
      }
    }
  });
  await Promise.all(workers);
  dropSharedImages(drafts);

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
