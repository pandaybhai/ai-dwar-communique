/**
 * What the AI employee knows.
 *
 * One connector interface: a source type returns documents. Chunking,
 * embedding, retrieval, the agent and the screens know nothing about where a
 * document came from, so a new origin is one new function in CONNECTORS and no
 * other change anywhere.
 *
 * Live facts — orders, stock, price, availability — are never stored here.
 * They are looked up at question time through the tool broker.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts, EMBEDDING_MODEL } from "@/lib/ai-run.server";
import {
  countCrawledProducts,
  dropImageIfShared,
  extractProduct,
  fillMissingPhotos,
  fillMissingProductDetails,
  hideAliasHostProducts,
  hideMissingCrawledProducts,
  saveCrawledProducts,
  type ProductDraft,
} from "@/lib/product-extract.server";
import {
  READER_COST,
  fetchWithTimeout,
  readPage,
  readPages,
  readerKey,
  stripHtml,
  MIN_MAIN_TEXT,
  type PageRead,
  type ReaderEngine,
} from "@/lib/web-reader.server";
import {
  aliasOrigins,
  canonicalPageUrl,
  coveredTopics,
  decideSwap,
  isExcluded,
  parseRobots,
  parseSitemap,
  readExcludeRules,
  sameSite,
  type CoverageKey,
  type ExcludeRule,
  type SitemapEntry,
} from "@/lib/site-urls";
import { type FirecrawlBudget } from "@/lib/firecrawl.server";
import type { TavilyBudget } from "@/lib/tavily.server";
import { responseUrl, urlBlocked } from "@/lib/safe-fetch.server";
import { logServerActivity } from "@/lib/whatsapp-api.server";

export type SourceType =
  | "website"
  | "pdf"
  | "spreadsheet"
  | "manual_qa"
  | "image"
  | "docx"
  /** Everything an owner sent on the merchant channel — one per workspace. */
  | "upload";

/** One normalised item, whatever its origin. */
export type KnowledgeDocument = {
  /** Stable within the source: a URL, a row number, a page number. */
  sourceRef: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type ConnectorContext = {
  supabase: SupabaseClient;
  organizationId: string;
  sourceId: string;
  config: Record<string, unknown>;
  onStage?: (stage: CrawlStage) => void;
  /** Epoch ms by which the run must be over (the worker's request ends then). */
  deadlineAt?: number;
};

export type Connector = (ctx: ConnectorContext) => Promise<KnowledgeDocument[]>;

export type CrawlStage =
  "discover" | "sitemap" | "fetch" | "reader" | "extract" | "facts" | "embed" | "finish";

// ------------------------------------------------------------------ helpers

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const DEFAULT_PAGE_CAP = 200;

/** Binary, code and feed assets are never useful customer knowledge. */
const ASSET_PATH_RE = /\.(?:css|m?js|json|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?)(?:$|\/)/i;

function isAssetUrl(url: string): boolean {
  try {
    return ASSET_PATH_RE.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf(". ", end);
      if (boundary > start + CHUNK_CHARS / 2) end = boundary + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter(Boolean);
}

// --------------------------------------------------------------- connectors

/** Tidy one candidate address: this site (www or not), written one way, not an asset. */
function normalizeUrl(href: string, base: string, origin: string, keepQuery = false): string | null {
  const url = canonicalPageUrl(href, base, origin, { keepQuery });
  if (!url || isAssetUrl(url)) return null;
  return url;
}

/** Sitemap files read per discovery (an index and the files it lists). */
const SITEMAP_FILES = 12;
/** Addresses kept from one site's sitemaps. */
const SITEMAP_ENTRIES = 20000;

/**
 * Discover before reading: robots.txt (the paths it closes and the sitemaps it
 * names on this site), then /sitemap.xml, sitemap indexes followed — bounded
 * in files and time. A Sitemap: line pointing anywhere else (another site, a
 * developer's localhost) is ignored and /sitemap.xml is used instead.
 */
export async function discoverSite(
  origin: string,
  options: { budgetMs?: number; /** "Use sitemap" with a sitemap address: read that file first. */ sitemapUrl?: string | null } = {},
): Promise<{ disallow: string[]; sitemap: SitemapEntry[] }> {
  const deadline = Date.now() + Math.max(options.budgetMs ?? 25_000, 2_000);
  const left = () => Math.max(deadline - Date.now(), 0);
  let disallow: string[] = [];
  const queue: string[] = [];
  const given = options.sitemapUrl ? canonicalPageUrl(options.sitemapUrl, origin, origin, { keepQuery: true }) : null;
  if (given) queue.push(given);
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, Math.min(8000, left()));
    if (res?.ok) {
      const robots = parseRobots(await res.text().catch(() => ""));
      disallow = robots.disallow;
      for (const named of robots.sitemaps) {
        const file = canonicalPageUrl(named, origin, origin, { keepQuery: true });
        if (file && !queue.includes(file)) queue.push(file);
      }
    }
  } catch {
    // No robots.txt: nothing is closed and nothing is named.
  }
  const fallback = `${origin}/sitemap.xml`;
  if (queue.length === 0) queue.push(fallback);

  const seenFiles = new Set<string>();
  const entries = new Map<string, SitemapEntry>();
  while (queue.length > 0 && seenFiles.size < SITEMAP_FILES && left() > 500) {
    const file = queue.shift()!;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const res = await fetchWithTimeout(file, Math.min(10_000, left()));
    if (res?.ok) {
      const parsed = parseSitemap(await res.text().catch(() => ""));
      for (const entry of parsed.entries) {
        if (parsed.isIndex) {
          const child = canonicalPageUrl(entry.loc, file, origin, { keepQuery: true });
          if (child && !seenFiles.has(child) && !/\.gz$/i.test(child)) queue.push(child);
          continue;
        }
        if (entries.size >= SITEMAP_ENTRIES) break;
        const loc = canonicalPageUrl(entry.loc, file, origin);
        if (loc && !entries.has(loc)) entries.set(loc, { loc, lastmod: entry.lastmod });
      }
    }
    // The named sitemaps gave nothing: the usual address is still worth a look.
    if (queue.length === 0 && entries.size === 0 && !seenFiles.has(fallback)) queue.push(fallback);
  }
  return { disallow, sitemap: Array.from(entries.values()) };
}

/**
 * Where the site's address really lands: myzoori.com answers with a redirect
 * to www.myzoori.com, so the source follows it rather than reading two pages
 * of a "different" site. Null when the address doesn't answer, lands on an
 * error, a private address or a marketplace/social page.
 */
export async function followSiteRedirect(url: string): Promise<string | null> {
  const res = await fetchWithTimeout(url, 10_000);
  if (!res) return null;
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) return null;
  const landed = responseUrl(res, url);
  if (urlBlocked(landed) || listingLabel(landed)) return null;
  try {
    const final = new URL(landed);
    final.hash = "";
    return final.toString();
  } catch {
    return null;
  }
}

/**
 * How many pages this workspace's plan allows us to read, and whether it is on
 * a paid plan at all. Trial workspaces get the shallow day-one read only.
 */
export async function planLimits(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ cap: number; paid: boolean; planId: string | null }> {
  const { data: org } = await supabase
    .from("organizations")
    .select("plan_version_id, plan_status")
    .eq("id", organizationId)
    .maybeSingle();
  const orgRow = (org ?? {}) as { plan_version_id?: string | null; plan_status?: string | null };
  let versionId = orgRow.plan_version_id ?? null;
  let paid = orgRow.plan_status === "active" && Boolean(versionId);

  if (!paid) {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("plan_version_id, status")
      .eq("organization_id", organizationId)
      .in("status", ["active", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const subRow = sub as { plan_version_id?: string | null } | null;
    if (subRow?.plan_version_id) {
      versionId = subRow.plan_version_id;
      paid = true;
    }
  }

  if (!versionId) return { cap: DEFAULT_PAGE_CAP, paid, planId: null };
  const { data: version } = await supabase
    .from("plan_versions")
    .select("limits, plan_id")
    .eq("id", versionId)
    .maybeSingle();
  const v = version as { limits?: Record<string, unknown>; plan_id?: string } | null;
  const limits = v?.limits ?? {};
  const planId = v?.plan_id ?? null;
  const { loadReadingSettings } = await import("@/lib/reading.server");
  const override = planId ? Number((await loadReadingSettings(supabase)).plan_page_overrides[planId] ?? 0) : 0;
  const pages = override > 0 ? override : Number(limits["pages"] ?? 0);
  return { cap: pages > 0 ? pages : DEFAULT_PAGE_CAP, paid, planId };
}

/** Which shop software runs this site, when we can tell. */
export function detectPlatform(
  html: string,
  headers: Record<string, string> = {},
): "shopify" | "woocommerce" | null {
  const headerBlob = Object.entries(headers)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  if (/cdn\.shopify\.com|Shopify\.theme|x-shopid/i.test(`${html} ${headerBlob}`)) return "shopify";
  if (/wp-content|woocommerce/i.test(html)) return "woocommerce";
  return null;
}


/**
 * Shops publish their whole catalogue as plain data. When we can see one, we
 * read it directly rather than scraping product pages one by one.
 */
async function commerceDocuments(
  origin: string,
  platform: "shopify" | "woocommerce",
  cap: number,
): Promise<KnowledgeDocument[]> {
  const docs: KnowledgeDocument[] = [];

  const push = (ref: string, title: string, content: string, metadata: Record<string, unknown>) => {
    if (docs.length >= cap || content.trim().length < 20) return;
    docs.push({
      sourceRef: ref,
      title: title.slice(0, 200),
      content: content.slice(0, 20000),
      metadata,
    });
  };

  if (platform === "shopify") {
    for (let page = 1; page <= 4 && docs.length < cap; page += 1) {
      const res = await fetchWithTimeout(`${origin}/products.json?limit=250&page=${page}`, 8000);
      if (!res || !res.ok) break;
      const json = (await res.json().catch(() => ({}))) as {
        products?: Array<Record<string, unknown>>;
      };
      const products = json.products ?? [];
      if (products.length === 0) break;
      for (const product of products) {
        const handle = String(product["handle"] ?? "");
        const title = String(product["title"] ?? handle);
        const body = stripHtml(String(product["body_html"] ?? "")).text;
        const variants = (product["variants"] as Array<Record<string, unknown>> | undefined) ?? [];
        const prices = variants
          .map((v) => Number(v["price"]))
          .filter((price) => Number.isFinite(price));
        const compareAtPrices = variants
          .map((v) => Number(v["compare_at_price"]))
          .filter((price) => Number.isFinite(price));
        const lines = variants.map(
          (v) =>
            `${String(v["title"] ?? "Default")}: ${String(v["price"] ?? "")} ${
              v["available"] === false ? "(out of stock)" : "(available)"
            }`,
        );
        const priceRange = prices.length > 0
          ? `${Math.min(...prices)}${Math.min(...prices) === Math.max(...prices) ? "" : `–${Math.max(...prices)}`}`
          : "";
        const compareAtPrice = compareAtPrices.length > 0 ? Math.max(...compareAtPrices) : null;
        const productUrl = `${origin}/products/${handle}`;
        push(
          productUrl,
          title,
          `${title}\nPrice: ${priceRange || "Not listed"}\nCompare-at price: ${compareAtPrice ?? "Not listed"}\nAvailability: ${variants.some((v) => v["available"] !== false) ? "Available" : "Out of stock"}\nVariants:\n${lines.join("\n")}\n${body.slice(0, 600)}\nProduct URL: ${productUrl}`,
          {
            kind: "product",
            price_range: priceRange || null,
            compare_at_price: compareAtPrice,
            available: variants.some((v) => v["available"] !== false),
            url: productUrl,
          },
        );
      }
      if (products.length < 250) break;
    }

    const extras = [
      "/policies/refund-policy",
      "/policies/shipping-policy",
      "/policies/privacy-policy",
      "/policies/terms-of-service",
      "/pages/about",
      "/pages/about-us",
      "/pages/contact",
      "/pages/contact-us",
    ];
    for (const path of extras) {
      if (docs.length >= cap) break;
      const res = await fetchWithTimeout(`${origin}${path}`, 8000);
      if (!res || !res.ok) continue;
      const { title, text } = stripHtml(await res.text().catch(() => ""));
      push(`${origin}${path}`, title || path, text, { url: `${origin}${path}` });
    }
    return docs;
  }

  {
    for (let page = 1; page <= 10 && docs.length < cap; page += 1) {
      const res = await fetchWithTimeout(
        `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`,
        8000,
      );
      if (!res || !res.ok) break;
      const products = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
      if (!Array.isArray(products) || products.length === 0) break;
      for (const product of products) {
        const title = String(product["name"] ?? "");
        const body = stripHtml(String(product["description"] ?? "")).text;
        const prices = (product["prices"] as Record<string, unknown> | undefined) ?? {};
        const price = prices["price"] ?? null;
        const link = String(product["permalink"] ?? `${origin}/?p=${String(product["id"] ?? "")}`);
        push(link, title, `${title}\n${body}\nPrice: ${String(price ?? "")}\n${link}`, {
          kind: "product",
          price,
          available: product["is_in_stock"] !== false,
          url: link,
        });
      }
      if (products.length < 100) break;
    }
  }

  return docs;
}

/**
 * Turn one long page into plain facts, keeping every number exactly as it was
 * written. Chunks made from facts retrieve far better than chunks made from
 * navigation menus and cookie notices.
 */
async function factsPass(
  supabase: SupabaseClient,
  organizationId: string,
  docs: KnowledgeDocument[],
): Promise<number> {
  const { executeRun } = await import("@/lib/ai-run.server");
  let cost = 0;
  for (const doc of docs) {
    if ((doc.metadata as Record<string, unknown> | undefined)?.["kind"] === "product") continue;
    if (doc.content.length <= 1500) continue;
    try {
      const run = await executeRun(supabase, {
        organizationId,
        task: "extract_facts",
        tier: "everyday",
        input: doc.content.slice(0, 16000),
        system:
          "Rewrite this page as 5–15 plain factual sentences about the business, keeping every number, " +
          "price, date, place and product name exactly as written. Skip navigation and legal boilerplate.",
        metadata: { purpose: "knowledge_facts" },
        billingExempt: true,
      });
      const output = (run.output ?? "").trim();
      if (output.length > 80) {
        // The summary leads, but the page text is always kept too: a summary
        // that drops a price must never be the only thing Aiden can find.
        doc.metadata = { ...(doc.metadata ?? {}), raw_excerpt: doc.content.slice(0, 2000), summarised: true };
        doc.content = `${output}\n\n${doc.content}`;
      }
      cost += run.costAmount ?? 0;
      const { meterAiUsage } = await import("@/lib/ai-run.server");
      await meterAiUsage(supabase, organizationId, "knowledge_facts", {
        costAmount: run.costAmount ?? 0,
        inputTokens: run.inputTokens ?? 0,
        outputTokens: run.outputTokens ?? 0,
      });
    } catch {
      // A page we couldn't summarise is still worth keeping as it was.
    }
  }
  return cost;
}

/** Resolves to null once `ms` have passed; the work itself is left to finish or fail on its own. */
async function withinTime<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(ms, 0));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What one read of one page needs to save it. */
type PageSaveContext = {
  supabase: SupabaseClient;
  organizationId: string;
  sourceId: string;
  origin: string;
  platform: string | null;
  /** How the page was reached, kept on knowledge_urls.read_via. */
  readVia: string;
  /** Turn long pages into plain facts first (the model is asked). */
  facts: boolean;
  /** Also for pages that carry a product (the day-one read always did). */
  factsOnProductPages: boolean;
  referrer?: string | null;
};

export type PageSaveResult = {
  /** The page's text was saved (or found unchanged) as a document. */
  saved: boolean;
  /** The product this page sells, saved to the catalogue. */
  product: ProductDraft | null;
  /** The page answered 404/410. */
  gone: boolean;
  /** Nothing could be read at all. */
  failed: boolean;
  title: string;
  chars: number;
  links: string[];
  /** What turning the page into facts cost (platform-paid, metered). */
  cost: number;
};

/**
 * One page, saved the moment it is read: its text as a document (chunks and
 * embeddings built now, or queued for the retry if that fails), its product
 * in the catalogue, and the address marked read. A run that stops after this
 * page has lost nothing it read.
 *
 * A page that comes back too thin never replaces the text we already had.
 */
export async function savePage(
  ctx: PageSaveContext,
  url: string,
  page: PageRead | null,
): Promise<PageSaveResult> {
  const { supabase, organizationId, sourceId } = ctx;
  const result: PageSaveResult = { saved: false, product: null, gone: false, failed: false, title: "", chars: 0, links: [], cost: 0 };
  const mark = async (via: string, title: string | null = null) => {
    await supabase.from("knowledge_urls").upsert(
      {
        organization_id: organizationId,
        source_id: sourceId,
        url,
        priority: (await import("@/lib/reading.server")).urlPriority(url, ctx.origin) ?? 0,
        status: "read",
        read_at: new Date().toISOString(),
        read_via: via,
        ...(title ? { title: title.slice(0, 300) } : {}),
      },
      { onConflict: "source_id,url" },
    );
  };
  if (!page) {
    result.failed = true;
    await mark("failed");
    return result;
  }
  if (page.status === 404 || page.status === 410) {
    result.gone = true;
    await mark("gone");
    return result;
  }
  if (!page.contentType?.toLowerCase().includes("text/html")) {
    await mark("skipped");
    return result;
  }
  result.links = page.links;
  result.title = page.title || new URL(url).pathname;
  result.chars = page.text.length;

  // One product, if this page is a product page. No extra fetch.
  let draft: ProductDraft | null = null;
  try {
    draft = extractProduct(page.html, url, { referrer: ctx.referrer ?? null });
  } catch {
    // Never let reading a price stop the read.
  }

  if (page.text.length > 200) {
    const doc: KnowledgeDocument = {
      sourceRef: url,
      title: result.title,
      content: page.text.slice(0, 40000),
      metadata: { url, platform: ctx.platform, engine: page.engine ?? "own", credits: page.credits ?? 0, chars: page.text.length },
    };
    if (ctx.facts && (!draft || ctx.factsOnProductPages)) result.cost += await factsPass(supabase, organizationId, [doc]);
    await upsertDocument(supabase, organizationId, sourceId, doc);
    result.saved = true;
  }

  if (draft) {
    try {
      // Found without a photo: take it from the product page itself.
      await fillMissingPhotos(supabase, organizationId, [draft]).catch(() => 0);
      await dropImageIfShared(supabase, organizationId, draft);
      await saveCrawledProducts(supabase, organizationId, [draft]);
      result.product = draft;
    } catch (error) {
      console.error("[crawl] product save failed", url, error instanceof Error ? error.message : String(error));
    }
  }
  await mark(ctx.readVia, page.title || null);
  return result;
}

/** Pages a full read takes with our own fetch, whatever the plan (a safety ceiling). */
const OWN_PAGE_CEILING = 5000;

/** What the live version of a website covers, taken when a full re-read starts. */
type LiveSnapshot = { topics: CoverageKey[]; products: number; categories: string[] };

/** Crawled products of this site, visible: how many and on which shelves. */
async function siteProducts(
  supabase: SupabaseClient,
  organizationId: string,
  origin: string,
  since: string | null = null,
): Promise<{ count: number; categories: string[] }> {
  let query = supabase
    .from("products")
    .select("category")
    .eq("organization_id", organizationId)
    .eq("source", "crawl")
    .eq("is_visible", true)
    .like("product_url", `${origin}%`);
  if (since) query = query.gte("synced_at", since);
  const { data } = await query.limit(20000);
  const rows = (data ?? []) as Array<{ category: string | null }>;
  const categories = Array.from(new Set(rows.map((r) => r.category).filter((c): c is string => Boolean(c)))).sort();
  return { count: rows.length, categories };
}

export async function liveSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  origin: string,
): Promise<LiveSnapshot> {
  const [{ data: docs }, products] = await Promise.all([
    supabase.from("knowledge_documents").select("source_ref, title").eq("source_id", sourceId).limit(5000),
    siteProducts(supabase, organizationId, origin),
  ]);
  const pages = ((docs ?? []) as Array<{ source_ref: string; title: string | null }>).map((d) => ({ url: d.source_ref, title: d.title }));
  return { topics: coveredTopics(pages), products: products.count, categories: products.categories };
}

