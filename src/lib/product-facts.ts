/**
 * What Aiden is told about a product, and the one rule code applies to the
 * captions Aiden writes for product pictures. Pure functions, browser-safe.
 *
 * Code never writes a caption: the model does (send_products). Code only
 * makes sure a price or a link inside it is the product's own — a price that
 * isn't is replaced by the real one or taken out, never invented.
 */

import { stem, tokensOf } from "@/lib/shop-categories";

type Row = Record<string, unknown>;

/** Longest a WhatsApp image caption may be. */
export const CAPTION_LIMIT = 1024;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The product's currency code; a product saved without one is in the platform's default, INR. */
export function currencyOf(currency: unknown): string {
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency.trim().toUpperCase())
    ? currency.trim().toUpperCase()
    : "INR";
}

/**
 * A price in whole units of the product's own currency: "₹19,604" (Indian
 * grouping for rupees), "$1,250", "€89". Null when there is no real price.
 */
export function formatPrice(value: unknown, currency: unknown = "INR"): string | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const code = currencyOf(currency);
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(Math.round(n));
  } catch {
    return `${code} ${new Intl.NumberFormat("en-US").format(Math.round(n))}`;
  }
}

/** The older name for formatPrice, kept for existing callers. */
export const rupees = formatPrice;

/** "ZERN-0188", "ZLRG - 0001": a code, not a name a customer can read. */
export function isSkuLike(title: string, sku?: string | null): boolean {
  const t = title.trim();
  if (!t) return true;
  if (sku && t.toLowerCase() === sku.trim().toLowerCase()) return true;
  return /^[A-Z]{1,6}\s*[-_/]?\s*\d{2,7}[A-Z]?$/i.test(t);
}

/** One labelled line of a product's description: "Metal: Gold, Diamond", "Material: Cotton". */
export type ProductDetail = { label: string; value: string };

const DETAIL_RE = /^([\p{L}][\p{L}\p{N} .&/()'’-]{0,38}?)\s*:\s*(.+)$/u;

/**
 * The labelled lines of a description, in order — whatever labels the shop
 * uses ("Metal: Gold, Diamond. Gross weight: 2.35 gm", "Material: Cotton.
 * Fit: Regular"). Nothing about one kind of product; unlabelled text is not
 * read as a fact.
 */
export function productDetails(description: unknown): ProductDetail[] {
  const text = str(description);
  if (!text) return [];
  const out: ProductDetail[] = [];
  for (const raw of text.split(/(?<=\.)\s+|\n+/)) {
    const part = raw.trim().replace(/\.$/, "").trim();
    const m = part.match(DETAIL_RE);
    if (!m) continue;
    const label = m[1]!.trim();
    const value = m[2]!.trim();
    if (!value || value.length > 120 || label.split(/\s+/).length > 4) continue;
    if (out.some((d) => d.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ label, value });
    if (out.length >= 6) break;
  }
  return out;
}

/** "Rings" → "Ring", "T-Shirts" → "T-Shirt", "Accessories" → "Accessory": one product of the shop's category. */
function nounOf(category: string): string {
  const name = category.trim().replace(/\p{L}+$/u, (word) => {
    const lower = word.toLowerCase();
    const one = stem(lower);
    if (one === lower) return word;
    return lower.endsWith("ies") ? `${word.slice(0, -3)}y` : word.slice(0, one.length);
  });
  return name.replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, c: string) => gap + c.toUpperCase());
}

const capitalise = (text: string) => text.replace(/(^|\s)(\p{L})/gu, (_, gap: string, c: string) => gap + c.toUpperCase());

/**
 * A readable name for a product whose title is only a code. The
 * description's own "the …" phrase when it names the product's category and
 * says at least what the description's first labelled line says and more
 * (ZERN-0207: "Metal: Gold, Diamond" but "the Zoori Ruby & Diamond Gold
 * Earrings"); else built from that line's values and the category ("Gold &
 * Diamond Ring", "Cotton T-Shirt"); else the phrase alone; else null. Only
 * the shop's own words — no list of materials or product kinds.
 */
