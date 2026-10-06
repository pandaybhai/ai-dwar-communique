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
  /** What it is made of and a short line about it, as the page prints them. */
  description?: string | null;
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
  [/\bZERG|\bZERN/i, "earrings"],
  [/\bZNCK|\bZNEK/i, "necklaces"],
];

/** Product-name words that only ever mean one shelf. */
const TITLE_WORDS: Array<[RegExp, string]> = [
  [/\bstuds?\b|\bdrops\b|\bdanglers?\b|\bjhumk|\bhoops?\b/i, "earrings"],
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
  // A shelf that merely echoes the product name is the product, not a shelf.
  if (title && decode(title).toLowerCase().includes(clean)) return null;
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

/**
 * The shelf an item code names. Parts are read in the order given — the
 * product's own SKU first — so a reused photo's filename never outranks it
 * (myzoori.com: 24 ZERN earrings whose photos are named "zpnds-…" were saved
 * as pendants).
 */
function categoryFromCode(...parts: Array<string | null | undefined>): string | null {
  for (const part of parts) {
    if (!part) continue;
    for (const [pattern, word] of SKU_WORDS) if (pattern.test(part)) return word;
  }
  return null;
}

/**
 * A shelf word inside a product name or a page address ("Solitaire Ring",
 * /rings/solitaire). Only the fixed shelf words count — a name is never a shelf.
 */
function categoryWord(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join(" ").replace(/[-_/]+/g, " ");
  if (!text) return null;
  for (const [pattern, word] of [...CATEGORY_WORDS, ...TITLE_WORDS]) if (pattern.test(text)) return word;
  return null;
}

/** The page's own <title>: "Golden Petal || ZERN-0004" often carries the item code. */
function pageTitle(html: string): string | null {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return raw ? decode(raw) || null : null;
}

/** The page as lines of visible text, one line per paragraph, row or option. */
function textLines(html: string): string[] {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/<\/(?:p|li|div|tr|dd|h[1-6]|option|section|ul|ol|select|button)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => decode(line))
    .filter(Boolean);
}

const SPEC_RE =
  /^(metals?|material|purity|karat|carat|gold purity|stones?|gemstones?|diamond(?: quality)?|quality|gross weight|net weight|weight|finish|plating)\s*:\s*(.+)$/i;

/**
 * What the product is made of, as the page prints it: "Metal: Gold, Diamond",
 * "Gross weight: 1.05 gm", "Purity: 18K". Only labelled lines are kept —
 * nothing is guessed.
 */
function specLines(html: string): string[] {
  const lines = textLines(html);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && out.length < 4; i++) {
    const line = lines[i]!;
    const spec = line.match(SPEC_RE);
    if (spec) {
      const label = spec[1]!.toLowerCase();
      const value = spec[2]!.trim();
      if (seen.has(label) || value.length > 80 || /[₹{}<>]/.test(value)) continue;
      seen.add(label);
      out.push(`${spec[1]!.charAt(0).toUpperCase()}${spec[1]!.slice(1).toLowerCase()}: ${value}`);
    }
  }
  return out;
}

/**
 * A shop's own description, minus the theme's placeholder words ("Sort
 * Description", "Product Specification") and the item code. Too little left
 * means there was no real description.
 */
function cleanDescription(raw: unknown, title: string, sku: string | null): string | null {
  if (typeof raw !== "string") return null;
  let text = decode(raw.replace(/<[^>]+>/g, " "));
  if (sku) text = text.split(sku).join(" ");
  text = text
    .replace(/\b(?:product\s+)?(?:full|short|sort)?\s*(?:description|specification)(?:\s+(?:sort|short|full))?\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:|-]+|[\s,;:|-]+$/g, "")
    .trim();
  if (text.split(/\s+/).filter((word) => /[a-z]{2}/i.test(word)).length < 2) return null;
  if (text.toLowerCase() === title.trim().toLowerCase()) return null;
  return text.slice(0, 300);
}