/** What one full read (since it began) actually found. */
async function readOutcome(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  origin: string,
  since: string,
): Promise<{ topics: CoverageKey[]; products: number; categories: string[]; read: number; gone: number }> {
  const [{ data: rows }, products] = await Promise.all([
    supabase
      .from("knowledge_urls")
      .select("url, title, read_via")
      .eq("source_id", sourceId)
      .eq("status", "read")
      .gte("read_at", since)
      .limit(20000),
    siteProducts(supabase, organizationId, origin, since),
  ]);
  const read = (rows ?? []) as Array<{ url: string; title: string | null; read_via: string | null }>;
  const ok = read.filter((r) => !["gone", "failed", "skipped"].includes(r.read_via ?? ""));
  return {
    topics: coveredTopics(ok.map((r) => ({ url: r.url, title: r.title }))),
    products: products.count,
    categories: products.categories,
    read: read.length,
    gone: read.filter((r) => r.read_via === "gone" || r.read_via === "failed").length,
  };
}

export type SiteAlertKind = "host_changed" | "dead_links" | "new_category";

/**
 * The site changed in a way someone should look at (it moved address, many
 * pages stopped opening, a new shelf appeared): the owner hears on their
 * AiDwar chat, the platform admin through the admin notice queue, and the
 * activity log keeps it. At most once a day per source and kind. Never throws.
 */
