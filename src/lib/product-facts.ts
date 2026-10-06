/**
 * What Aiden is told about a product, and the one rule code applies to the
 * captions Aiden writes for product pictures. Pure functions, browser-safe.
 *
 * Code never writes a caption: the model does (send_products). Code only
 * makes sure a price or a link inside it is the product's own — a price that
 * isn't is replaced by the real one or taken out, never invented.
 */

type Row = Record<string, unknown>;

/** Longest a WhatsApp image caption may be. */
export const CAPTION_LIMIT = 1024;

const PRODUCT_NOUNS =
  /\b(rings?|bands?|pendants?|earrings?|studs?|jhumkas?|bracelets?|bangles?|kadas?|necklaces?|chains?|tanmaniyas?|mangalsutras?|anklets?|nose ?pins?|sets?)\b/i;

const SINGULAR: Record<string, string> = {
  rings: "Ring",
  pendants: "Pendant",
  earrings: "Earrings",
  bracelets: "Bracelet",
  necklaces: "Necklace",
  chains: "Chain",
  tanmaniya: "Tanmaniya",
  mangalsutra: "Mangalsutra",
  bangles: "Bangle",
};

/** Stone cuts and shapes: "Ruby Pear" is a ruby. */
const SHAPE_WORDS =
  /\s+(round|pear|marquise|princess|oval|cushion|baguette|heart|trillion|emerald cut|square|cabochon)\b/gi;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** "₹19,604" — whole rupees, Indian grouping. Null when there is no real price. */
export function rupees(value: unknown, currency: unknown = "INR"): string | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const code = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "INR";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

/** "ZERN-0188", "ZLRG - 0001": a code, not a name a customer can read. */
export function isSkuLike(title: string, sku?: string | null): boolean {
  const t = title.trim();
  if (!t) return true;
  if (sku && t.toLowerCase() === sku.trim().toLowerCase()) return true;
  return /^[A-Z]{1,6}\s*[-_/]?\s*\d{2,7}[A-Z]?$/i.test(t);
}

export type DescriptionFacts = {
  metal: string | null;
  stones: string[];
  purity: string | null;
  weight: string | null;
};

/** "Metal: Gold, Diamond, Ruby Pear. Gross weight: 2.35 gm. … Yellow Gold 18K" → its parts. */
export function descriptionFacts(description: unknown): DescriptionFacts {
  const text = str(description);
  const out: DescriptionFacts = { metal: null, stones: [], purity: null, weight: null };
  if (!text) return out;
  const materials = text.match(/\bmetals?\s*:\s*([^.\n]+)/i)?.[1] ?? "";
  for (const raw of materials
    .split(/,|\band\b|&/)
    .map((m) => m.trim())
    .filter(Boolean)) {
    if (/\b(gold|silver|platinum|brass|copper)\b/i.test(raw)) {
      if (!out.metal) out.metal = raw;
    } else {
      const stone = raw.replace(SHAPE_WORDS, "").trim();
      if (stone && !out.stones.some((s) => s.toLowerCase() === stone.toLowerCase()))
        out.stones.push(stone);
    }
  }
  if (!out.metal)
    out.metal = text.match(/\b((?:yellow|white|rose)\s+gold|gold|silver|platinum)\b/i)?.[1] ?? null;
  const purity = text.match(/\b(9|10|14|18|20|22|24)\s?(?:k|kt|karat|carat)\b/i)?.[1];
  out.purity = purity ? `${purity}K` : null;
  const weight = text.match(
    /\b(?:gross\s+|net\s+)?weight\s*:?\s*(\d+(?:\.\d+)?)\s*(gms?|grams?|g)\b/i,
  );
  out.weight = weight ? `${weight[1]} g` : null;
  return out;
}

/**
 * A readable name for a product whose title is only a code: built from the
 * description's own materials line ("Pink Sapphire & Diamond Gold Earrings"),
 * else the description's own "the … Earrings" phrase, else null.
 */
export function readableName(row: Row): string | null {
  const description = str(row["description"]);
  const category = str(row["category"]).toLowerCase();
  const noun =
    SINGULAR[category] ?? (category ? category[0]!.toUpperCase() + category.slice(1) : "");
  const facts = descriptionFacts(description);
  if (noun && /\bmetals?\s*:/i.test(description) && (facts.metal || facts.stones.length)) {
    const stones = facts.stones.slice(0, 3);
    const stoneWords =
      stones.length > 1
        ? `${stones.slice(0, -1).join(", ")} & ${stones[stones.length - 1]}`
        : (stones[0] ?? "");
    const metal = facts.metal ? facts.metal.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
    return [stoneWords, metal, noun].filter(Boolean).join(" ");
  }
  const phrase = description.match(/\bthe\s+((?:[A-Z][\w'’-]*|&)(?:\s+(?:[A-Z][\w'’-]*|&)){1,7})/);
  if (phrase && PRODUCT_NOUNS.test(phrase[1]!)) return phrase[1]!.trim();
  return null;
}

/**
 * The product as the model sees it in a tool result: every fact it may use,
 * prices in whole rupees, no raw picture address (pictures go through
 * send_products, never as a pasted link).
 */