const MALE_WORDS = /for\s*him|\bgents?\b|\bmen(?:['’]s)?\b|\bmens\b|\bmale\b/i;
const FEMALE_WORDS = /for\s*her|\bladies\b|\bwomen(?:['’]s)?\b|\bwomens\b|\bfemale\b/i;

/**
 * Who a product is meant for, only when the shop says it in plain words —
 * its shelf, title, description or code ("Gents Ring", "for her",
 * "MENS-RING-01"). Both said, or neither: no guess (null). Stored as
 * "male" / "female", the words Aiden's search and the catalogue use.
 */
export function genderHint(...parts: Array<string | null | undefined>): "male" | "female" | null {
  const text = parts.filter(Boolean).join(" ").replace(/[_-]+/g, " ");
  if (!text) return null;
  const male = MALE_WORDS.test(text);
  const female = FEMALE_WORDS.test(text);
  if (male === female) return null;
  return male ? "male" : "female";
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
      description: cleanDescription(
        node["description"],
        title,
        typeof node["sku"] === "string" ? decode(node["sku"]) : null,
      ),
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
    description: cleanDescription(metaContent(html, "og:description"), title, null),
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

// --------------------------------------------- d) the product's own photo

/** "${img}" / "{{ image }}": a picture slot a script fills in, not a picture. */
const TEMPLATE_RE = /\$\{|\{\{|%7B%7B|\$%7B/i;
/** Site furniture, never a product photo. */
const FURNITURE_RE = /(?:^|[/_.-])(?:logos?|icons?|sprites?|favicon|loader|spinner|badges?|spacer)(?:[/_.-]|$)|\.svg$/i;

function usablePhoto(raw: unknown, pageUrl: string): string | null {
  if (typeof raw !== "string") return null;
  const text = decode(raw.replace(/\\\//g, "/")).trim();
  if (!text || TEMPLATE_RE.test(text)) return null;
  const url = absolute(text, pageUrl);
  if (!url) return null;
  const path = new URL(url).pathname;
  if (path === "/" || PLACEHOLDER_RE.test(path) || FURNITURE_RE.test(path)) return null;
  return url;
}

/** JSON-LD "image": a link, a list of links, or ImageObjects. */
function imageList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => imageList(v));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record["url"] ?? record["contentUrl"]];
  }
  return [value];
}

/** What names this product in a picture's address: its page id/slug and its SKU. */
function identityTokens(pageUrl: string, sku: string | null | undefined): string[] {
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokens: string[] = [];
  try {
    const last = decodeURIComponent(new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "");
    const slug = squash(last.replace(/\.(?:html?|php|aspx?)$/i, ""));
    // Long enough to name one product, not a word many products share.
    if (slug.length >= 8) tokens.push(slug);
  } catch {
    // An address we cannot read names nothing.
  }
  if (sku && squash(sku).length >= 5 && /[a-z]/.test(squash(sku)) && /\d/.test(squash(sku))) tokens.push(squash(sku));
  return tokens;
}

/** Class names shop themes give the big picture in a product's own gallery. */
const MAIN_IMAGE_CLASS_RE =
  /class=["'][^"']*\b(?:main[-_]?(?:swiper[-_]?)?image|product[-_](?:main|featured)[-_]image|featured[-_]image|wp-post-image|product__media-image)\b/i;
/** Where other products start: anything below this belongs to someone else. */
const OTHER_PRODUCTS_RE = /related products|you may also like|similar products|recommended for you|customers also/i;

/**
 * The main picture of this product's gallery. A picture counts only when its
 * address names this product (page id or SKU) or the theme marks it as the
 * main gallery picture above any "related products" block — a nearby picture
 * of another product is worse than none.
 */
function mainGalleryPhoto(html: string, pageUrl: string, sku: string | null | undefined): string | null {
  const tokens = identityTokens(pageUrl, sku);
  const named = (url: string) => {
    const squashed = url.toLowerCase().replace(/[^a-z0-9]/g, "");
    return tokens.some((t) => squashed.includes(t));
  };
  const candidates: Array<{ at: number; url: string; marked: boolean }> = [];
  // Galleries a script builds from a data attribute: data-images='["…","…"]'.
  for (const attr of html.matchAll(/data-(?:images|gallery|zoom-images?)=(["'])([\s\S]*?)\1/gi)) {
    const body = decode(attr[2] ?? "").replace(/\\\//g, "/");
    for (const link of body.matchAll(/(?:https?:)?\/\/[^"'\s,\]]+|\/[^"'\s,\]]+\.(?:jpe?g|png|webp|avif)/gi))
      candidates.push({ at: attr.index ?? 0, url: link[0], marked: false });
  }
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const markup = tag[0] ?? "";
    const marked = MAIN_IMAGE_CLASS_RE.test(markup);
    for (const name of ["data-zoom-image", "data-large_image", "data-src", "src"]) {
      const src = markup.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1];
      if (src) candidates.push({ at: tag.index ?? 0, url: src, marked });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  for (const c of candidates) {
    const url = usablePhoto(c.url, pageUrl);
    if (url && named(url)) return url;
  }
  const otherProductsAt = html.search(OTHER_PRODUCTS_RE);
  for (const c of candidates) {
    if (!c.marked) continue;
    if (otherProductsAt > -1 && c.at > otherProductsAt) break;
    const url = usablePhoto(c.url, pageUrl);
    if (url) return url;
  }
  return null;
}

/**
 * The product's photo as its own page publishes it: the social preview
 * (og:image), then the product's structured data, then the main picture of
 * its own gallery. Null when the page shows no photo of this product.
 */
export function productPagePhoto(html: string, pageUrl: string, sku?: string | null): string | null {
  if (!html) return null;
  const og = usablePhoto(metaContent(html, "og:image"), pageUrl);
  if (og) return og;
  for (const node of jsonLdNodes(html)) {
    if (!isProductNode(node) || !nameOf(node["name"])) continue;
    // Only the page's own product; later Product nodes are other products.
    for (const candidate of imageList(node["image"])) {
      const url = usablePhoto(candidate, pageUrl);
      if (url) return url;
    }
    break;
  }
  return mainGalleryPhoto(html, pageUrl, sku);
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

// ------------------------------------------------------- legal pages

/** Path segments that name a legal or policy page (terms, privacy, refunds…). */
const LEGAL_SEGMENT_RE =
  /^(?:terms|tos|tnc|t-?and-?c|terms[-_].*|privacy|privacy[-_].*|legal|disclaimer|imprint|cookies?|refunds?|returns?|returns?[-_](?:and[-_])?(?:refunds?|exchanges?)|shipping(?:[-_](?:info|information|and[-_]delivery))?|.*[-_]?polic(?:y|ies)(?:[-_].*)?)$/i;

/** A page title or heading that says it is a legal or policy page. */
const LEGAL_TITLE_RE =
  /\b(?:terms\s*(?:of\s*(?:service|use|sale)|(?:and|&)\s*conditions)|privacy\s*(?:policy|notice)|(?:refund|return|returns|shipping|delivery|cancellation|cookie)s?\s*(?:and\s*\w+\s*)?policy|limitation\s+of\s+liability|governing\s+law|indemnit(?:y|ies|ification))\b/i;

/** "7. Limitation of liability", "2.1) Refunds", "Section 4 Payment", "Clause 9 …". */
const NUMBERED_CLAUSE_RE = /^\s*(?:\(?\d{1,2}(?:\.\d{1,2})*[.)]|(?:section|clause|article)\s+\d{1,2}(?:\.\d{1,2})*\b[.:)]?)\s+\S/i;

/** True for a numbered clause heading — never a product name. */
export function looksLikeLegalClause(title: string | null | undefined): boolean {
  return NUMBERED_CLAUSE_RE.test(title ?? "");
}

/**
 * True for a terms / privacy / refund / shipping-policy page: products are
 * never read off one (its numbered clause headings and amounts look like a
 * product with a price).
 */
export function isLegalPage(pageUrl: string, html: string): boolean {
  try {
    const segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if (segments.some((s) => LEGAL_SEGMENT_RE.test(decodeURIComponent(s)))) return true;
  } catch {
    // not a URL we can read: judge by the page alone
  }
  const docTitle = pageTitle(html) ?? "";
  if (LEGAL_TITLE_RE.test(docTitle)) return true;
  const h1 = decode((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " "));
  return LEGAL_TITLE_RE.test(h1);
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
  // Terms, privacy, refund and shipping policies sell nothing.
  if (isLegalPage(pageUrl, html)) return null;
  const draft =
    fromJsonLd(html, pageUrl) ?? fromOpenGraph(html, pageUrl) ?? fromPageShape(html, pageUrl);
  if (!draft || !draft.title) return null;
  if (looksLikeLegalClause(draft.title)) return null;

  // Structured data without a price: the price printed beside this same
  // product's heading is the one the shop charges.
  if (draft.price === null) {
    const shape = fromPageShape(html, pageUrl);
    if (shape?.price != null && shape.title.toLowerCase() === draft.title.toLowerCase()) draft.price = shape.price;
  }

  draft.imageUrl =
    chooseImage(html, pageUrl, draft.imageUrl, priceAnchor(html, draft.price)) ??
    // Nothing the usual way: the main picture of this product's own gallery.
    productPagePhoto(html, pageUrl, draft.sku);

  const crumbs = breadcrumbText(html);
  const docTitle = pageTitle(html);
  draft.category =
    normalizeCategory(draft.category, draft.title) ??
    normalizeCategory(crumbs, draft.title) ??
    categoryFromReferrer(context.referrer ?? null, draft.title) ??
    categoryFromCode(draft.sku, draft.title, draft.imageUrl, docTitle) ??
    categoryWord(draft.title, docTitle, new URL(pageUrl).pathname) ??
    null;
  const about = [...specLines(html), ...(draft.description ? [draft.description] : [])];
  draft.description = about.length > 0 ? about.join(". ").replace(/\.\./g, ".").slice(0, 500) : null;
  draft.gender = genderHint(crumbs, context.referrer ?? null, draft.title, draft.description, draft.sku);

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

/**
 * The same rule one page at a time: a picture more than `limit` crawled
 * products already use is the shop's fallback graphic, so this product goes
 * without a picture rather than with the wrong one.
 */
export async function dropImageIfShared(
  supabase: SupabaseClient,
  organizationId: string,
  draft: ProductDraft,
  limit = 3,
): Promise<void> {
  if (!draft.imageUrl) return;
  const { count } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("source", CRAWL_SOURCE)
    .eq("image_url", draft.imageUrl)
    .neq("external_id", draft.externalId);
  if ((count ?? 0) >= limit) draft.imageUrl = null;
}

// ------------------------------------------------------------------ storing

const CRAWL_SOURCE = "crawl";

type PriorRow = { id: string; source: string; image_url?: string | null; gender?: string | null };

/**
 * The row a read should update for this product: the one at its page
 * address; else — only when the page gives a SKU — the product with that SKU.
 * One SKU is one product in a workspace (products_org_sku_unique_idx), so an
 * insert would be refused: that is how 11 Zoori rings read at www.… stayed on
 * their old no-www rows, never refreshed, for two weeks. That row is updated
 * and moved to the page's address. Without a SKU nothing changes (a moved
 * page gets a new row and the old one is hidden, Batch 13A).
 */
async function existingCrawlRow(
  supabase: SupabaseClient,
  organizationId: string,
  draft: ProductDraft,
): Promise<PriorRow | null> {
  const columns = "id, source, image_url, gender";
  const one = async (query: PromiseLike<{ data: unknown }>) => {
    const data = (await query).data;
    return data && !Array.isArray(data) ? (data as PriorRow) : null;
  };
  const exact = await one(
    supabase.from("products").select(columns).eq("organization_id", organizationId).eq("external_id", draft.externalId).maybeSingle(),
  );
  if (exact) return exact;
  const sku = (draft.sku ?? "").trim();
  if (!sku) return null;
  // Only a product new to this address costs this lookup.
  return one(
    supabase
      .from("products")
      .select(columns)
      .eq("organization_id", organizationId)
      .ilike("sku", sku.replace(/[\\%_]/g, (c) => `\\${c}`))
      .limit(1)
      .maybeSingle(),
  );
}

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
      description: draft.description ?? null,
      is_visible: true,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const prior = await existingCrawlRow(supabase, organizationId, draft);
    if (prior) {
      // A product a shop platform owns is never overwritten by a page read.
      if (prior.source !== CRAWL_SOURCE) continue;
      // A read that can't see a price, shelf, description or gender fills
      // nothing in and wipes nothing out: what the last read (or the owner)
      // set stays — Zoori's hand-set ZGRG/ZLRG genders survive a re-read.
      const update: Record<string, unknown> = { ...row };
      for (const key of ["price", "category", "description", "gender"] as const) if (update[key] == null) delete update[key];
      // A gender already set (by an owner or an earlier read) is never changed by a read.
      if (prior.gender) delete update["gender"];
      // A photo the product already has is never replaced or wiped by a read.
      if (prior.image_url) delete update["image_url"];
      const { error } = await supabase.from("products").update(update).eq("id", prior.id);
      if (!error) saved += 1;
      else console.error("[crawl] product update failed", draft.externalId, error.message);
    } else {
      const { error } = await supabase.from("products").insert(row);
      if (!error) saved += 1;
      // Never silent again: a refused insert (e.g. the per-workspace SKU
      // rule) left 11 Zoori rings stale for two weeks.
      else console.error("[crawl] product insert failed", draft.externalId, error.message);
    }
  }
  return saved;
}

type FetchHtml = (url: string) => Promise<string | null>;

async function fetchProductPage(url: string): Promise<string | null> {
  const res = await fetchWithTimeout(url, 10000);
  if (!res?.ok) return null;
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return null;
  return res.text().catch(() => null);
}

/**
 * Products the read found without a photo, whose saved row has none either:
 * open the product page itself (the full page, head included — a rendered
 * reader can drop og:image and structured data) and take the photo it
 * publishes. Never touches a product that already has a photo or that a shop
 * platform owns. Bounded per read; the next read carries on.
 */
export async function fillMissingPhotos(
  supabase: SupabaseClient,
  organizationId: string,
  drafts: ProductDraft[],
  opts: { fetchHtml?: FetchHtml; maxPages?: number; budgetMs?: number } = {},
): Promise<number> {
  const missing = drafts.filter((d) => !d.imageUrl);
  if (missing.length === 0) return 0;
  const known = new Map<string, { source: string; image_url: string | null }>();
  const ids = [...new Set(missing.map((d) => d.externalId))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from("products")
      .select("external_id, source, image_url")
      .eq("organization_id", organizationId)
      .in("external_id", ids.slice(i, i + 100));
    for (const row of (data ?? []) as Array<{ external_id: string; source: string; image_url: string | null }>)
      known.set(row.external_id, row);
  }
  const queue = missing
    .filter((d) => {
      const row = known.get(d.externalId);
      return !row || (row.source === CRAWL_SOURCE && !row.image_url);
    })
    .slice(0, opts.maxPages ?? 40);
  const fetchHtml = opts.fetchHtml ?? fetchProductPage;
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  let filled = 0;
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const draft = queue.shift();
      if (!draft) return;
      try {
        const html = await fetchHtml(draft.externalId);
        const photo = html ? productPagePhoto(html, draft.externalId, draft.sku) : null;
        if (photo) {
          draft.imageUrl = photo;
          filled += 1;
        }
      } catch {
        // One page we cannot open never stops the rest.
      }
    }
  });
  await Promise.all(workers);
  return filled;
}

/** The fields a refresh may fill on a crawled product — only ever when empty. */
const FILLABLE = ["image_url", "description", "category"] as const;
type Fillable = (typeof FILLABLE)[number];

export type FillReport = {
  /** Crawled products from this site that were missing something. */
  missing: number;
  /** Product pages opened for them. */
  checked: number;
  /** Products that got at least one field. */
  filled: number;
  fields: Record<Fillable, number>;
};

/**
 * "Refresh from website": crawled products from this site still missing a
 * photo, a description (the metal / stone / weight line) or a shelf get their
 * product page read again with today's extractor — even when the page text is
 * unchanged since the last read, because the page was last read by an older
 * extractor (or, before the page list existed, never re-read at all).
 *
 * Only empty fields are filled; a value a product already has is never
 * replaced (each write is guarded on the field still being empty). Only rows
 * the website reader saved — a shop platform's products are never touched,
 * nor a hidden row. The page is fetched directly for its HTML and nothing
 * goes into knowledge documents, so no text is re-embedded. Bounded per
 * refresh; the next refresh carries on.
 */
export async function fillMissingProductDetails(
  supabase: SupabaseClient,
  organizationId: string,
  origin: string,
  opts: { fetchHtml?: FetchHtml; maxPages?: number; budgetMs?: number } = {},
): Promise<FillReport> {
  const report: FillReport = { missing: 0, checked: 0, filled: 0, fields: { image_url: 0, description: 0, category: 0 } };
  const { data } = await supabase
    .from("products")
    .select("id, external_id, product_url, sku, image_url, description, category")
    .eq("organization_id", organizationId)
    .eq("source", CRAWL_SOURCE)
    .eq("is_visible", true)
    .like("product_url", `${origin}%`)
    .or("image_url.is.null,description.is.null,category.is.null")
    .order("updated_at", { ascending: true })
    .limit(1000);
  const rows = ((data ?? []) as Array<{
    id: string;
    external_id: string | null;
    product_url: string | null;
    sku: string | null;
    image_url: string | null;
    description: string | null;
    category: string | null;
  }>).filter((r) => r.product_url && FILLABLE.some((f) => !r[f]));
  report.missing = rows.length;
  if (rows.length === 0) return report;

  const queue = rows.slice(0, opts.maxPages ?? 200);
  const fetchHtml = opts.fetchHtml ?? fetchProductPage;
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const found: Array<{ row: (typeof rows)[number]; draft: ProductDraft }> = [];
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const row = queue.shift();
      if (!row) return;
      const url = row.product_url as string;
      try {
        const html = await fetchHtml(url);
        report.checked += 1;
        const draft = html ? extractProduct(html, url) : null;
        if (draft) found.push({ row, draft });
      } catch {
        // One page we cannot open never stops the rest.
      }
    }
  });
  await Promise.all(workers);

  // The shop's fallback graphic on many pages is not a product photo.
  dropSharedImages(found.map((f) => f.draft));

  for (const { row, draft } of found) {
    const values: Record<Fillable, string | null> = {
      image_url: draft.imageUrl,
      description: draft.description ?? null,
      category: draft.category,
    };
    const patch: Record<string, unknown> = {};
    for (const field of FILLABLE) if (!row[field] && values[field]) patch[field] = values[field];
    const keys = Object.keys(patch) as Fillable[];
    if (keys.length === 0) continue;
    let write = supabase
      .from("products")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("source", CRAWL_SOURCE);
    // Never overwrite: each field is written only while it is still empty.
    for (const field of keys) write = write.is(field, null);
    const { error } = await write;
    if (error) continue;
    report.filled += 1;
    for (const field of keys) report.fields[field] += 1;
  }
  return report;
}

/** Products from this site that the latest read no longer finds. */
export async function hideMissingCrawledProducts(
  supabase: SupabaseClient,
  organizationId: string,
  origin: string,
  read: { fullReadComplete: boolean; siteMap: Iterable<string>; gone: Iterable<string> },
): Promise<{ hidden: number; skipped: string | null; candidates: number }> {
  if (!read.fullReadComplete) return { hidden: 0, skipped: "partial_read", candidates: 0 };
  const { planForget } = await import("@/lib/forget-rules");
  const { data } = await supabase
    .from("products")
    .select("id, product_url")
    .eq("organization_id", organizationId)
    .eq("source", CRAWL_SOURCE)
    .eq("is_visible", true)
    .like("product_url", `${origin}%`)
    .limit(10000);
  const rows = ((data ?? []) as Array<{ id: string; product_url: string | null }>).filter((r) => r.product_url);
  const plan = planForget({
    existing: rows.map((r) => r.product_url as string),
    fullReadComplete: true,
    siteMap: read.siteMap,
    gone: read.gone,
  });
  if (plan.skipped === "over_cap") {
    console.error("[crawl] product hide skipped", JSON.stringify({ organizationId, origin, candidates: plan.candidates, total: rows.length }));
    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      user_id: null,
      action: "reading_forget_skipped",
      details: { kind: "products", origin, candidates: plan.candidates, total: rows.length },
    });
    return { hidden: 0, skipped: "over_cap", candidates: plan.candidates };
  }
  const remove = new Set(plan.remove);
  const ids = rows.filter((r) => remove.has(r.product_url as string)).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200)
    await supabase.from("products").update({ is_visible: false }).in("id", ids.slice(i, i + 200));
  return { hidden: ids.length, skipped: null, candidates: plan.candidates };
}

/**
 * A site that moved address (myzoori.com → www.myzoori.com) left its
 * products saved under the old one. After a completed full read on the new
 * address they are hidden — never deleted: at once when the same page is
 * saved under the new address, otherwise by the usual forget rule (gone or
 * off the site map, and never more than its share in one go).
 */
export async function hideAliasHostProducts(
  supabase: SupabaseClient,
  organizationId: string,
  origin: string,
  aliases: string[],
  read: { fullReadComplete: boolean; siteMap: Iterable<string>; gone: Iterable<string> },
): Promise<{ hidden: number; twins: number; skipped: string | null }> {
  if (!read.fullReadComplete || aliases.length === 0) return { hidden: 0, twins: 0, skipped: "partial_read" };
  const { planForget, normalizeRef } = await import("@/lib/forget-rules");
  const { canonicalPageUrl } = await import("@/lib/site-urls");
  const old: Array<{ id: string; canonical: string }> = [];
  for (const alias of aliases) {
    if (alias === origin) continue;
    const { data } = await supabase
      .from("products")
      .select("id, product_url")
      .eq("organization_id", organizationId)
      .eq("source", CRAWL_SOURCE)
      .eq("is_visible", true)
      .like("product_url", `${alias}/%`)
      .limit(10000);
    for (const row of (data ?? []) as Array<{ id: string; product_url: string | null }>) {
      if (!row.product_url) continue;
      try {
        if (new URL(row.product_url).origin !== alias) continue;
      } catch {
        continue;
      }
      const canonical = canonicalPageUrl(row.product_url, row.product_url, origin);
      if (canonical) old.push({ id: row.id, canonical });
    }
  }
  if (old.length === 0) return { hidden: 0, twins: 0, skipped: null };
  const { data: live } = await supabase
    .from("products")
    .select("external_id")
    .eq("organization_id", organizationId)
    .eq("source", CRAWL_SOURCE)
    .eq("is_visible", true)
    .like("product_url", `${origin}/%`)
    .limit(20000);
  const current = new Set(((live ?? []) as Array<{ external_id: string | null }>).map((r) => normalizeRef(r.external_id ?? "")));
  const twins = old.filter((o) => current.has(normalizeRef(o.canonical)));
  const rest = old.filter((o) => !current.has(normalizeRef(o.canonical)));
  const plan = planForget({ existing: rest.map((r) => r.canonical), fullReadComplete: true, siteMap: read.siteMap, gone: read.gone });
  const remove = new Set(plan.skipped ? [] : plan.remove);
  const ids = [...twins.map((t) => t.id), ...rest.filter((r) => remove.has(r.canonical)).map((r) => r.id)];
  for (let i = 0; i < ids.length; i += 200)
    await supabase.from("products").update({ is_visible: false }).in("id", ids.slice(i, i + 200));
  return { hidden: ids.length, twins: twins.length, skipped: plan.skipped };
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
  await fillMissingPhotos(supabase, source.organization_id, drafts).catch(() => 0);
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