export async function raiseSiteAlert(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  kind: SiteAlertKind,
  info: { site: string; detail: string },
): Promise<boolean> {
  try {
    const { data: recent } = await supabase
      .from("activity_log")
      .select("id, details")
      .eq("organization_id", organizationId)
      .eq("action", "reading_site_changed")
      .gte("created_at", new Date(Date.now() - 86_400_000).toISOString())
      .limit(50);
    const already = ((recent ?? []) as Array<{ details: Record<string, unknown> | null }>).some(
      (r) => r.details?.["source_id"] === sourceId && r.details?.["kind"] === kind,
    );
    if (already) return false;
    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      user_id: null,
      action: "reading_site_changed",
      details: { source_id: sourceId, kind, site: info.site, detail: info.detail },
    });
    const { notifyOwnerOnOnboardingChannel } = await import("@/lib/merchant-channel.server");
    await notifyOwnerOnOnboardingChannel(
      supabase,
      organizationId,
      `Heads up about your website: ${info.detail}. Have a look under Knowledge in your dashboard.`,
    ).catch(() => false);
    await supabase.from("billing_notifications").insert({
      organization_id: organizationId,
      audience: "admin",
      kind: "site_change_alert",
      channel: "whatsapp",
      payload: {
        headline: `a merchant's website changed (${kind.replace(/_/g, " ")})`,
        detail: info.detail,
        link: "https://aidwar.in/admin/aiden",
      },
    });
    return true;
  } catch (error) {
    console.error("[crawl] site alert failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Every address this source knows, with its sitemap date when the database keeps one. */
async function loadKnownUrls(
  supabase: SupabaseClient,
  sourceId: string,
): Promise<Array<{ url: string; priority: number | null; status: string; read_at: string | null; lastmod?: string | null }>> {
  const read = (columns: string) =>
    supabase.from("knowledge_urls").select(columns).eq("source_id", sourceId).limit(20000);
  let { data, error } = await read("url, priority, status, read_at, lastmod");
  // Until 20261018_knowledge_urls_lastmod.sql is applied there is no lastmod.
  if (error) ({ data, error } = await read("url, priority, status, read_at"));
  return (data ?? []) as unknown as Array<{ url: string; priority: number | null; status: string; read_at: string | null; lastmod?: string | null }>;
}

/** Keep each address's sitemap date. A quiet no-op until the lastmod column exists. */
async function saveLastmods(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  origin: string,
  lastmods: Map<string, string>,
): Promise<void> {
  const { urlPriority } = await import("@/lib/reading.server");
  const rows = Array.from(lastmods).map(([url, lastmod]) => ({
    organization_id: organizationId,
    source_id: sourceId,
    url,
    priority: urlPriority(url, origin) ?? 0,
    lastmod: Number.isFinite(Date.parse(lastmod)) ? new Date(Date.parse(lastmod)).toISOString() : null,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("knowledge_urls").upsert(rows.slice(i, i + 200), { onConflict: "source_id,url" });
    if (error) return;
  }
}

/** A worker run reads at most this many pages… */
const RUN_PAGE_CAP = 25;
/** …takes no new page after this long… */
const RUN_SOFT_MS = 60_000;
/** …and never runs longer than this, whatever a page is doing. */
const RUN_HARD_MS = 85_000;
/** One page, one engine: give up rather than hold the run. */
const PAGE_TIMEOUT_MS = 15_000;

/**
 * Reading a website.
 *
 * The day-one read is one pass of a few pages. A full read, a refresh and the
 * nightly backfill go in runs: each run reads at most RUN_PAGE_CAP pages or
 * ~60 s of work, saves every page as it goes, then marks the source to
 * resume and the worker picks it up again a minute later. Our own fetch reads
 * first; a paid reader is asked only for a page that came back nearly empty.
 */
const crawlWebsite: Connector = async ({ supabase, organizationId, sourceId, config: givenConfig, onStage, deadlineAt }) => {
  onStage?.("discover");
  let config: Record<string, unknown> = { ...givenConfig };
  const startUrl = String(config["url"] ?? "").trim();
  if (!startUrl) throw new Error("Add the address of the website first.");
  let start = new URL(startUrl);
  // Same guard as the Flows HTTP step: no private/internal addresses.
  if (urlBlocked(start.toString())) throw new Error("This address points to a private network and can't be read.");
  const runStarted = Date.now();
  const hardStop = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, runStarted + RUN_HARD_MS);
  const softStop = Math.min(runStarted + RUN_SOFT_MS, hardStop - 15_000);
  const timeLeft = () => hardStop - Date.now();

  const plan = await planLimits(supabase, organizationId);
  const { loadReadingSettings, urlPriority } = await import("@/lib/reading.server");
  const reading = await loadReadingSettings(supabase);
  const { engineOrder, mapSite } = await import("@/lib/web-reader.server");
  const settingsOrder = engineOrder(reading.reader_primary, reading.reader_fallback_order);
  const tavilyDepth = reading.tavily_extract_depth;
  // When the whole site is read is a platform setting (Reading tab).
  let autoFull = false;
  if (plan.paid && reading.full_crawl_trigger === "on_plan_active") autoFull = true;
  if (plan.paid && reading.full_crawl_trigger === "on_number_connected") {
    const { count } = await supabase
      .from("whatsapp_accounts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "active");
    autoFull = (count ?? 0) > 0;
  }
  const mode = config["mode"] === "full" || autoFull ? "full" : "day0";
  // "Read changes now" / scheduled refresh: re-read only pages already read.
  const refreshing = config["refresh"] === true;
  // App stores, social profiles, marketplaces, maps: that one page only.
  const singlePage = config["single_page"] === true;
  /** Read in runs (full read, refresh, backfill); the day-one read is one pass. */
  const staged = (mode === "full" || refreshing) && !singlePage;
  // How the merchant asked for the site to be found (Add website):
  // crawl from the homepage (sitemap, then links), the sitemap only, or
  // just the links they listed.
  const discovery: "crawl" | "sitemap" | "links" =
    config["discovery"] === "sitemap" || config["discovery"] === "links" ? config["discovery"] : "crawl";
  const listedLinks = Array.isArray(config["links"]) ? (config["links"] as unknown[]).map(String).slice(0, 500) : [];
  const keepQuery = config["keep_query"] === true;
  const excludeRules = readExcludeRules(config["exclude_rules"]);
  const includeUrls = Array.isArray(config["include_urls"]) ? (config["include_urls"] as unknown[]).map(String) : [];
  const excluded = (url: string) => isExcluded(url, excludeRules, includeUrls);
  /** "Re-read whole site" reads only pages whose sitemap date moved (the weekly refresh reads them all). */
  const changedOnly = refreshing && config["changed_only"] === true;
  const resuming = staged && !refreshing && config["resume"] === true;
  /** A refresh already under way (started on an earlier run). */
  const refreshStartedAt = refreshing && typeof config["refresh_started_at"] === "string"
    ? String(config["refresh_started_at"])
    : null;
  const continuing = resuming || refreshStartedAt !== null;

  // One site, one identity: the address follows the site's own redirect
  // (myzoori.com → www.myzoori.com) and the source is updated, not copied.
  if (!singlePage && !continuing) {
    const landed = await followSiteRedirect(start.toString()).catch(() => null);
    if (landed && new URL(landed).host !== start.host) {
      const from = start.origin;
      const previous = Array.isArray(config["previous_origins"]) ? (config["previous_origins"] as string[]) : [];
      start = new URL(landed);
      config = { ...config, url: start.toString(), previous_origins: Array.from(new Set([...previous, from])) };
      await supabase.from("knowledge_sources").update({ name: start.hostname, config }).eq("id", sourceId);
      void logServerActivity(supabase, organizationId, null, "reading_host_changed", {
        source_id: sourceId,
        from,
        to: start.origin,
      }).catch(() => undefined);
      await raiseSiteAlert(supabase, organizationId, sourceId, "host_changed", {
        site: start.origin,
        detail: `${new URL(from).hostname} now opens as ${start.hostname} — Aiden follows the new address`,
      });
    }
  }
  const origin = start.origin;
  // "Use sitemap" with the sitemap's own address: that file is read first and
  // the homepage is the site's root.
  const sitemapUrl = discovery === "sitemap" && /\.xml(?:$|\?)/i.test(start.pathname + start.search) ? start.toString() : null;
  if (sitemapUrl) start = new URL(`${origin}/`);
  const homeUrl = normalizeUrl(start.toString(), start.toString(), origin, keepQuery) ?? start.toString();

  const alreadySeen = resuming ? Number(config["pages_done"] ?? 0) : 0;
  const day0Limit = Math.max(Number(reading.day0_page_limit) || 15, 1);
  const planCap = mode === "full" ? plan.cap : day0Limit;
  // A plan's page limit counts pages a paid reader had to read. Our own
  // fetch is free: a full read takes every page it can read itself, up to a
  // safety ceiling. Trial workspaces get the day-one budget of paid pages.
  const pageCeiling = mode === "full" ? Math.max(OWN_PAGE_CEILING, planCap) : day0Limit;
  const paidCap = config["force_paid"] === true ? Number.POSITIVE_INFINITY : plan.paid ? plan.cap : day0Limit;
  let paidPages = resuming || refreshStartedAt !== null ? Number(config["paid_pages"] ?? 0) || 0 : 0;
  /** A page came back nearly empty after the paid budget was used up. */
  let paidCapped = (resuming || refreshStartedAt !== null) && config["paid_capped"] === true;
  const runLimit = Number(config["run_limit"] ?? 0);
  let runCap = !staged
    ? day0Limit
    : refreshing
      ? RUN_PAGE_CAP
      : Math.max(Math.min(pageCeiling - alreadySeen, RUN_PAGE_CAP), 0);
  if (runLimit > 0) runCap = Math.min(runCap, runLimit);
  if (singlePage) runCap = 0;
  // Firecrawl credits are reserved per call against the monthly caps; once a
  // cap is hit the rest of this read uses our own reader, logged once.
  const budget: FirecrawlBudget = {
    supabase,
    organizationId,
    onCapped: () => {
      void logServerActivity(supabase, organizationId, null, "firecrawl_cap_reached", {
        source_id: sourceId,
        mode,
      }).catch(() => undefined);
    },
  };
  const tavilyBudget: TavilyBudget = {
    supabase,
    organizationId,
    onCapped: () => {
      void logServerActivity(supabase, organizationId, null, "tavily_cap_reached", {
        source_id: sourceId,
        mode,
      }).catch(() => undefined);
    },
  };
  // Runs read with our own fetch first; the paid readers (in the Reading
  // tab's order) only get a page that came back nearly empty. The day-one
  // read keeps the Reading tab's order as it is.
  const order: ReaderEngine[] = staged
    ? (["own", ...settingsOrder.filter((engine) => engine !== "own")] as ReaderEngine[])
    : settingsOrder;
  const readOpts = {
    order,
    tavilyDepth,
    budget,
    tavilyBudget,
    ...(staged ? { timeoutMs: PAGE_TIMEOUT_MS, rerender: false } : {}),
  } as const;
  const concurrency = 4;

  // Every address this source already knows, read or not.
  const known = continuing || refreshing ? await loadKnownUrls(supabase, sourceId) : [];
  // Discover before reading: on the first run, or when a resumed read has no
  // address list yet (it died before saving one). "Individual links" never
  // discovers anything: the merchant's list is the site.
  const discover =
    !singlePage && discovery !== "links" && (!continuing || (resuming && known.length === 0));

  onStage?.("sitemap");
  const [site, key, settings] = await Promise.all([
    discover
      ? discoverSite(origin, { budgetMs: Math.min(25_000, Math.max(timeLeft() - 45_000, 5_000)), sitemapUrl })
      : Promise.resolve({
          disallow: Array.isArray(config["robots_disallow"]) ? (config["robots_disallow"] as string[]) : [],
          sitemap: [] as SitemapEntry[],
        }),
    readerKey(supabase),
    supabase.from("platform_settings").select("day0_crawl_cost_cap").maybeSingle(),
  ]);
  const sitemap = site.sitemap.map((entry) => entry.loc);
  const blocked = site.disallow;
  // A paid map (no sitemap) is bounded by the run like everything else.
  const mapped = discover && discovery === "crawl"
    ? ((await withinTime(mapSite(start.toString(), reading.map_engine, { sitemap, budget, tavilyBudget }), Math.max(timeLeft() - 45_000, 5_000)))?.urls ?? [])
    : [];
  const costCap = Number(
    (settings.data as { day0_crawl_cost_cap?: number } | null)?.day0_crawl_cost_cap ?? 2,
  );

  /** Addresses this read has finished with (read, gone or unreadable). */
  const done = new Set<string>();
  const candidates = new Map<string, number>();
  /** Which page pointed us at each address — a product's shelf, usually. */
  const referrers = new Map<string, string>();
  /** Addresses first met in this run, saved as unread for later runs. */
  const found = new Map<string, number>();
  const fullReadStartedAt = typeof config["full_read_started_at"] === "string" ? String(config["full_read_started_at"]) : null;
  const refreshSince = refreshStartedAt ?? new Date(runStarted).toISOString();
  // The sitemap's dates: what discovery just found, else what was saved.
  const lastmodOf = new Map<string, string>();
  for (const entry of site.sitemap) if (entry.lastmod) lastmodOf.set(entry.loc, entry.lastmod);
  let unchangedSkipped = 0;
  for (const row of known) {
    // A page the merchant excluded is never read again.
    if (excluded(row.url)) continue;
    if (refreshing) {
      // Re-read what was read before this refresh began; the rest is done.
      if (row.status === "read" && (!row.read_at || row.read_at < refreshSince)) {
        const lastmod = lastmodOf.get(row.url) ?? row.lastmod ?? null;
        if (changedOnly && lastmod && row.read_at && Date.parse(lastmod) <= Date.parse(row.read_at)) {
          unchangedSkipped += 1;
          continue;
        }
        candidates.set(row.url, Number(row.priority ?? 0));
      }
      continue;
    }
    if (row.status === "read" && (!fullReadStartedAt || (row.read_at ?? "") >= fullReadStartedAt)) done.add(row.url);
    else candidates.set(row.url, Number(row.priority ?? 0));
  }

  const paidOrder = order.filter((engine) => engine !== "own");
  /**
   * A run reads with our own fetch; a page that comes back nearly empty goes
   * to the paid readers only while the plan's paid pages last. Each paid
   * page is counted before it is asked for, so parallel reads never go past
   * the limit (a paid attempt that fails still counts).
   */
  const readInRun = async (urls: string[], allowReader: boolean): Promise<Map<string, PageRead | null>> => {
    const own = await readPages(urls, { key, allowReader, ...readOpts, order: ["own"], ...(onStage ? { onStage } : {}) });
    if (!paidOrder.length) return own;
    for (const url of urls) {
      const first = own.get(url) ?? null;
      if (first && first.text.length >= MIN_MAIN_TEXT) continue;
      if (paidPages >= paidCap) {
        paidCapped = true;
        continue;
      }
      paidPages += 1;
      const paid = (await readPages([url], { key, allowReader: false, ...readOpts, order: paidOrder })).get(url) ?? null;
      if (paid && (!first || paid.text.length > first.text.length)) own.set(url, paid);
    }
    return own;
  };

  let platform: "shopify" | "woocommerce" | null =
    config["platform"] === "shopify" || config["platform"] === "woocommerce" ? (config["platform"] as "shopify" | "woocommerce") : null;
  // The homepage first: it tells us whether this is a shop with public data.
  const readHomeFirst =
    !done.has(homeUrl) &&
    !(refreshing && refreshStartedAt) &&
    !excluded(homeUrl) &&
    (discovery !== "links" || listedLinks.some((l) => normalizeUrl(l, origin, origin, keepQuery) === homeUrl));
  const home = readHomeFirst
    ? await withinTime(
        staged
          ? readInRun([start.toString()], order.length === 1).then((pages) => pages.get(start.toString()) ?? null)
          : readPage(start.toString(), { key, ...readOpts, ...(onStage ? { onStage } : {}) }),
        timeLeft() - 5_000,
      )
    : null;
  let readerCost = home?.usedReader ? READER_COST : 0;
  if (!continuing && !singlePage && discovery !== "links") {
    platform = detectPlatform(home?.html ?? "", home?.headers ?? {});
    // If the markup didn't tell us, the catalogue itself will: a shop answers
    // this address with product data and nothing else does.
    if (!platform) {
      const probe = await fetchWithTimeout(`${origin}/products.json?limit=1`, 8000);
      if (probe?.ok) {
        const body = (await probe.json().catch(() => null)) as { products?: unknown } | null;
        if (body && Array.isArray(body.products)) platform = "shopify";
      }
    }
  }
  if (singlePage) platform = null;
  console.info(
    "[crawl]",
    JSON.stringify({
      source: sourceId,
      mode,
      staged,
      resuming,
      refreshing,
      planCap,
      runCap,
      platform,
      order,
      fetch: home
        ? { status: home.status ?? 0, bytes: home.bytes ?? 0, extractedChars: home.extractedChars ?? 0, usedReader: home.usedReader }
        : null,
      sitemap: sitemap.length,
      known: known.length,
      homeLinks: home?.links.length ?? 0,
    }),
  );

  const consider = (raw: string, base: string, queue: boolean) => {
    const url = normalizeUrl(raw, base, origin, keepQuery);
    if (!url) return;
    if (!referrers.has(url)) referrers.set(url, base);
    if (done.has(url) || candidates.has(url) || found.has(url)) return;
    if (excluded(url)) return;
    // A shop's catalogue arrives as data, so its product pages are not crawled.
    if (platform) {
      const path = new URL(url).pathname;
      if (/^\/(?:products|collections|product-category)(?:\/|$)/i.test(path)) return;
    }
    const score = urlPriority(url, origin);
    if (score == null) return;
    if (blocked.some((p) => new URL(url).pathname.startsWith(p))) return;
    found.set(url, score);
    if (queue) candidates.set(url, score);
  };

  if (discovery === "links") {
    // Only the merchant's own list, on this site.
    if (!refreshing) for (const link of listedLinks) consider(link, origin, true);
  } else {
    if (!refreshing) consider(start.toString(), start.toString(), true);
    for (const loc of sitemap) consider(loc, origin, !refreshing);
    for (const loc of mapped) consider(loc, origin, !refreshing);
    // "Use sitemap" reads what the sitemap lists and follows no links.
    if (discovery === "crawl") for (const href of home?.links ?? []) consider(href, start.toString(), !refreshing);
  }
  candidates.delete(homeUrl);
  found.delete(homeUrl);

  // The address list is saved before reading, so a run that dies still
  // leaves the next one a queue to work from.
  const saveFound = async () => {
    const rows = Array.from(found)
      .filter(([url]) => !done.has(url))
      .map(([url, priority]) => ({ organization_id: organizationId, source_id: sourceId, url, priority }));
    found.clear();
    try {
      for (let i = 0; i < rows.length; i += 200)
        await supabase
          .from("knowledge_urls")
          .upsert(rows.slice(i, i + 200), { onConflict: "source_id,url", ignoreDuplicates: true });
    } catch (error) {
      console.error("[crawl] url list save failed", error instanceof Error ? error.message : String(error));
    }
  };
  if (staged) await saveFound();
  // The sitemap's dates, kept per address so "Re-read whole site" can skip
  // pages that haven't changed.
  if (discover && lastmodOf.size > 0) await saveLastmods(supabase, organizationId, sourceId, origin, lastmodOf);
  // A fresh full read (or refresh) notes when it began before reading a page:
  // if this run dies, the next one knows which pages this read already did.
  if (staged && !continuing) {
    config = {
      ...config,
      ...(refreshing
        ? { refresh_started_at: refreshSince }
        : {
            full_read_started_at: new Date(runStarted).toISOString(),
            // What the live version covers now, for the swap rule at the end.
            prev_snapshot: await liveSnapshot(supabase, organizationId, sourceId, origin),
          }),
    };
    await supabase.from("knowledge_sources").update({ config }).eq("id", sourceId);
  }

  const pageCtx: PageSaveContext = {
    supabase,
    organizationId,
    sourceId,
    origin,
    platform,
    readVia: refreshing ? "refresh" : mode,
    facts: true,
    factsOnProductPages: !staged,
  };
  /** Pages whose text was saved this run. */
  let savedPages = 0;
  let factsCost = 0;
  let seen = 0;
  const gonePages = new Set<string>();
  /** Taken from the queue but cut off by the run's time limit: next run. */
  const unfinished = new Set<string>();
  const productDrafts: ProductDraft[] = [];
  /** Pages per engine this run, for the read log. */
  const engines: Record<string, number> = {};
  let credits = 0;
  let failedPages = 0;
  /** One page read: tally its engine and, in a run, what it cost of the paid budget. */
  const tally = (page: PageRead | null) => {
    if (!page) return;
    const engine = page.engine ?? "own";
    engines[engine] = (engines[engine] ?? 0) + 1;
    credits += page.credits ?? 0;
  };

  if (home) {
    seen += 1;
    tally(home);
    // The home page's own product, if any, was never read off it.
    const saved = await withinTime(savePage({ ...pageCtx, factsOnProductPages: true }, homeUrl, { ...home, html: "" }), timeLeft() - 2_000);
    if (saved?.saved) savedPages += 1;
    factsCost += saved?.cost ?? 0;
    done.add(homeUrl);
  }

  /** Highest-scoring address we have not read yet. */
  const takeNext = (): string | null => {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [url, score] of candidates) {
      if (score > bestScore) {
        best = url;
        bestScore = score;
      }
    }
    if (best) candidates.delete(best);
    return best;
  };

  let lastBeat = Date.now();
  const heartbeat = async () => {
    lastBeat = Date.now();
    await supabase
      .from("knowledge_sources")
      .update({ pages_seen: alreadySeen + seen, sync_started_at: new Date().toISOString() })
      .eq("id", sourceId);
  };

  // Tavily bills per 5 URLs, so it reads in batches of 5.
  const batchSize = order[0] === "tavily" ? 5 : 1;
  const stopAt = staged ? softStop : runStarted + 90_000;
  const worker = async () => {
    while (candidates.size > 0 && seen < runCap && Date.now() < stopAt) {
      const batch: string[] = [];
      while (batch.length < batchSize && seen + batch.length < runCap) {
        const next = takeNext();
        if (!next) break;
        if (done.has(next)) continue;
        done.add(next);
        if (isAssetUrl(next)) continue;
        batch.push(next);
      }
      if (!batch.length) return;
      seen += batch.length;
      const allowReader = readerCost + READER_COST <= costCap && (!staged || order.length === 1);
      const startedAt = Date.now();
      let pages: Map<string, PageRead | null> | null = new Map();
      try {
        pages = await withinTime(
          staged ? readInRun(batch, allowReader) : readPages(batch, { key, allowReader, ...readOpts, ...(onStage ? { onStage } : {}) }),
          timeLeft() - 3_000,
        );
      } catch (error) {
        // One unreadable batch must never end the whole read.
        console.error("[crawl] pages failed", batch.join(","), error instanceof Error ? error.message : String(error));
      }
      if (pages === null) {
        for (const url of batch) unfinished.add(url);
        return;
      }
      for (const url of batch) {
        const page = pages.get(url) ?? null;
        if (page?.usedReader) readerCost += READER_COST;
        tally(page);
        const saved = await withinTime(savePage({ ...pageCtx, referrer: referrers.get(url) ?? null }, url, page), timeLeft() - 1_000);
        if (!saved) {
          unfinished.add(url);
          continue;
        }
        if (saved.gone) gonePages.add(url);
        if (saved.failed) failedPages += 1;
        if (saved.saved) savedPages += 1;
        factsCost += saved.cost;
        if (saved.product) productDrafts.push(saved.product);
        // Every page we fetched widens the map of the site.
        if ((mode === "full" || refreshing) && discovery === "crawl")
          for (const href of saved.links) consider(href, url, mode === "full" && !refreshing);
        console.info(
          "[crawl] page",
          JSON.stringify({
            source: sourceId,
            url,
            engine: page?.engine ?? null,
            credits: page?.credits ?? 0,
            reader: page?.usedReader ? READER_COST : 0,
            chars: saved.chars,
            product: Boolean(saved.product),
            ms: Date.now() - startedAt,
          }),
        );
      }
      if (seen % 5 === 0 || batchSize > 1 || Date.now() - lastBeat > 15_000) await heartbeat();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  for (const url of unfinished) {
    done.delete(url);
    candidates.set(url, urlPriority(url, origin) ?? 0);
  }
  if (staged) await saveFound();

  const runLeft = runLimit > 0 ? Math.max(runLimit - seen, 0) : 0;
  let more =
    staged &&
    candidates.size > 0 &&
    (refreshing || (alreadySeen + seen < pageCeiling && (runLimit === 0 || runLeft > 0)));

  // Shops hand over their catalogue directly; no need to walk every product.
  // Read once, on the run that finishes, and saved after this returns. Cut
  // off by the run's time limit, it is fetched again on the next run.
  const docs: KnowledgeDocument[] = [];
  if (platform && !more) {
    const commerce = await withinTime(commerceDocuments(origin, platform, Math.min(planCap, 1000)), Math.max(timeLeft() - 10_000, 5_000));
    if (commerce) docs.push(...commerce);
    else if (staged) more = true;
  }

  if (savedPages === 0 && docs.length === 0 && !more) {
    const { count } = await supabase
      .from("knowledge_documents")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId);
    if (!count) throw new Error("We couldn't read any pages from that address.");
  }

  const totalSeen = refreshing ? Number(config["pages_done"] ?? seen) : alreadySeen + seen;

  // The full page list per source, read/unread, for backfill and on-demand reads.
  let totalPages: number | null = null;
  if (!staged) {
    // The day-one read keeps its candidates as unread for later reads.
    for (const [url, priority] of candidates) found.set(url, priority);
    await saveFound();
  }
  {
    const { count } = await supabase
      .from("knowledge_urls")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId);
    totalPages = count ?? null;
  }

  // "Refresh from website" also fills products that are still missing a
  // photo, description or shelf, from their own pages — even pages whose text
  // hasn't changed. Empty fields only; nothing is re-embedded. Done on the
  // run that finishes the refresh.
  if (refreshing && !more && config["fill_products"] === true) {
    const filled = await fillMissingProductDetails(supabase, organizationId, origin, {
      budgetMs: Math.max(Math.min(45_000, timeLeft() - 10_000), 5_000),
    }).catch((error) => {
      console.error("[crawl] product fill failed", error instanceof Error ? error.message : String(error));
      return null;
    });
    if (filled) console.info("[crawl] product fill", JSON.stringify({ source: sourceId, ...filled }));
  }
  // The request to fill is used up once the refresh is done; so are the
  // one-read switches (changed-only, an admin's forced paid reads, the
  // snapshot the swap rule compares against).
  const keptConfig: Record<string, unknown> = { ...config };
  if (!more) for (const k of ["fill_products", "changed_only", "force_paid", "prev_snapshot"]) delete keptConfig[k];
  const fullReadNow = mode === "full" && !more && !refreshing && !singlePage;
  const readStartedAt = typeof config["full_read_started_at"] === "string" ? String(config["full_read_started_at"]) : new Date(runStarted).toISOString();

  // Swap rule: a full re-read replaces the live version only when it covers
  // at least the same info pages and 80% of its products. Otherwise nothing
  // is forgotten or hidden, and the merchant sees why.
  let swapBlocked: { at: string; reasons: string[]; previous_products: number; new_products: number } | null = null;
  let thisRead: Awaited<ReturnType<typeof readOutcome>> | null = null;
  if (fullReadNow) {
    thisRead = await readOutcome(supabase, organizationId, sourceId, origin, readStartedAt);
    // A shop's catalogue and policy pages arrive as data in this same run.
    if (docs.length > 0)
      thisRead.topics = Array.from(new Set([...thisRead.topics, ...coveredTopics(docs.map((d) => ({ url: d.sourceRef, title: d.title })))]));
    const prev = (config["prev_snapshot"] ?? null) as LiveSnapshot | null;
    if (prev) {
      const decision = decideSwap({
        previousTopics: prev.topics,
        newTopics: thisRead.topics,
        previousProducts: prev.products,
        newProducts: thisRead.products,
      });
      if (!decision.swap) {
        swapBlocked = { at: new Date().toISOString(), reasons: decision.reasons, previous_products: prev.products, new_products: thisRead.products };
        void logServerActivity(supabase, organizationId, null, "reading_swap_blocked", { source_id: sourceId, ...swapBlocked }).catch(() => undefined);
      }
    }
  }
  const replaceLive = fullReadNow && !swapBlocked;
  // The full site map: every address we know for this source, read or not.
  const siteMap = new Set<string>([...done, ...mapped, ...candidates.keys()]);
  if (fullReadNow) {
    const { data: knownNow } = await supabase
      .from("knowledge_urls")
      .select("url")
      .eq("source_id", sourceId)
      .limit(20000);
    for (const row of (knownNow ?? []) as Array<{ url: string }>) siteMap.add(row.url);
    for (const url of gonePages) siteMap.delete(url);
  }
  const forget = { fullReadComplete: replaceLive, siteMap: Array.from(siteMap), gone: Array.from(gonePages) };
  lastReadForget = forget;
  await hideMissingCrawledProducts(supabase, organizationId, origin, forget);
  if (replaceLive) {
    // The same products under the site's old address (myzoori.com before it
    // moved to www.) are hidden — never deleted — once the full read is in.
    const aliases = Array.from(
      new Set([
        ...aliasOrigins(origin),
        ...((Array.isArray(config["previous_origins"]) ? config["previous_origins"] : []) as string[]),
      ]),
    ).filter((o) => o !== origin);
    await hideAliasHostProducts(supabase, organizationId, origin, aliases, forget).catch((error: unknown) => {
      console.error("[crawl] old-address products not hidden", error instanceof Error ? error.message : String(error));
    });
  }
  const productsFound = await countCrawledProducts(supabase, organizationId, origin);

  // Something about the site changed in a way the owner should look at.
  if (fullReadNow && thisRead) {
    const prev = (config["prev_snapshot"] ?? null) as LiveSnapshot | null;
    // Our own fetch can't tell a 404 from a dead server, so both count.
    if (thisRead.read >= 10 && thisRead.gone / thisRead.read > 0.2)
      await raiseSiteAlert(supabase, organizationId, sourceId, "dead_links", {
        site: origin,
        detail: `${thisRead.gone} of ${thisRead.read} pages on ${new URL(origin).hostname} no longer open`,
      });
    const newShelves = prev && prev.categories.length > 0 ? thisRead.categories.filter((c) => !prev.categories.includes(c)) : [];
    if (newShelves.length > 0)
      await raiseSiteAlert(supabase, organizationId, sourceId, "new_category", {
        site: origin,
        detail: `new on ${new URL(origin).hostname}: ${newShelves.slice(0, 5).join(", ")}`,
      });
  }

  const nextConfig: Record<string, unknown> = {
    ...keptConfig,
    mode,
    ...(platform ? { platform } : {}),
    page_limit: planCap,
    pages_done: totalSeen,
    resume: more,
    refresh: refreshing && more,
    run_limit: runLimit > 0 && more ? runLeft : null,
    full_read_started_at:
      mode === "full" && !refreshing && more ? (resuming && fullReadStartedAt ? fullReadStartedAt : new Date(runStarted).toISOString()) : null,
    refresh_started_at: refreshing && more ? refreshSince : null,
    ...(discover ? { robots_disallow: blocked.slice(0, 200) } : {}),
    ...(staged ? { paid_pages: paidPages, paid_capped: paidCapped } : {}),
    // Pages "Re-read whole site" left alone because their sitemap date hadn't moved.
    unchanged_skipped: refreshing && changedOnly ? unchangedSkipped : null,
    ...(fullReadNow ? { swap_blocked: swapBlocked } : {}),
  };
  await supabase
    .from("knowledge_sources")
    .update({
      pages_seen: totalSeen,
      products_found: productsFound,
      cost_amount: readerCost + factsCost,
      ...(totalPages != null ? { total_pages: totalPages } : {}),
      ...(fullReadNow ? { last_full_read_at: new Date().toISOString() } : {}),
      config: nextConfig,
    })
    .eq("id", sourceId);

  // First time the whole site is read: tell the owner on the AiDwar number.
  if (fullReadNow && !config["full_read_announced"]) {
    try {
      const { getScript } = await import("@/lib/scripts.server");
      const body = await getScript(supabase, "full_read_done", {
        site: origin.replace(/^https?:\/\//, ""),
        pages: totalSeen,
        products: productsFound,
      });
      const { notifyOwnerOnOnboardingChannel } = await import("@/lib/merchant-channel.server");
      await notifyOwnerOnOnboardingChannel(supabase, organizationId, body);
      await supabase
        .from("knowledge_sources")
        .update({ config: { ...nextConfig, full_read_announced: true } })
        .eq("id", sourceId);
    } catch (error) {
      console.error("[crawl] full read notice failed", error instanceof Error ? error.message : String(error));
    }
  }

  console.info(
    "[crawl] run done",
    JSON.stringify({ source: sourceId, seen, saved: savedPages, products: productDrafts.length, more, ms: Date.now() - runStarted }),
  );
  // The read log (admin → Aiden → Workspaces): one row per run.
  void logServerActivity(supabase, organizationId, null, "reading_run", {
    source_id: sourceId,
    mode: refreshing ? (changedOnly ? "refresh_changed" : "refresh") : mode,
    discovery,
    pages: seen,
    saved: savedPages,
    products: productDrafts.length,
    engines,
    credits: Math.round(credits * 100) / 100,
    cost: Math.round((readerCost + factsCost) * 100) / 100,
    failed: failedPages,
    gone: gonePages.size,
    paid_pages: staged ? paidPages : null,
    unchanged_skipped: unchangedSkipped,
    more,
    swap_blocked: swapBlocked?.reasons ?? null,
    ms: Date.now() - runStarted,
  }).catch(() => undefined);
  return docs;
};


/** Pages of a PDF, one document each. */
export async function parsePdf(bytes: Uint8Array, name: string): Promise<KnowledgeDocument[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const docs = pages
    .map((page, index) => ({
      sourceRef: `page-${index + 1}`,
      title: `${name} — page ${index + 1}`,
      content: String(page).replace(/\s+/g, " ").trim(),
      metadata: { page: index + 1, file: name },
    }))
    .filter((d) => d.content.length > 40);
  if (docs.length === 0) throw new Error("That file had no readable text in it.");
  return docs;
}

/** Rows of a spreadsheet, one document each. CSV and XLSX alike. */
export async function parseSpreadsheet(
  bytes: Uint8Array,
  name: string,
): Promise<KnowledgeDocument[]> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(bytes, { type: "array" });
  const docs: KnowledgeDocument[] = [];
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    rows.forEach((row, index) => {
      const content = Object.entries(row)
        .filter(([, value]) => String(value).trim().length > 0)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      if (content.trim().length < 3) return;
      docs.push({
        sourceRef: `${sheetName}!${index + 2}`,
        title: `${name} — ${String(Object.values(row)[0] ?? `row ${index + 2}`)}`,
        content,
        metadata: { sheet: sheetName, row: index + 2, file: name },
      });
    });
  }
  if (docs.length === 0) throw new Error("That spreadsheet had no rows we could read.");
  return docs;
}

/**
 * Uploaded files are read once, at upload. We keep the text they contained,
 * never the file, so there is nothing to re-fetch on a refresh.
 */
const rereadUpload: Connector = async ({ supabase, sourceId }) => {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("source_ref, title, content, metadata")
    .eq("source_id", sourceId);
  return (
    (data ?? []) as Array<{
      source_ref: string;
      title: string;
      content: string;
      metadata: Record<string, unknown>;
    }>
  ).map((d) => ({
    sourceRef: d.source_ref,
    title: d.title,
    content: d.content,
    metadata: d.metadata ?? {},
  }));
};

/** Written answers, including corrections a merchant makes to a wrong reply. */
const readManualQa: Connector = async ({ supabase, sourceId }) => {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("source_ref, title, content, metadata")
    .eq("source_id", sourceId);
  return ((data ?? []) as Array<KnowledgeDocument & { source_ref: string }>).map((d) => ({
    sourceRef: d.source_ref,
    title: d.title,
    content: d.content,
    metadata: (d.metadata ?? {}) as Record<string, unknown>,
  }));
};

export const CONNECTORS: Record<SourceType, Connector> = {
  website: crawlWebsite,
  pdf: rereadUpload,
  spreadsheet: rereadUpload,
  image: rereadUpload,
  docx: rereadUpload,
  upload: rereadUpload,
  manual_qa: readManualQa,
};

// ------------------------------------------------------------------ syncing

/** Fetch, store and embed one source. Returns how many items it now holds. */
export async function syncSource(
  supabase: SupabaseClient,
  sourceId: string,
  options?: { onStage?: (stage: CrawlStage) => void; preserveError?: boolean; deadlineAt?: number },
): Promise<{ ok: boolean; itemCount: number; error?: string }> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, config, status")
    .eq("id", sourceId)
    .maybeSingle();
  const source = data as {
    id: string;
    organization_id: string;
    type: SourceType;
    name: string;
    config: Record<string, unknown>;
    status?: string;
  } | null;
  if (!source) return { ok: false, itemCount: 0, error: "That source no longer exists." };
  // A deleted source (kept for Undo) is never read again.
  if (isSoftDeleted(source)) return { ok: false, itemCount: 0, error: "That source was deleted." };

  const connector = CONNECTORS[source.type];
  if (!connector)
    return { ok: false, itemCount: 0, error: "We can't read that kind of source yet." };

  await supabase
    .from("knowledge_sources")
    .update({ status: "syncing", last_error: null })
    .eq("id", sourceId);

  try {
    lastReadForget = null;
    // A website read saves its pages as it goes; anything it couldn't build
    // an index for yet counts here too.
    embedDeferred = 0;
    const documents = await connector({
      supabase,
      organizationId: source.organization_id,
      sourceId,
      config: source.config ?? {},
      ...(options?.onStage ? { onStage: options.onStage } : {}),
      ...(options?.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
    });

    options?.onStage?.("embed");
    // Remove legacy asset rows before embedding. Their chunks cascade-delete.
    if (source.type === "website") {
      const { data: existing } = await supabase
        .from("knowledge_documents")
        .select("id, source_ref")
        .eq("source_id", sourceId)
        .limit(5000);
      const assetIds = ((existing ?? []) as Array<{ id: string; source_ref: string }>)
        .filter((row) => isAssetUrl(row.source_ref))
        .map((row) => row.id);
      if (assetIds.length > 0) {
        await supabase.from("knowledge_documents").delete().in("id", assetIds);
      }
    }
    for (const doc of documents) {
      await upsertDocument(supabase, source.organization_id, sourceId, doc);
    }
    const deferred = embedDeferred;

    // Anything the source no longer has is forgotten, so a deleted page stops
    // being quoted at customers.
    // Only a completed FULL read may forget pages, and only ones that are gone
    // or no longer on the site map. Other source types report their whole list
    // every time, so for them "not in this list" means gone.
    if (source.type !== "manual_qa") {
      const forget = source.type === "website" ? lastReadForget : {
        fullReadComplete: documents.length > 0,
        siteMap: documents.map((d) => d.sourceRef),
        gone: [] as string[],
      };
      if (forget) {
        const { planForget } = await import("@/lib/forget-rules");
        const { data: rows } = await supabase
          .from("knowledge_documents")
          .select("id, source_ref")
          .eq("source_id", sourceId)
          .limit(20000);
        const existing = (rows ?? []) as Array<{ id: string; source_ref: string }>;
        const plan = planForget({ existing: existing.map((r) => r.source_ref), ...forget });
        if (plan.skipped === "over_cap") {
          console.error("[crawl] page forget skipped", JSON.stringify({ sourceId, candidates: plan.candidates, total: existing.length }));
          await supabase.from("activity_log").insert({
            organization_id: source.organization_id,
            user_id: null,
            action: "reading_forget_skipped",
            details: { kind: "pages", source_id: sourceId, candidates: plan.candidates, total: existing.length },
          });
        } else if (plan.remove.length > 0) {
          const remove = new Set(plan.remove);
          const ids = existing.filter((r) => remove.has(r.source_ref)).map((r) => r.id);
          for (let i = 0; i < ids.length; i += 200)
            await supabase.from("knowledge_documents").delete().in("id", ids.slice(i, i + 200));
        }
      }
    }
    lastReadForget = null;

    // A website's pages were saved during the read: count what the source holds.
    let itemCount = documents.length;
    if (source.type === "website") {
      const { count } = await supabase
        .from("knowledge_documents")
        .select("id", { count: "exact", head: true })
        .eq("source_id", sourceId);
      if (typeof count === "number") itemCount = count;
    }

    await supabase
      .from("knowledge_sources")
      .update({
        status: "ready",
        item_count: itemCount,
        last_synced_at: new Date().toISOString(),
        last_error:
          deferred > 0
            ? `Saved every page. ${deferred} still being prepared for answers — they finish on the next read.`
            : null,
      })
      .eq("id", sourceId);

    // A big site is read in runs; if pages remain, the worker picks it up again.
    const { data: after } = await supabase
      .from("knowledge_sources")
      .select("config")
      .eq("id", sourceId)
      .maybeSingle();
    if (((after as { config?: Record<string, unknown> } | null)?.config ?? {})["resume"] === true) {
      await supabase
        .from("knowledge_sources")
        .update({
          status: "pending",
          queued_at: new Date().toISOString(),
          sync_started_at: null,
        })
        .eq("id", sourceId);
    }

    return { ok: true, itemCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : "We couldn't read that source.";
    const name = error instanceof Error ? error.name : "Error";
    if (options?.preserveError) throw error;
    await supabase
      .from("knowledge_sources")
      .update({ status: "error", last_error: message.slice(0, 300) })
      .eq("id", sourceId);
    return { ok: false, itemCount: 0, error: message };
  }
}

/** Pages saved whose search index could not be built yet (per process, reset per sync). */
let embedDeferred = 0;
/** What the website read just finished tells the forget step. Null = unknown. */
let lastReadForget: { fullReadComplete: boolean; siteMap: string[]; gone: string[] } | null = null;

/**
 * Store one document and (re)build its chunks when the text has changed.
 * Chunks are only trusted when metadata.chunks_hash matches the current
 * content hash; otherwise old chunks are removed and rebuilt in this job.
 */
export async function upsertDocument(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  doc: KnowledgeDocument,
): Promise<void> {
  const hash = await hashText(doc.content);

  const { data: existing } = await supabase
    .from("knowledge_documents")
    .select("id, content_hash, metadata")
    .eq("source_id", sourceId)
    .eq("source_ref", doc.sourceRef)
    .maybeSingle();
  const prior = existing as
    | { id: string; content_hash: string | null; metadata: Record<string, unknown> | null }
    | null;

  const priorMeta = prior?.metadata ?? {};
  const chunksCurrent =
    !!prior && priorMeta["chunks_hash"] === hash && priorMeta["needs_embedding"] !== true;
  const baseMeta: Record<string, unknown> = { ...(doc.metadata ?? {}) };
  if (chunksCurrent) baseMeta["chunks_hash"] = hash;

  let documentId = prior?.id ?? null;

  if (prior) {
    const { error } = await supabase
      .from("knowledge_documents")
      .update({ title: doc.title, content: doc.content, metadata: baseMeta, content_hash: hash })
      .eq("id", prior.id);
    if (error) throw new Error(`document update failed: ${error.message}`);
    if (chunksCurrent) {
      const { count } = await supabase
        .from("knowledge_chunks")
        .select("id", { count: "exact", head: true })
        .eq("document_id", prior.id)
        .eq("embedding_model", EMBEDDING_MODEL);
      if ((count ?? 0) > 0) return; // unchanged and chunks built from this exact text
    }
  } else {
    const { data: inserted } = await supabase
      .from("knowledge_documents")
      .insert({
        organization_id: organizationId,
        source_id: sourceId,
        source_ref: doc.sourceRef,
        title: doc.title,
        content: doc.content,
        metadata: baseMeta,
        content_hash: hash,
      })
      .select("id")
      .maybeSingle();
    documentId = (inserted as { id?: string } | null)?.id ?? null;
  }

  if (!documentId) return;
  await rebuildChunks(supabase, organizationId, sourceId, documentId, doc.sourceRef, doc.content, hash, baseMeta);
}

/** Delete old chunks, re-chunk and re-embed. On failure: no stale chunks, needs_embedding=true. */
async function rebuildChunks(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  documentId: string,
  sourceRef: string,
  content: string,
  hash: string,
  meta: Record<string, unknown>,
): Promise<boolean> {
  // New chunks are built (embedded) first; the old ones are only replaced once
  // the new ones exist, so a failed embedding never leaves the page with no
  // knowledge — the previous text keeps answering until the retry succeeds.

  // Up to 3 retries with backoff (2, 8, 32 min), then the page is marked
  // failed and the source shows "(n) pages couldn't be prepared - retry".
  const markPending = async () => {
    embedDeferred += 1;
    const attempts = Number(meta["prepare_attempts"] ?? 0) + 1;
    const failed = attempts > PREPARE_MAX_RETRIES;
    await supabase
      .from("knowledge_documents")
      .update({
        metadata: {
          ...meta,
          needs_embedding: !failed,
          prepare_failed: failed,
          prepare_attempts: attempts,
          next_prepare_at: failed ? null : new Date(Date.now() + 2 * 4 ** (attempts - 1) * 60_000).toISOString(),
          chunks_hash: null,
        },
      })
      .eq("id", documentId);
  };
  const clean = (m: Record<string, unknown>) => {
    const { prepare_attempts: _a, prepare_failed: _f, next_prepare_at: _n, ...rest } = m;
    return rest;
  };

  const chunks = chunkText(content);
  if (chunks.length === 0) {
    // The page is empty now: nothing new to build, so the old text goes.
    const { error: delError } = await supabase.from("knowledge_chunks").delete().eq("document_id", documentId);
    if (delError) throw new Error(`chunk delete failed: ${delError.message}`);
    await supabase
      .from("knowledge_documents")
      .update({ metadata: { ...clean(meta), needs_embedding: false, chunks_hash: hash } })
      .eq("id", documentId);
    return true;
  }
  let vectors: number[][];
  try {
    vectors = await embedTexts(chunks, { supabase, organizationId });
  } catch (error) {
    console.error("[knowledge] embed deferred", sourceRef, error instanceof Error ? error.message : String(error));
    await markPending();
    return false;
  }

  const rows = chunks.map((text, index) => ({
    organization_id: organizationId,
    source_id: sourceId,
    document_id: documentId,
    source_ref: sourceRef,
    chunk_index: index,
    text,
    embedding: JSON.stringify(vectors[index] ?? []),
    embedding_model: EMBEDDING_MODEL,
    dimensions: (vectors[index] ?? []).length || 1536,
  }));

  const swap = await replaceChunks(supabase, documentId, rows);
  if (swap.error) {
    console.error("[knowledge] chunk replace failed", sourceRef, swap.error);
    await markPending();
    return false;
  }
  await supabase
    .from("knowledge_documents")
    .update({ metadata: { ...clean(meta), needs_embedding: false, chunks_hash: hash } })
    .eq("id", documentId);
  return true;
}

type ChunkRow = {
  organization_id: string;
  source_id: string;
  document_id: string;
  source_ref: string;
  chunk_index: number;
  text: string;
  embedding: string;
  embedding_model: string;
  dimensions: number;
};

/**
 * Swap a page's chunks for freshly built ones in one step: the
 * replace_knowledge_chunks RPC deletes and inserts in a single transaction, so
 * a failure leaves the old chunks in place. Until that migration is applied
 * the previous delete-then-insert path is used.
 */
export async function replaceChunks(
  supabase: SupabaseClient,
  documentId: string,
  rows: ChunkRow[],
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("replace_knowledge_chunks", {
    p_document_id: documentId,
    p_rows: rows.map(({ source_ref, chunk_index, text, embedding, embedding_model, dimensions }) => ({
      source_ref, chunk_index, text, embedding, embedding_model, dimensions,
    })),
  });
  if (!error) return { error: null };
  const missing = error.code === "PGRST202" || error.code === "42883";
  if (!missing) return { error: error.message };

  const { error: delError } = await supabase.from("knowledge_chunks").delete().eq("document_id", documentId);
  if (delError) return { error: `chunk delete failed: ${delError.message}` };
  for (let i = 0; i < rows.length; i += 50) {
    const { error: insError } = await supabase.from("knowledge_chunks").insert(rows.slice(i, i + 50));
    if (insError) {
      await supabase.from("knowledge_chunks").delete().eq("document_id", documentId);
      return { error: insError.message };
    }
  }
  return { error: null };
}

const PREPARE_MAX_RETRIES = 3;

/** Owner pressed "retry" on a source: failed pages go back in the queue. */
export async function retryFailedPreparation(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
): Promise<number> {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .eq("source_id", sourceId)
    .eq("metadata->>prepare_failed", "true")
    .limit(5000);
  const rows = (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>;
  for (const row of rows) {
    const { prepare_attempts: _a, prepare_failed: _f, next_prepare_at: _n, ...rest } = row.metadata ?? {};
    await supabase
      .from("knowledge_documents")
      .update({ metadata: { ...rest, needs_embedding: true } })
      .eq("id", row.id);
  }
  return rows.length;
}

/** Worker tick: retry documents whose chunks couldn't be built. */
export async function retryPendingEmbeddings(
  supabase: SupabaseClient,
  limit = 50,
  /** Epoch ms after which no further page is tried this tick. */
  stopAt: number = Number.POSITIVE_INFINITY,
): Promise<{ tried: number; built: number }> {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("id, organization_id, source_id, source_ref, content, content_hash, metadata")
    .eq("metadata->>needs_embedding", "true")
    .or(`metadata->>next_prepare_at.is.null,metadata->>next_prepare_at.lte.${new Date().toISOString()}`)
    .order("updated_at", { ascending: true })
    .limit(limit);
  let built = 0;
  const rows = (data ?? []) as Array<{
    id: string; organization_id: string; source_id: string; source_ref: string;
    content: string; content_hash: string | null; metadata: Record<string, unknown> | null;
  }>;
  for (const row of rows) {
    if (Date.now() > stopAt) break;
    const hash = row.content_hash ?? (await hashText(row.content));
    const ok = await rebuildChunks(
      supabase, row.organization_id, row.source_id, row.id, row.source_ref, row.content, hash, row.metadata ?? {},
    ).catch(() => false);
    if (ok) built += 1;
  }
  return { tried: rows.length, built };
}

/**
 * Add a website as something the employee reads, then read it. One
 * implementation, shared by the knowledge screen and the owner's chat with
 * Aiden, so both behave identically.
 */
/** App stores, social profiles, marketplaces, maps: read that one page only. */
const LISTING_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)play\.google\.com$/, "Play Store"],
  [/(^|\.)apps\.apple\.com$|(^|\.)itunes\.apple\.com$/, "App Store"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/, "Facebook"],
  [/(^|\.)linktr\.ee$/, "Linktree"],
  [/(^|\.)maps\.google\.[a-z.]+$|(^|\.)maps\.app\.goo\.gl$|(^|\.)goo\.gl$|(^|\.)g\.page$/, "Google Maps"],
  [/(^|\.)amazon\.[a-z.]+$|(^|\.)amzn\.(to|in)$/, "Amazon"],
  [/(^|\.)flipkart\.com$/, "Flipkart"],
  [/(^|\.)meesho\.com$/, "Meesho"],
  [/(^|\.)myntra\.com$/, "Myntra"],
  [/(^|\.)nykaa\.com$/, "Nykaa"],
  [/(^|\.)etsy\.com$/, "Etsy"],
  [/(^|\.)justdial\.com$/, "Justdial"],
  [/(^|\.)indiamart\.com$/, "IndiaMART"],
  [/(^|\.)zomato\.com$/, "Zomato"],
  [/(^|\.)swiggy\.com$/, "Swiggy"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "YouTube"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)(x|twitter)\.com$/, "X"],
  [/(^|\.)pinterest\.[a-z.]+$/, "Pinterest"],
];
export function listingLabel(url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "google.com" && /^\/maps/.test(new URL(url).pathname)) return "Google Maps";
  for (const [re, label] of LISTING_HOSTS) if (re.test(host)) return label;
  return null;
}
export function listingReply(label: string): string {
  return `Got it — I've read your ${label} page. If you have a website with prices, policies or contact details, send that too and I'll learn it as well.`;
}
export const TRIAL_LINK_LIMIT_REPLY =
  "I've already read enough to get started — connect your number to unlock full reading.";

