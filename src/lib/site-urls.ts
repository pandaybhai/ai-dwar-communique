/**
 * One site, one identity.
 *
 * myzoori.com, www.myzoori.com, http:// and https://, "/about-us" and
 * "/about-us/" are the same pages to a customer. Every address the reader
 * meets — a sitemap entry, a link on a page, a product's own address — is
 * written one way, on the source's own origin, before it is queued or saved.
 *
 * Pure functions only: no network, no database.
 */

/** A host without "www.", lower-cased: the site's name whatever way it is written. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Same site: the same host once "www." is set aside (and the same port). */
export function sameSite(a: string | URL, b: string | URL): boolean {
  try {
    const x = typeof a === "string" ? new URL(a) : a;
    const y = typeof b === "string" ? new URL(b) : b;
    return bareHost(x.hostname) === bareHost(y.hostname) && x.port === y.port;
  } catch {
    return false;
  }
}

/** Campaign and click tags: never part of what a page is. */
const TRACKING_PARAM_RE = /^(?:utm_.*|gclid|fbclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid)$/i;
/**
 * A listing sorted by price and the same listing on page 4 are the same page
 * to a customer's question: price[min], sortBy, page=… and multi-value
 * filters (tags[]=…, subcategories[]=…) are dropped. Product addresses keep
 * their query.
 */
const LISTING_PARAM_RE =
  /^(?:price|sort|sort_by|sortby|order|orderby|page|paged|filter|ref|view|limit|per_page)(?:$|[._\-[])|\[/i;

/**
 * The one way this page's address is written on this site: the source's own
 * protocol and host (www or not, as the site itself uses), no fragment, no
 * tracking tags, no listing/filter variants, no trailing slash. Null for an
 * address on another site or one that isn't a web page address at all.
 */
export function canonicalPageUrl(
  href: string,
  base: string,
  origin: string,
  options: { keepQuery?: boolean } = {},
): string | null {
  try {
    // Links read straight out of markup can still carry "&amp;".
    const url = new URL(href.trim().replace(/&amp;/gi, "&"), base);
    const home = new URL(origin);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (bareHost(url.hostname) !== bareHost(home.hostname)) return null;
    // Only the default port is the same site; anything else is another server.
    if (url.port && url.port !== home.port) return null;
    url.protocol = home.protocol;
    url.host = home.host;
    url.hash = "";
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (TRACKING_PARAM_RE.test(key)) url.searchParams.delete(key);
    }
    if (!options.keepQuery && !/\/products?\//i.test(url.pathname)) {
      for (const key of Array.from(url.searchParams.keys())) {
        if (LISTING_PARAM_RE.test(key)) url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

/** The other ways a site's origin is written: http/https × www/no-www. */
export function aliasOrigins(origin: string): string[] {
  try {
    const home = new URL(origin);
    const bare = bareHost(home.hostname);
    const port = home.port ? `:${home.port}` : "";
    const all = ["https:", "http:"].flatMap((p) => [`${p}//${bare}${port}`, `${p}//www.${bare}${port}`]);
    return all.filter((o) => o !== home.origin);
  } catch {
    return [];
  }
}

export type SitemapEntry = { loc: string; lastmod: string | null };

function xmlText(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * One sitemap file: page entries, or (for a sitemap index) the sitemap files
 * it lists. Each entry keeps its lastmod so a later read can skip pages that
 * haven't changed.
 */
export function parseSitemap(xml: string): { isIndex: boolean; entries: SitemapEntry[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const tag = isIndex ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  const blocks = xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"));
  for (const block of blocks) {
    const body = block[1] ?? "";
    const loc = body.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1];
    if (!loc) continue;
    const lastmod = body.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1];
    entries.push({ loc: xmlText(loc), lastmod: lastmod ? xmlText(lastmod) : null });
  }
  // Odd files with <loc> but no <url> wrappers still list pages.
  if (entries.length === 0) {
    for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) entries.push({ loc: xmlText(m[1] ?? ""), lastmod: null });
  }
  return { isIndex, entries: entries.filter((e) => e.loc) };
}

/**
 * robots.txt: the paths closed to every robot (User-agent: *) and the
 * sitemaps it names. Sitemap lines are kept as written; the caller decides
 * which belong to this site (a "Sitemap: http://localhost/…" left over from a
 * developer's machine does not).
 */
export function parseRobots(body: string): { disallow: string[]; sitemaps: string[] } {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let applies = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.split("#")[0]?.trim() ?? "";
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (/^user-agent:/i.test(line)) applies = value === "*";
    else if (/^sitemap:/i.test(line)) {
      if (value) sitemaps.push(value);
    } else if (applies && /^disallow:/i.test(line)) {
      if (value) disallow.push(value);
    }
  }
  return { disallow, sitemaps };
}

/** The answers customers ask for most, and how their pages are usually named. */
export const COVERAGE_TOPICS = [
  { key: "faq", label: "FAQ", re: /\bfaqs?\b|frequently[\s-]asked|\/help(?![\w-])|questions/i },
  { key: "shipping", label: "Shipping", re: /shipping|delivery/i },
  { key: "returns", label: "Returns", re: /returns?\b|refunds?|exchanges?|cancellation/i },
  { key: "size_guide", label: "Size guide", re: /size[\s_-]?(?:guide|chart)|sizing/i },
  { key: "contact", label: "Contact/Store", re: /contact|\/stores?(?![\w-])|store[\s_-]?locator|\blocations?\b|find[\s_-]us|visit[\s_-]us/i },
] as const;

export type CoverageKey = (typeof COVERAGE_TOPICS)[number]["key"];

/** Which of those answers the pages we read cover, by their address or title. */
export function infoCoverage(pages: Array<{ url: string; title?: string | null }>): Record<CoverageKey, boolean> {
  const out = Object.fromEntries(COVERAGE_TOPICS.map((t) => [t.key, false])) as Record<CoverageKey, boolean>;
  for (const page of pages) {
    let path = page.url;
    try {
      path = decodeURIComponent(new URL(page.url).pathname);
    } catch {
      // not an address: judge by what we have
    }
    // A product's own page is never the shop's policy page.
    if (/\/(?:products?|product[-_]details?|item|p)\//i.test(path)) continue;
    const hay = `${path} ${page.title ?? ""}`;
    for (const topic of COVERAGE_TOPICS) if (!out[topic.key] && topic.re.test(hay)) out[topic.key] = true;
  }
  return out;
}