export function productFacts(row: Row): Record<string, unknown> {
  const title = str(row["title"]);
  const sku = str(row["sku"]) || null;
  const facts = descriptionFacts(row["description"]);
  const image = str(row["image_url"]);
  const name = isSkuLike(title, sku) ? readableName(row) : null;
  const out: Record<string, unknown> = {
    product_id: row["id"] ?? null,
    title,
    ...(name ? { name } : {}),
    ...(sku ? { sku } : {}),
    category: str(row["category"]) || null,
    ...(str(row["gender"]) ? { gender: str(row["gender"]) } : {}),
    ...(facts.metal ? { metal: facts.metal } : {}),
    ...(facts.purity ? { purity: facts.purity } : {}),
    ...(facts.stones.length ? { stones: facts.stones } : {}),
    ...(facts.weight ? { weight: facts.weight } : {}),
    price: rupees(row["price"], row["currency"]),
    ...(rupees(row["compare_at_price"], row["currency"])
      ? { compare_at_price: rupees(row["compare_at_price"], row["currency"]) }
      : {}),
    ...(str(row["availability"]) ? { availability: str(row["availability"]) } : {}),
    link: str(row["product_url"]) || null,
    has_photo: /^https?:\/\//i.test(image),
  };
  return out;
}

// ---------------------------------------------------------------- captions

const MONEY = /(?:₹|\bRs\.?|\bINR)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|lakhs?|L)\b)?/g;
const LINK = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;

function moneyValue(token: string): number {
  const number = Number((token.match(/\d[\d,]*(?:\.\d+)?/)?.[0] ?? "").replace(/,/g, ""));
  if (/lakh|L\b/i.test(token.replace(/^\D*\d[\d,.]*/, ""))) return number * 100_000;
  if (/k\b/i.test(token.replace(/^\D*\d[\d,.]*/, ""))) return number * 1000;
  return number;
}

/** www/no-www, http/https, a trailing slash, a query or fragment: the same page. */
function sameLink(a: string, b: string): boolean {
  const norm = (u: string) =>
    u
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/\(\s*\)|\[\s*\]/g, "")
        .replace(/([([])\s+/g, "$1")
        .replace(/\s+([)\]])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/(?:\s*[—–\-|:,])+\s*$/g, "")
        .replace(/^\s*[—–\-|:,]+\s*/g, "")
        .trim(),
    )
    .filter((line, i, all) => line || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut to the limit at a line, then a sentence, then a word boundary — never mid-word. */
function fit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const cut = Math.max(head.lastIndexOf("\n"), head.search(/[.!?](?=[^.!?]*$)/) + 1);
  if (cut > limit * 0.5) return head.slice(0, cut).trim();
  const word = head.lastIndexOf(" ");
  return (word > 0 ? head.slice(0, word) : head).trim();
}

export type CaptionCheck = { caption: string; changes: string[] };

/**
 * The model's caption with every price and link made the product's own: a
 * price equal to the product's (or its compare-at price) after rounding is
 * written in whole rupees; a different price becomes the real one (when the
 * caption doesn't already carry it) or goes; a link that isn't the product's
 * page becomes it (or goes). Nothing else is touched, nothing is added.
 */
export function checkCaption(
  caption: string,
  product: {
    price?: unknown;
    compare_at_price?: unknown;
    currency?: unknown;
    product_url?: unknown;
  },
): CaptionCheck {
  const changes: string[] = [];
  const currency = product.currency;
  const real = rupees(product.price, currency);
  const allowed = [product.price, product.compare_at_price]
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.round(v));
  const url = str(product.product_url);

  let text = caption.replace(/\r/g, "");

  // Links first, so digits inside a link are never read as a price.
  const links: string[] = [];
  let linkReplaced = false;
  text = text.replace(LINK, (raw) => {
    const match = raw.replace(/[.,;:!?)\]]+$/, "");
    const rest = raw.slice(match.length);
    let keep = "";
    if (url && sameLink(match, url)) {
      keep = url;
      if (match !== url) changes.push("link_normalised");
    } else if (url && !linkReplaced && !links.includes(url) && !caption.includes(url)) {
      keep = url;
      linkReplaced = true;
      changes.push("link_replaced");
    } else {
      changes.push("link_removed");
    }
    if (keep) links.push(keep);
    return keep ? `\uE000${links.length - 1}\uE000${rest}` : rest;
  });

  const carriesReal = (text.match(MONEY) ?? []).some(
    (t) => allowed[0] !== undefined && Math.round(moneyValue(t)) === allowed[0],
  );
  let priceReplaced = false;
  text = text.replace(MONEY, (token) => {
    const value = Math.round(moneyValue(token));
    if (allowed.includes(value)) {
      const formatted = rupees(value, currency)!;
      if (formatted !== token.trim()) changes.push("price_rounded");
      return formatted;
    }
    if (real && !carriesReal && !priceReplaced) {
      priceReplaced = true;
      changes.push("price_replaced");
      return real;
    }
    changes.push("price_removed");
    return "";
  });

  text = text.replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)] ?? "");
  text = changes.length ? tidy(text) : text.trim();
  const fitted = fit(text, CAPTION_LIMIT);
  if (fitted !== text) changes.push("caption_shortened");
  return { caption: fitted, changes: Array.from(new Set(changes)) };
}