function sameLink(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.hostname.replace(/^www\./, "").toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
    } catch {
      return u.trim().toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

export async function addWebsiteSource(
  supabase: SupabaseClient,
  organizationId: string,
  url: string,
  createdBy: string | null,
  options?: {
    mode?: "day0" | "full";
    /** Add website: crawl from the homepage (default), the sitemap only, or just these links. */
    discovery?: "crawl" | "sitemap" | "links";
    links?: string[];
    /** Keep query parameters as part of a page's address (off: listing/filter variants collapse). */
    keepQuery?: boolean;
  },
): Promise<{
  ok: boolean;
  sourceId: string | null;
  itemCount: number;
  queued?: boolean;
  /** Same link read within the re-read window: the saved copy is used. */
  reused?: boolean;
  /** Trial link limit reached; nothing was queued. */
  limited?: boolean;
  /** Set for app store / social / marketplace / maps links (one page only). */
  listing?: string | null;
  error?: string;
}> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: false, sourceId: null, itemCount: 0, error: "That isn't a full web address." };
  }
  const listing = listingLabel(url);
  const { loadReadingSettings } = await import("@/lib/reading.server");
  const reading = await loadReadingSettings(supabase);

  // Same link already read recently → use the saved copy, no new read.
  const { data: prior } = await supabase
    .from("knowledge_sources")
    .select("id, config, last_synced_at, status, item_count, created_at")
    .eq("organization_id", organizationId)
    .eq("type", "website")
    .order("created_at", { ascending: false })
    .limit(200);
  const priorRows = (prior ?? []) as Array<{
    id: string; config: Record<string, unknown> | null; last_synced_at: string | null;
    status: string; item_count: number; created_at: string;
  }>;
  const windowMs = Math.max(Number(reading.link_reread_days) || 0, 0) * 86_400_000;
  // A deleted website (kept for Undo) is never reused: adding it again starts afresh.
  const match = priorRows.find((r) => !isSoftDeleted(r) && sameLink(String(r.config?.["url"] ?? ""), url));
  if (match && windowMs > 0) {
    const last = Date.parse(match.last_synced_at ?? match.created_at);
    const inFlight = ["pending", "queued", "syncing"].includes(match.status);
    if (inFlight || (Number.isFinite(last) && Date.now() - last < windowMs)) {
      return { ok: true, sourceId: match.id, itemCount: match.item_count, reused: true, listing };
    }
  }

  // Trial workspaces: a few new links a day, a small total.
  const plan = await planLimits(supabase, organizationId);
  if (!plan.paid) {
    const dayAgo = Date.now() - 86_400_000;
    const perDay = Math.max(Number(reading.trial_links_per_day) || 0, 0);
    const total = Math.max(Number(reading.trial_links_total) || 0, 0);
    const today = priorRows.filter((r) => Date.parse(r.created_at) > dayAgo).length;
    if ((perDay > 0 && today >= perDay) || (total > 0 && priorRows.length >= total)) {
      void logServerActivity(supabase, organizationId, createdBy, "reading_link_limit_reached", {
        today, total: priorRows.length,
      }).catch(() => undefined);
      return { ok: false, sourceId: null, itemCount: 0, limited: true, listing, error: TRIAL_LINK_LIMIT_REPLY };
    }
  }

  // A re-send after the window refreshes the existing source instead of adding a copy.
  if (match) {
    await supabase
      .from("knowledge_sources")
      .update({ status: "pending", queued_at: new Date().toISOString(), sync_started_at: null })
      .eq("id", match.id);
    return { ok: true, sourceId: match.id, itemCount: 0, queued: true, listing };
  }

  const { data, error } = await supabase
    .from("knowledge_sources")
    .insert({
      organization_id: organizationId,
      type: "website",
      name: hostname,
      config: {
        url,
        mode: listing ? "day0" : options?.mode ?? "day0",
        ...(listing ? { single_page: true, listing } : {}),
        ...(!listing && options?.discovery && options.discovery !== "crawl" ? { discovery: options.discovery } : {}),
        ...(!listing && options?.discovery === "links" ? { links: (options.links ?? []).slice(0, 500) } : {}),
        ...(!listing && options?.keepQuery ? { keep_query: true } : {}),
      },
      status: "pending",
      queued_at: new Date().toISOString(),
      refresh_days: 7,
      created_by: createdBy,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    return { ok: false, sourceId: null, itemCount: 0, error: "We couldn't add that website." };
  }

  // Reading a real website takes minutes, so it never happens on the request
  // that asked for it: the worker picks the queued source up within a minute.
  return { ok: true, sourceId: (data as { id: string }).id, itemCount: 0, queued: true, listing };
}