export function readableName(row: Row): string | null {
  const description = str(row["description"]);
  const category = str(row["category"]);
  const noun = category ? nounOf(category) : "";
  const nounTokens = tokensOf(category);
  const phraseMatch = description.match(/\bthe\s+((?:[A-Z][\w'’-]*|&)(?:\s+(?:[A-Z][\w'’-]*|&)){1,7})/);
  const phraseTokens = phraseMatch ? tokensOf(phraseMatch[1]!) : [];
  const phrase =
    phraseMatch && nounTokens.length > 0 && phraseTokens.includes(nounTokens[nounTokens.length - 1]!)
      ? phraseMatch[1]!.trim()
      : null;
  // The description's first line, when it is a labelled one of plain words.
  const first = productDetails(description)[0];
  const values =
    first && description.startsWith(first.label) && !/\d/.test(first.value)
      ? first.value
          .split(/,|\band\b|&/)
          .map((v) => v.trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
  if (phrase && values.length) {
    const said = phraseTokens;
    const lineWords = tokensOf(values.join(" "));
    const coversLine = lineWords.every((w) => said.includes(w));
    const saysMore = said.some((w) => !lineWords.includes(w) && !nounTokens.includes(w) && /^\p{L}/u.test(w));
    if (coversLine && saysMore && said.length > lineWords.length + 1) return phrase;
  }
  if (noun && values.length) {
    const words =
      values.length > 1 ? `${values.slice(0, -1).join(", ")} & ${values[values.length - 1]}` : values[0]!;
    return `${capitalise(words)} ${noun}`;
  }
  return phrase;
}

/**
 * The product as the model sees it in a tool result: every fact it may use,
 * prices in whole units of its own currency, no raw picture address (pictures go through
 * send_products, never as a pasted link).
 */
export function productFacts(row: Row): Record<string, unknown> {
  const title = str(row["title"]);
  const sku = str(row["sku"]) || null;
  const details = productDetails(row["description"]);
  const image = str(row["image_url"]);
  const name = isSkuLike(title, sku) ? readableName(row) : null;
  const out: Record<string, unknown> = {
    product_id: row["id"] ?? null,
    title,
    ...(name ? { name } : {}),
    ...(sku ? { sku } : {}),
    category: str(row["category"]) || null,
    ...(str(row["gender"]) ? { gender: str(row["gender"]) } : {}),
    // The shop's own labelled details, as written ("Metal": "Gold, Diamond").
    ...(details.length ? { details: Object.fromEntries(details.map((d) => [d.label, d.value])) } : {}),
    price: formatPrice(row["price"], row["currency"]),
    ...(formatPrice(row["compare_at_price"], row["currency"])
      ? { compare_at_price: formatPrice(row["compare_at_price"], row["currency"]) }
      : {}),
    ...(str(row["availability"]) ? { availability: str(row["availability"]) } : {}),
    link: str(row["product_url"]) || null,
    has_photo: /^https?:\/\//i.test(image),
  };
  return out;
}

// ---------------------------------------------------------------- captions

/** A price as a caption writes it, in any common currency: "₹19,604", "Rs 500", "$1,250", "EUR 89", "2.5k". */
const MONEY =
  /(?:[₹$€£¥]|\bRs\.?|\b(?:INR|USD|EUR|GBP|AED|SGD|AUD|CAD|NZD|JPY|CNY|HKD|SAR|QAR|KWD|BHD|OMR|MYR|THB|IDR|PHP|ZAR|NGN|KES|LKR|NPR|BDT|PKR|CHF|SEK|NOK|DKK)\b)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|lakhs?|L)\b)?/g;
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
 * written in whole units of the product's currency; a different price becomes the real one (when the
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
  const real = formatPrice(product.price, currency);
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
      const formatted = formatPrice(value, currency)!;
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
