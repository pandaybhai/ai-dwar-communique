/**
 * Batch 40: the first glance at a business's website — its name, its logo
 * and its colour — so sign-up can show "this is you" seconds after the
 * address is typed. Pure (the server fetches the page with the reader's own
 * guarded fetch, site-peek.server.ts). Knows no kind of business: it reads
 * only what every website declares about itself.
 */

export type SiteBrand = {
  /** The address as typed, cleaned: https://host/… */
  url: string;
  host: string;
  name: string | null;
  logoUrl: string | null;
  /** #rrggbb, when the site declares a colour that is safe to paint with. */
  color: string | null;
  description: string | null;
};

/** "myshop.in", "www.myshop.in/about", "http://…" → a full https address, or null. */
export function normaliseSiteInput(raw: string): string | null {
  let text = String(raw ?? "").trim();
  if (!text || /\s/.test(text) || text.includes("@")) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/i.test(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const value = m?.[1] ?? m?.[2] ?? m?.[3];
  return value == null ? null : decode(value);
}

function meta(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const k = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (k === key) {
      const content = attr(tag, "content");
      if (content) return content;
    }
  }
  return null;
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A colour we can safely paint a border or a glow with: #rgb / #rrggbb. */
export function safeColor(raw: string | null): string | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  const short = value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (rgb) {
    const hex = rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"));
    return `#${hex.join("")}`;
  }
  return null;
}

/** White and near-white aren't a brand colour, just a background. */
function meaningful(color: string | null): string | null {
  if (!color) return null;
  const n = parseInt(color.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (min > 235) return null;
  if (max < 20) return null;
  return color;
}

function jsonLdLogo(html: string, base: string): string | null {
  for (const block of html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) ??
    []) {
    const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    const m = body.match(/"logo"\s*:\s*(?:"([^"]+)"|\{[^}]*"url"\s*:\s*"([^"]+)")/);
    const found = absolute(m?.[1] ?? m?.[2] ?? null, base);
    if (found) return found;
  }
  return null;
}

function bestIcon(html: string, base: string): string | null {
  let best: { href: string; score: number } | null = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!/\b(?:apple-touch-icon|icon)\b/.test(rel)) continue;
    const href = absolute(attr(tag, "href"), base);
    if (!href) continue;
    const size = Number((attr(tag, "sizes") ?? "").split("x")[0]) || 0;
    const score =
      (rel.includes("apple-touch-icon") ? 1000 : 0) +
      size +
      (/\.svg(?:$|\?)/i.test(href) ? 500 : 0);
    if (!best || score > best.score) best = { href, score };
  }
  return best?.href ?? null;
}

/** The business's name as the site says it: og:site_name, else the title's brand part. */
function siteName(html: string, host: string): string | null {
  const declared = meta(html, "og:site_name") ?? meta(html, "application-name");
  if (declared) return declared.slice(0, 80);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (!title) return null;
  const parts = title
    .split(/\s+[|–—\-·:]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const label =
    host
      .replace(/^www\./, "")
      .split(".")[0]
      ?.toLowerCase() ?? "";
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matching = parts.find(
    (p) => label && (squash(p).includes(label) || label.includes(squash(p))),
  );
  return (matching ?? parts[0] ?? title).slice(0, 80);
}

export function parseSiteBrand(html: string, pageUrl: string): SiteBrand {
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    host = pageUrl;
  }
  const description = meta(html, "og:description") ?? meta(html, "description");
  return {
    url: pageUrl,
    host,
    name: siteName(html, host),
    logoUrl: jsonLdLogo(html, pageUrl) ?? bestIcon(html, pageUrl),
    color: meaningful(
      safeColor(meta(html, "theme-color") ?? meta(html, "msapplication-tilecolor")),
    ),
    description: description ? description.slice(0, 200) : null,
  };
}

/** A name for the business when the site gave none: "my-shop.in" → "My Shop". */
export function nameFromHost(host: string): string {
  const label = host.replace(/^www\./, "").split(".")[0] ?? host;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