/** A merchant's correction becomes a written answer, attributed and dated. */
export async function saveCorrection(
  supabase: SupabaseClient,
  organizationId: string,
  input: { question: string; answer: string; userId: string | null; agentId?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  let { data: source } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("type", "manual_qa")
    .limit(1)
    .maybeSingle();

  if (!source) {
    const { data: created, error } = await supabase
      .from("knowledge_sources")
      .insert({
        organization_id: organizationId,
        type: "manual_qa",
        name: "Answers you wrote",
        status: "ready",
        refresh_days: 0,
        created_by: input.userId,
      })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: "We couldn't save that correction." };
    source = created as { id: string };
  }

  const sourceId = (source as { id: string }).id;
  await upsertDocument(supabase, organizationId, sourceId, {
    sourceRef: `qa-${await hashText(input.question)}`,
    title: input.question.slice(0, 120),
    content: `Question: ${input.question}\nAnswer: ${input.answer}`,
    metadata: {
      corrected_by: input.userId,
      corrected_at: new Date().toISOString(),
      agent_id: input.agentId ?? null,
    },
  });

  const { count } = await supabase
    .from("knowledge_documents")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId);
  await supabase
    .from("knowledge_sources")
    .update({ item_count: count ?? 0, last_synced_at: new Date().toISOString(), status: "ready" })
    .eq("id", sourceId);

  return { ok: true };
}

/**
 * A fact the owner volunteered, filed under its own topic. No question is
 * invented for it: "Catering: parties of 20+" is what it is about, and that is
 * what the title says.
 */
export async function saveFact(
  supabase: SupabaseClient,
  organizationId: string,
  input: { topic: string; text: string; userId: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const { isQuestionText } = await import("@/lib/teach-guard");
  if (isQuestionText(input.text)) return { ok: false, error: "That's a question, not a fact." };
  let { data: source } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("type", "manual_qa")
    .limit(1)
    .maybeSingle();

  if (!source) {
    const { data: created, error } = await supabase
      .from("knowledge_sources")
      .insert({
        organization_id: organizationId,
        type: "manual_qa",
        name: "Answers you wrote",
        status: "ready",
        refresh_days: 0,
        created_by: input.userId,
      })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: "We couldn't save that." };
    source = created as { id: string };
  }

  const sourceId = (source as { id: string }).id;
  const topic = input.topic.trim().slice(0, 120) || "About the business";
  await upsertDocument(supabase, organizationId, sourceId, {
    sourceRef: `fact-${await hashText(input.text)}`,
    title: topic,
    content: `${topic}\n${input.text}`,
    metadata: {
      kind: "owner_fact",
      corrected_by: input.userId,
      corrected_at: new Date().toISOString(),
    },
  });

  const { count } = await supabase
    .from("knowledge_documents")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId);
  await supabase
    .from("knowledge_sources")
    .update({ item_count: count ?? 0, last_synced_at: new Date().toISOString(), status: "ready" })
    .eq("id", sourceId);

  return { ok: true };
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read an uploaded file once and keep its text. The file itself is not stored:
 * a merchant can see and delete every item it produced.
 */
export async function ingestUpload(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  fileName: string,
  bytes: Uint8Array,
  kind: "pdf" | "spreadsheet" | "image" | "docx",
  options: {
    /** The file's real mime type (pictures are sent as-is to the model). */
    mime?: string | null;
    /** Extra metadata on every item, e.g. the Meta media id it came from. */
    extra?: Record<string, unknown>;
    /**
     * Set when several files share one source: item refs are prefixed so two
     * PDFs' "page-1" never overwrite each other.
     */
    refPrefix?: string | null;
    /** "onboarding" when the platform pays for the read (merchant channel). */
    channel?: "onboarding" | null;
  } = {},
): Promise<{
  ok: boolean;
  itemCount: number;
  /** Lines that actually say something: a price or a fact. */
  factCount: number;
  /** Fingerprint of the text we read, so the same file twice is noticed. */
  contentHash: string | null;
  error?: string;
}> {
  try {
    const docs =
      kind === "pdf"
        ? await parsePdf(bytes, fileName)
        : kind === "image"
          ? await readImage(
              supabase,
              organizationId,
              bytes,
              fileName,
              options.mime ?? null,
              options.channel ?? null,
            )
          : kind === "docx"
            ? await parseDocx(bytes, fileName)
            : await parseSpreadsheet(bytes, fileName);
    for (const doc of docs) {
      const stamped: KnowledgeDocument = {
        ...doc,
        sourceRef: options.refPrefix ? `${options.refPrefix}:${doc.sourceRef}` : doc.sourceRef,
        metadata: { kind, ...(doc.metadata ?? {}), ...(options.extra ?? {}) },
      };
      await upsertDocument(supabase, organizationId, sourceId, stamped);
    }
    // A shared source counts everything it holds, not just this file.
    const { count } = await supabase
      .from("knowledge_documents")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId);
    await supabase
      .from("knowledge_sources")
      .update({
        status: "ready",
        item_count: count ?? docs.length,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", sourceId);
    const text = docs.map((d) => d.content).join("\n");
    return {
      ok: true,
      itemCount: docs.length,
      factCount: countExtractedItems(text),
      contentHash: text.trim() ? await hashText(text) : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "We couldn't read that file.";
    await supabase
      .from("knowledge_sources")
      .update({ status: "error", last_error: message.slice(0, 300) })
      .eq("id", sourceId);
    return { ok: false, itemCount: 0, factCount: 0, contentHash: null, error: message };
  }
}

/**
 * How much a file actually told us: lines carrying a price or a statement,
 * not the number of pages they were spread over.
 */
export function countExtractedItems(text: string): number {
  let items = 0;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 3) continue;
    const hasPrice = /(₹|rs\.?\s*\d|\$\s*\d|\d+\s*(?:rs|inr|rupees))/i.test(line);
    const hasFact = /[:\-–—]\s*\S/.test(line) && line.split(/\s+/).length >= 3;
    if (hasPrice || hasFact) items += 1;
  }
  return items;
}

/** The one source every file an owner sends on the merchant channel lands in. */
export async function ensureUploadSource(
  supabase: SupabaseClient,
  organizationId: string,
  createdBy: string | null,
): Promise<{ id: string; cost_amount: number } | null> {
  const { data: existing } = await supabase
    .from("knowledge_sources")
    .select("id, cost_amount")
    .eq("organization_id", organizationId)
    .eq("type", "upload")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      id: (existing as { id: string }).id,
      cost_amount: Number((existing as { cost_amount?: number }).cost_amount ?? 0),
    };
  }
  const { data: created } = await supabase
    .from("knowledge_sources")
    .insert({
      organization_id: organizationId,
      type: "upload",
      name: "Files you sent",
      config: {},
      refresh_days: 0,
      status: "ready",
      created_by: createdBy,
    })
    .select("id")
    .maybeSingle();
  return created ? { id: (created as { id: string }).id, cost_amount: 0 } : null;
}

/** A Word document, one item per heading section. */
export async function parseDocx(bytes: Uint8Array, name: string): Promise<KnowledgeDocument[]> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.convertToHtml({
    buffer: Buffer.from(bytes as unknown as ArrayLike<number>),
  });
  const parts = String(value).split(/(?=<h[1-3][^>]*>)/i);
  const docs: KnowledgeDocument[] = [];
  parts.forEach((part, index) => {
    const { title, text } = stripHtml(part);
    const heading = stripHtml(part.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? "").text;
    if (text.trim().length < 40) return;
    docs.push({
      sourceRef: `section-${index + 1}`,
      title: heading || title || `${name} — part ${index + 1}`,
      content: text,
      metadata: { file: name, section: index + 1 },
    });
  });
  if (docs.length === 0) throw new Error("That document had no readable text in it.");
  return docs;
}

/** A photo of a price list or menu, read out in words. */
export async function readImage(
  supabase: SupabaseClient,
  organizationId: string,
  bytes: Uint8Array,
  name: string,
  mime: string | null = null,
  channel: "onboarding" | null = null,
): Promise<KnowledgeDocument[]> {
  const { executeRun, meterAiUsage } = await import("@/lib/ai-run.server");
  const base64 = Buffer.from(bytes as unknown as ArrayLike<number>).toString("base64");
  const imageMime = mime && mime.startsWith("image/") ? mime.split(";")[0]! : "image/jpeg";
  const run = await executeRun(supabase, {
    organizationId,
    task: "agent_reply",
    tier: "everyday",
    input: "Read this picture.",
    imageDataUrl: `data:${imageMime};base64,${base64}`,
    system:
      "Transcribe every piece of text in this image exactly, keeping prices and numbers as written; " +
      "then list the items or services shown.",
    metadata: { purpose: "knowledge_image" },
    billingExempt: true,
    channel,
  });
  if (run.status !== "ok") {
    throw new Error(run.error || "The picture couldn't be read right now.");
  }
  // Platform-paid, but the cost still lands on the workspace's meter like a reader call.
  await meterAiUsage(supabase, organizationId, "knowledge_image", {
    costAmount: run.costAmount ?? 0,
    inputTokens: run.inputTokens ?? 0,
    outputTokens: run.outputTokens ?? 0,
    runs: 1,
  });
  const text = (run.output ?? "").trim();
  if (text.length < 20) throw new Error("We couldn't read any text in that picture.");
  return [
    {
      sourceRef: `image-${await hashText(name + text.slice(0, 200))}`,
      title: name,
      content: text,
      metadata: { file: name, kind: "image" },
    },
  ];
}

/**
 * On-demand read: a customer asked something the knowledge doesn't cover.
 * If an unread page of the site clearly matches the question by its address
 * or title, read that one page now and add it. Max 1 per question and 3 per
 * conversation. Returns true when a page was added. Never throws.
 */
export async function readOnDemand(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string | null,
  question: string,
): Promise<boolean> {
  try {
    const { loadReadingSettings, questionWords } = await import("@/lib/reading.server");
    const reading = await loadReadingSettings(supabase);
    if (!reading.on_demand_read || !conversationId) return false;
    const { count } = await supabase
      .from("knowledge_urls")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("read_via", "on_demand");
    if ((count ?? 0) >= 3) return false;

    const words = questionWords(question).map((w) => w.replace(/(es|s)$/, ""));
    if (!words.length) return false;
    // A deleted website (kept for Undo) is never read into.
    const { data: off } = await supabase
      .from("knowledge_sources")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("status", "disabled");
    const skip = new Set(((off ?? []) as Array<{ id: string }>).map((r) => r.id));
    const { data } = await supabase
      .from("knowledge_urls")
      .select("id, source_id, url, title")
      .eq("organization_id", organizationId)
      .eq("status", "unread")
      .order("priority", { ascending: false })
      .limit(3000);
    let best: { id: string; source_id: string; url: string; title: string | null } | null = null;
    let bestScore = 0;
    for (const row of (data ?? []) as Array<{ id: string; source_id: string; url: string; title: string | null }>) {
      if (skip.has(row.source_id)) continue;
      const hay = `${decodeURIComponent(row.url).toLowerCase().replace(/[-_/]+/g, " ")} ${(row.title ?? "").toLowerCase()}`;
      const score = words.filter((w) => hay.includes(w)).length;
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    const strong = bestScore >= 2 || (bestScore === 1 && words.length <= 2 && (words.find((w) => best && best.url.toLowerCase().includes(w))?.length ?? 0) >= 5);
    if (!best || !strong) return false;

    const { engineOrder } = await import("@/lib/web-reader.server");
    const page = await readPage(best.url, {
      order: engineOrder(reading.reader_primary, reading.reader_fallback_order),
      tavilyDepth: reading.tavily_extract_depth,
      tavilyBudget: { supabase, organizationId },
      allowReader: false,
      timeoutMs: 12000,
      budget: { supabase, organizationId },
    });
    if (!page || page.text.length <= 200) return false;
    await upsertDocument(supabase, organizationId, best.source_id, {
      sourceRef: best.url,
      title: page.title || new URL(best.url).pathname,
      content: page.text.slice(0, 40000),
      metadata: { url: best.url, on_demand: true, engine: page.engine ?? "own" },
    });
    await supabase
      .from("knowledge_urls")
      .update({ status: "read", read_at: new Date().toISOString(), read_via: "on_demand", conversation_id: conversationId, title: page.title || null })
      .eq("id", best.id);
    await logServerActivity(supabase, organizationId, null, "knowledge_on_demand_read", { source_id: best.source_id, url: best.url }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error("[on-demand-read] failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * full_crawl_trigger = on_number_connected: a paid workspace that just
 * connected a number gets its websites queued for the full read. Never throws.
 */
export async function queueFullReadOnConnect(supabase: SupabaseClient, organizationId: string): Promise<void> {
  try {
    const { loadReadingSettings } = await import("@/lib/reading.server");
    const reading = await loadReadingSettings(supabase);
    if (reading.full_crawl_trigger !== "on_number_connected") return;
    const plan = await planLimits(supabase, organizationId);
    if (!plan.paid) return;
    const { data } = await supabase
      .from("knowledge_sources")
      .select("id, config, pages_seen, last_full_read_at")
      .eq("organization_id", organizationId)
      .eq("type", "website")
      .eq("status", "ready");
    for (const src of (data ?? []) as Array<{ id: string; config: Record<string, unknown> | null; pages_seen: number | null; last_full_read_at: string | null }>) {
      if (src.last_full_read_at) continue;
      await supabase
        .from("knowledge_sources")
        .update({
          status: "pending",
          queued_at: new Date().toISOString(),
          sync_started_at: null,
          config: { ...(src.config ?? {}), mode: "full", resume: true, refresh: false, pages_done: Number(src.pages_seen ?? 0), run_limit: null },
        })
        .eq("id", src.id)
        .eq("status", "ready");
    }
  } catch (error) {
    console.error("[full-read-on-connect] failed", error instanceof Error ? error.message : String(error));
  }
}

// ------------------------------------------------------------ safe delete

/** Days a deleted website is kept (Undo) before it is forgotten for good. */
export const SOFT_DELETE_DAYS = 7;

/** Deleted, still restorable: status disabled with a deleted_at stamp. */
export function isSoftDeleted(source: { status?: string | null; config?: Record<string, unknown> | null }): boolean {
  return source.status === "disabled" && typeof source.config?.["deleted_at"] === "string";
}

type WebsiteRow = {
  id: string;
  organization_id: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, unknown> | null;
};

/** Visible crawled products of this site (any way its address is written). */
async function siteProductIds(supabase: SupabaseClient, organizationId: string, origin: string): Promise<string[]> {
  const ids: string[] = [];
  for (const prefix of [origin, ...aliasOrigins(origin)]) {
    const { data } = await supabase
      .from("products")
      .select("id, product_url")
      .eq("organization_id", organizationId)
      .eq("source", "crawl")
      .eq("is_visible", true)
      .like("product_url", `${prefix}/%`)
      .limit(10000);
    for (const row of (data ?? []) as Array<{ id: string; product_url: string | null }>) ids.push(row.id);
  }
  return Array.from(new Set(ids));
}

/**
 * Deleting a website: Aiden stops using it at once (its chunks leave
 * retrieval, its products leave search) but nothing is removed for
 * SOFT_DELETE_DAYS, so Undo brings back exactly what was there. Products
 * another live source of the same site still uses stay visible.
 */
export async function softDeleteWebsiteSource(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  userId: string | null,
): Promise<{ ok: boolean; error?: string; pages: number; products: number; purgeAfter: string | null }> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, status, config, item_count")
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const src = data as (WebsiteRow & { item_count: number | null }) | null;
  if (!src || src.type !== "website") return { ok: false, error: "That website isn't in this workspace.", pages: 0, products: 0, purgeAfter: null };
  if (isSoftDeleted(src)) return { ok: true, pages: 0, products: 0, purgeAfter: String(src.config?.["purge_after"] ?? "") || null };
  if (src.status === "syncing") return { ok: false, error: "I'm reading this site right now — try again in a minute.", pages: 0, products: 0, purgeAfter: null };

  let productIds: string[] = [];
  let origin: string | null = null;
  try {
    origin = new URL(String(src.config?.["url"] ?? "")).origin;
  } catch {
    origin = null;
  }
  if (origin) {
    // Another live source reading the same site keeps its products in search.
    const { data: others } = await supabase
      .from("knowledge_sources")
      .select("id, status, config")
      .eq("organization_id", organizationId)
      .eq("type", "website")
      .neq("id", sourceId);
    const shared = ((others ?? []) as Array<{ id: string; status: string; config: Record<string, unknown> | null }>).some((o) => {
      if (isSoftDeleted(o)) return false;
      try {
        return sameSite(new URL(String(o.config?.["url"] ?? "")), new URL(origin!));
      } catch {
        return false;
      }
    });
    if (!shared) productIds = await siteProductIds(supabase, organizationId, origin);
  }
  for (let i = 0; i < productIds.length; i += 200)
    await supabase.from("products").update({ is_visible: false }).in("id", productIds.slice(i, i + 200));

  const now = new Date();
  const purgeAfter = new Date(now.getTime() + SOFT_DELETE_DAYS * 86_400_000).toISOString();
  await supabase
    .from("knowledge_sources")
    .update({
      status: "disabled",
      queued_at: null,
      sync_started_at: null,
      config: {
        ...(src.config ?? {}),
        deleted_at: now.toISOString(),
        deleted_by: userId,
        purge_after: purgeAfter,
        // A source deleted while queued comes back ready, not mid-read.
        deleted_prev_status: src.status === "pending" ? "ready" : src.status,
        deleted_products: productIds,
      },
    })
    .eq("id", sourceId);
  return { ok: true, pages: Number(src.item_count ?? 0), products: productIds.length, purgeAfter };
}

/** Undo: the source answers again and its products are back in search, exactly as before. */
export async function restoreWebsiteSource(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
): Promise<{ ok: boolean; error?: string; products: number }> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, status, config")
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const src = data as WebsiteRow | null;
  if (!src || !isSoftDeleted(src)) return { ok: false, error: "That website isn't waiting to be restored.", products: 0 };
  const ids = Array.isArray(src.config?.["deleted_products"]) ? (src.config!["deleted_products"] as string[]) : [];
  for (let i = 0; i < ids.length; i += 200)
    await supabase.from("products").update({ is_visible: true }).in("id", ids.slice(i, i + 200));
  const { deleted_at: _d, deleted_by: _b, purge_after: _p, deleted_prev_status: prev, deleted_products: _x, ...config } = src.config ?? {};
  const status = typeof prev === "string" && ["ready", "error"].includes(prev) ? prev : "ready";
  await supabase.from("knowledge_sources").update({ status, config }).eq("id", sourceId);
  return { ok: true, products: ids.length };
}

/** Nightly: deleted websites past their Undo window are removed for good. */
export async function purgeDeletedSources(supabase: SupabaseClient, now = new Date()): Promise<number> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, status, config")
    .eq("type", "website")
    .eq("status", "disabled")
    .lt("config->>purge_after", now.toISOString())
    .limit(200);
  let purged = 0;
  for (const row of (data ?? []) as Array<{ id: string; organization_id: string; status: string; config: Record<string, unknown> | null }>) {
    if (!isSoftDeleted(row)) continue;
    const after = Date.parse(String(row.config?.["purge_after"] ?? ""));
    if (!Number.isFinite(after) || after > now.getTime()) continue;
    // Pages, chunks and the address list go with the source (cascade).
    // Products stay hidden, never deleted.
    const { error } = await supabase.from("knowledge_sources").delete().eq("id", row.id).eq("status", "disabled");
    if (!error) purged += 1;
  }
  return purged;
}

// ------------------------------------------------------- one page, now

/** "Re-read this page": at most this many per workspace per day. */
export const PAGE_REREADS_PER_DAY = 20;

/** Pages this workspace re-read by hand in the last 24 hours. */
export async function pageRereadsToday(supabase: SupabaseClient, organizationId: string, now = Date.now()): Promise<number> {
  const { count } = await supabase
    .from("activity_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("action", "knowledge_page_reread")
    .gte("created_at", new Date(now - 86_400_000).toISOString());
  return count ?? 0;
}

/**
 * Read one page of a website source now and save it the same way a full read
 * does (document, chunks, product). Own fetch first; a paid reader only for a
 * page that comes back nearly empty. A page that comes back too thin keeps
 * its old text.
 */
export async function rereadOnePage(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  url: string,
): Promise<{ ok: boolean; error?: string; title?: string; chars?: number; saved?: boolean; product?: string | null }> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, status, config")
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const src = data as WebsiteRow | null;
  if (!src || src.type !== "website" || isSoftDeleted(src)) return { ok: false, error: "That website isn't in this workspace." };
  let origin: string;
  try {
    origin = new URL(String(src.config?.["url"] ?? "")).origin;
  } catch {
    return { ok: false, error: "This website has no address yet." };
  }
  const page = normalizeUrl(url, url, origin);
  if (!page) return { ok: false, error: `That page isn't on ${new URL(origin).hostname}.` };
  if (urlBlocked(page)) return { ok: false, error: "This address points to a private network and can't be read." };

  const { loadReadingSettings } = await import("@/lib/reading.server");
  const { engineOrder } = await import("@/lib/web-reader.server");
  const reading = await loadReadingSettings(supabase);
  const settingsOrder = engineOrder(reading.reader_primary, reading.reader_fallback_order);
  const order = ["own", ...settingsOrder.filter((engine) => engine !== "own")] as ReaderEngine[];
  const read = await readPage(page, {
    order,
    tavilyDepth: reading.tavily_extract_depth,
    budget: { supabase, organizationId },
    tavilyBudget: { supabase, organizationId },
    allowReader: false,
    timeoutMs: PAGE_TIMEOUT_MS,
    rerender: false,
  });
  const platform = typeof src.config?.["platform"] === "string" ? String(src.config["platform"]) : null;
  const saved = await savePage(
    { supabase, organizationId, sourceId, origin, platform, readVia: "page_reread", facts: true, factsOnProductPages: false },
    page,
    read,
  );
  if (saved.failed || saved.gone) {
    return { ok: false, error: saved.gone ? "That page no longer exists on the site." : "I couldn't open that page just now." };
  }
  const [{ count }, products] = await Promise.all([
    supabase.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("source_id", sourceId),
    countCrawledProducts(supabase, organizationId, origin),
  ]);
  await supabase
    .from("knowledge_sources")
    .update({ products_found: products, ...(typeof count === "number" ? { item_count: count } : {}) })
    .eq("id", sourceId);
  return { ok: true, title: saved.title, chars: saved.chars, saved: saved.saved, product: saved.product?.title ?? null };
}

// ------------------------------------------------------------- stall reset

/** A read still "syncing" after this long died with its request. */
export const STALE_SYNC_MS = 10 * 60_000;

/**
 * A read that died mid-way goes back in the queue. A website read resumes
 * where it got to — the pages it saved are already marked read — and its
 * progress never goes back to 0.
 */
export function staleResetPatch(row: {
  type: string;
  config: Record<string, unknown> | null;
  pages_seen: number | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    status: "pending",
    queued_at: new Date().toISOString(),
    sync_started_at: null,
  };
  const config = row.config ?? {};
  if (row.type === "website" && config["mode"] === "full" && config["refresh"] !== true && config["single_page"] !== true) {
    patch["config"] = {
      ...config,
      resume: true,
      pages_done: Math.max(Number(config["pages_done"] ?? 0) || 0, Number(row.pages_seen ?? 0) || 0),
    };
  }
  return patch;
}

/** Worker tick: every read stuck in "syncing" goes back in the queue (see staleResetPatch). */
export async function resetStaleReads(supabase: SupabaseClient, now = Date.now()): Promise<number> {
  const stale = new Date(now - STALE_SYNC_MS).toISOString();
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, type, config, pages_seen")
    .eq("status", "syncing")
    .lt("sync_started_at", stale)
    .limit(100);
  let reset = 0;
  for (const row of (data ?? []) as Array<{ id: string; type: string; config: Record<string, unknown> | null; pages_seen: number | null }>) {
    const { error } = await supabase
      .from("knowledge_sources")
      .update(staleResetPatch(row))
      .eq("id", row.id)
      .eq("status", "syncing");
    if (!error) reset += 1;
  }
  return reset;
}

// ------------------------------------------------------------ links list

export type LinkTab = "read" | "not_found" | "excluded" | "waiting";
export type LinkRow = {
  url: string;
  title: string | null;
  type: ReturnType<typeof import("@/lib/site-urls").pageType>;
  tab: LinkTab;
  chars: number | null;
  read_at: string | null;
};

async function websiteRow(supabase: SupabaseClient, organizationId: string, sourceId: string): Promise<WebsiteRow | null> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, status, config")
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const src = data as WebsiteRow | null;
  return src && src.type === "website" ? src : null;
}

/**
 * Every address of a website source, as the merchant sees it: Read (with how
 * much text and when), Not found (gone or unreadable), Excluded (by their
 * rules) and Waiting (found, not read yet). Paged, searchable.
 */
export async function listWebsiteLinks(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  options: { tab?: LinkTab; q?: string; page?: number; pageSize?: number } = {},
): Promise<{ ok: boolean; error?: string; rows: LinkRow[]; counts: Record<LinkTab, number>; total: number; rules: ExcludeRule[]; page: number; page_size: number }> {
  const counts: Record<LinkTab, number> = { read: 0, not_found: 0, excluded: 0, waiting: 0 };
  const src = await websiteRow(supabase, organizationId, sourceId);
  if (!src) return { ok: false, error: "That website isn't in this workspace.", rows: [], counts, total: 0, rules: [], page: 0, page_size: 0 };
  const { pageType } = await import("@/lib/site-urls");
  const rules = readExcludeRules(src.config?.["exclude_rules"]);
  const includeUrls = Array.isArray(src.config?.["include_urls"]) ? (src.config!["include_urls"] as unknown[]).map(String) : [];
  const [{ data: urlRows }, { data: docRows }] = await Promise.all([
    supabase.from("knowledge_urls").select("url, title, status, read_at, read_via").eq("source_id", sourceId).limit(20000),
    supabase.from("knowledge_documents").select("source_ref, title, chars:metadata->>chars, metadata").eq("source_id", sourceId).limit(20000),
  ]);
  const docs = new Map<string, { title: string | null; chars: number | null }>();
  for (const d of (docRows ?? []) as Array<{ source_ref: string; title: string | null; chars?: string | number | null; metadata?: Record<string, unknown> | null }>) {
    const raw = d.chars ?? d.metadata?.["chars"] ?? null;
    docs.set(d.source_ref, { title: d.title, chars: raw == null || raw === "" ? null : Number(raw) });
  }
  const all: LinkRow[] = [];
  const seen = new Set<string>();
  for (const r of (urlRows ?? []) as Array<{ url: string; title: string | null; status: string | null; read_at: string | null; read_via: string | null }>) {
    seen.add(r.url);
    const doc = docs.get(r.url);
    const tab: LinkTab = isExcluded(r.url, rules, includeUrls)
      ? "excluded"
      : r.status === "read"
        ? ["gone", "failed"].includes(r.read_via ?? "") ? "not_found" : "read"
        : "waiting";
    all.push({ url: r.url, title: r.title ?? doc?.title ?? null, type: pageType(r.url), tab, chars: doc?.chars ?? null, read_at: r.read_at });
  }
  // Pages saved before the address list existed still count as read.
  for (const [url, doc] of docs) {
    if (seen.has(url) || !/^https?:\/\//i.test(url)) continue;
    all.push({ url, title: doc.title, type: pageType(url), tab: isExcluded(url, rules, includeUrls) ? "excluded" : "read", chars: doc.chars, read_at: null });
  }
  for (const row of all) counts[row.tab] += 1;
  const q = (options.q ?? "").trim().toLowerCase();
  const tab = options.tab ?? "read";
  const filtered = all
    .filter((r) => r.tab === tab && (!q || r.url.toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q)))
    .sort((a, b) => a.url.localeCompare(b.url));
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const page = Math.max(options.page ?? 0, 0);
  return { ok: true, rows: filtered.slice(page * pageSize, page * pageSize + pageSize), counts, total: filtered.length, rules, page, page_size: pageSize };
}

/** Pages and products of addresses a rule now excludes: Aiden stops using them. */
async function forgetExcluded(supabase: SupabaseClient, organizationId: string, sourceId: string, test: (url: string) => boolean): Promise<{ pages: number; products: number }> {
  const { data: docs } = await supabase.from("knowledge_documents").select("id, source_ref").eq("source_id", sourceId).limit(20000);
  const ids = ((docs ?? []) as Array<{ id: string; source_ref: string }>).filter((d) => test(d.source_ref)).map((d) => d.id);
  for (let i = 0; i < ids.length; i += 200) await supabase.from("knowledge_documents").delete().in("id", ids.slice(i, i + 200));
  const { data: urls } = await supabase.from("knowledge_urls").select("url").eq("source_id", sourceId).limit(20000);
  const gone = ((urls ?? []) as Array<{ url: string }>).map((u) => u.url).filter(test);
  let products = 0;
  for (let i = 0; i < gone.length; i += 200) {
    const { data: hit } = await supabase
      .from("products")
      .update({ is_visible: false })
      .eq("organization_id", organizationId)
      .eq("source", "crawl")
      .in("external_id", gone.slice(i, i + 200))
      .select("id");
    products += ((hit ?? []) as unknown[]).length;
  }
  return { pages: ids.length, products };
}

/**
 * The merchant's exclude/include controls for one website:
 *  - exclude a rule (starts with / contains / ends with / exact), one link,
 *    or the folder a link sits in — its pages leave Aiden's knowledge and its
 *    products leave search, and no read takes them again;
 *  - include a link back, or remove a rule — those addresses wait to be read
 *    again (the next read, or "Re-read this page").
 */
export async function changeWebsiteLinks(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  change:
    | { exclude: ExcludeRule }
    | { exclude_url: string; folder?: boolean }
    | { include_url: string }
    | { remove_rule: ExcludeRule },
): Promise<{ ok: boolean; error?: string; rules: ExcludeRule[]; forgotten?: { pages: number; products: number }; waiting?: number }> {
  const src = await websiteRow(supabase, organizationId, sourceId);
  if (!src || isSoftDeleted(src)) return { ok: false, error: "That website isn't in this workspace.", rules: [] };
  const { folderRule } = await import("@/lib/site-urls");
  const config = { ...(src.config ?? {}) };
  let rules = readExcludeRules(config["exclude_rules"]);
  let includeUrls = Array.isArray(config["include_urls"]) ? (config["include_urls"] as unknown[]).map(String) : [];
  let origin = "";
  try {
    origin = new URL(String(config["url"] ?? "")).origin;
  } catch {
    return { ok: false, error: "This website has no address yet.", rules };
  }
  const page = (raw: string) => normalizeUrl(raw, origin, origin, config["keep_query"] === true);

  let added: ExcludeRule | null = null;
  let reopened: (url: string) => boolean = () => false;
  if ("exclude" in change) {
    added = readExcludeRules([change.exclude])[0] ?? null;
    if (!added) return { ok: false, error: "Write what to leave out first.", rules };
  } else if ("exclude_url" in change) {
    const url = page(change.exclude_url);
    if (!url) return { ok: false, error: `That page isn't on ${new URL(origin).hostname}.`, rules };
    added = change.folder ? folderRule(url) : { op: "exact", value: new URL(url).pathname + new URL(url).search };
    if (!added) return { ok: false, error: "That page isn't inside a folder.", rules };
    includeUrls = includeUrls.filter((u) => u !== url);
  } else if ("include_url" in change) {
    const url = page(change.include_url);
    if (!url) return { ok: false, error: `That page isn't on ${new URL(origin).hostname}.`, rules };
    // Its own exact rule goes; under a broader rule it is let back in by hand.
    rules = rules.filter((r) => !(r.op === "exact" && isExcluded(url, [r])));
    if (isExcluded(url, rules)) includeUrls = Array.from(new Set([...includeUrls, url]));
    reopened = (u) => u === url;
  } else {
    const target = readExcludeRules([change.remove_rule])[0];
    if (!target) return { ok: false, error: "Which rule?", rules };
    rules = rules.filter((r) => !(r.op === target.op && r.value === target.value));
    reopened = (u) => isExcluded(u, [target]) && !isExcluded(u, rules, includeUrls);
  }
  if (added && !rules.some((r) => r.op === added!.op && r.value === added!.value)) rules = [...rules, added];

  await supabase
    .from("knowledge_sources")
    .update({ config: { ...config, exclude_rules: rules, include_urls: includeUrls } })
    .eq("id", sourceId);

  let forgotten: { pages: number; products: number } | undefined;
  if (added) {
    const rule = added;
    forgotten = await forgetExcluded(supabase, organizationId, sourceId, (u) => isExcluded(u, [rule], includeUrls));
  }
  // Let back in: those addresses wait for the next read.
  let waiting = 0;
  const { data: rows } = await supabase.from("knowledge_urls").select("url").eq("source_id", sourceId).limit(20000);
  const back = ((rows ?? []) as Array<{ url: string }>).map((r) => r.url).filter(reopened);
  for (let i = 0; i < back.length; i += 200) {
    await supabase.from("knowledge_urls").update({ status: "unread" }).eq("source_id", sourceId).in("url", back.slice(i, i + 200));
    waiting += Math.min(200, back.length - i);
  }
  return { ok: true, rules, ...(forgotten ? { forgotten } : {}), waiting };
}

/**
 * "Change website address": the same source reads a new address (its pages,
 * products and history stay; the swap rule decides what the new read
 * replaces). Products under the old address are hidden once the new full
 * read is in, as with a redirect.
 */
export async function changeWebsiteAddress(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  url: string,
): Promise<{ ok: boolean; error?: string; url?: string }> {
  const src = await websiteRow(supabase, organizationId, sourceId);
  if (!src || isSoftDeleted(src)) return { ok: false, error: "That website isn't in this workspace." };
  if (src.status === "syncing") return { ok: false, error: "I'm reading this site right now — try again in a minute." };
  let next: URL;
  try {
    next = new URL(url.trim());
  } catch {
    return { ok: false, error: "That isn't a full web address." };
  }
  if (!/^https?:$/.test(next.protocol) || urlBlocked(next.toString())) return { ok: false, error: "This address can't be read." };
  if (listingLabel(next.toString())) return { ok: false, error: "That's a marketplace or social page — add it as its own link instead." };
  next.hash = "";
  const config = { ...(src.config ?? {}) };
  let previous: string[] = Array.isArray(config["previous_origins"]) ? (config["previous_origins"] as string[]) : [];
  try {
    const old = new URL(String(config["url"] ?? "")).origin;
    if (old !== next.origin) previous = Array.from(new Set([...previous, old]));
  } catch {
    // no old address to remember
  }
  for (const k of ["platform", "resume", "refresh", "refresh_started_at", "full_read_started_at", "run_limit", "robots_disallow", "prev_snapshot", "swap_blocked"]) delete config[k];
  await supabase
    .from("knowledge_sources")
    .update({
      name: next.hostname,
      config: { ...config, url: next.toString(), previous_origins: previous, pages_done: 0, paid_pages: 0 },
      status: "pending",
      queued_at: new Date().toISOString(),
      sync_started_at: null,
      last_error: null,
    })
    .eq("id", sourceId);
  return { ok: true, url: next.toString() };
}

// ------------------------------------------------------- admin: reading

/**
 * Super admin, one workspace: read every website again from scratch, now.
 * Skips the trial gate (full mode on any plan) and the "Re-read whole site"
 * cooldown. The plan's paid-page limit still applies unless ignorePaidCaps;
 * the platform's monthly Tavily/Firecrawl credit caps always do.
 */
export async function forceFullRead(
  supabase: SupabaseClient,
  organizationId: string,
  options: { sourceId?: string | null; ignorePaidCaps?: boolean; userId?: string | null } = {},
): Promise<{ queued: number; skipped: number }> {
  let query = supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, status, config")
    .eq("organization_id", organizationId)
    .eq("type", "website");
  if (options.sourceId) query = query.eq("id", options.sourceId);
  const { data } = await query;
  let queued = 0;
  let skipped = 0;
  for (const src of (data ?? []) as WebsiteRow[]) {
    if (isSoftDeleted(src) || src.status === "syncing" || src.config?.["single_page"] === true) {
      skipped += 1;
      continue;
    }
    const config = { ...(src.config ?? {}) };
    for (const k of ["refresh_started_at", "full_read_started_at", "run_limit", "prev_snapshot", "changed_only", "paid_capped"]) delete config[k];
    await supabase
      .from("knowledge_sources")
      .update({
        config: { ...config, mode: "full", resume: false, refresh: false, pages_done: 0, paid_pages: 0, force_paid: options.ignorePaidCaps === true },
        status: "pending",
        queued_at: new Date().toISOString(),
        sync_started_at: null,
        last_error: null,
      })
      .eq("id", src.id);
    queued += 1;
  }
  await logServerActivity(supabase, organizationId, options.userId ?? null, "reading_force_full", {
    source_id: options.sourceId ?? null,
    ignore_paid_caps: options.ignorePaidCaps === true,
    queued,
    skipped,
  }).catch(() => undefined);
  return { queued, skipped };
}

const READ_LOG_ACTIONS = ["reading_run", "reading_host_changed", "reading_swap_blocked", "reading_site_changed", "reading_force_full"];

/** Super admin: one workspace's website sources and their read log (runs, pages, engines, cost, errors). */
export async function readingLog(
  supabase: SupabaseClient,
  organizationId: string,
  limit = 200,
): Promise<{
  sources: Array<Record<string, unknown>>;
  log: Array<{ source_id: string | null; action: string; at: string; details: Record<string, unknown> }>;
}> {
  const [{ data: sources }, { data: rows }] = await Promise.all([
    supabase
      .from("knowledge_sources")
      .select("id, name, status, pages_seen, item_count, products_found, last_synced_at, last_full_read_at, last_error, config")
      .eq("organization_id", organizationId)
      .eq("type", "website")
      .order("created_at", { ascending: false }),
    supabase
      .from("activity_log")
      .select("action, details, created_at")
      .eq("organization_id", organizationId)
      .in("action", READ_LOG_ACTIONS)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  return {
    sources: ((sources ?? []) as Array<Record<string, unknown>>).map((s) => {
      const config = (s["config"] ?? {}) as Record<string, unknown>;
      return {
        id: s["id"],
        name: s["name"],
        status: s["status"],
        url: config["url"] ?? null,
        mode: config["mode"] ?? null,
        discovery: config["discovery"] ?? "crawl",
        pages_seen: s["pages_seen"],
        item_count: s["item_count"],
        products_found: s["products_found"],
        paid_pages: config["paid_pages"] ?? 0,
        resume: config["resume"] === true,
        deleted: isSoftDeleted({ status: String(s["status"] ?? ""), config }),
        swap_blocked: config["swap_blocked"] ?? null,
        last_synced_at: s["last_synced_at"],
        last_full_read_at: s["last_full_read_at"],
        last_error: s["last_error"],
      };
    }),
    log: ((rows ?? []) as Array<{ action: string; details: Record<string, unknown> | null; created_at: string }>).map((r) => ({
      source_id: typeof r.details?.["source_id"] === "string" ? String(r.details["source_id"]) : null,
      action: r.action,
      at: r.created_at,
      details: r.details ?? {},
    })),
  };
}
