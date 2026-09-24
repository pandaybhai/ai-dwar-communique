/**
 * Reading one web page properly.
 *
 * Our own fetch handles ordinary HTML. Sites that paint themselves in the
 * browser hand back an empty shell, and for those we pay a reader service to
 * render the page and give us the text. Every reader call costs money, so the
 * caller keeps a running total and stops asking once the day's cap is spent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { firecrawlMap, firecrawlScrape, type FirecrawlBudget } from "@/lib/firecrawl.server";
import { tavilyExtract, tavilyMap, type TavilyBudget } from "@/lib/tavily.server";

/** The three readers behind one interface. */
export type ReaderEngine = "own" | "tavily" | "firecrawl";
export const READER_ENGINES: ReaderEngine[] = ["own", "tavily", "firecrawl"];
/** Below this much main text a page counts as "not read" and the next engine tries. */
export const MIN_MAIN_TEXT = 300;

export const READER_COST = 0.2;
const READER_ENDPOINT = "https://r.jina.ai/";

export type PageRead = {
  title: string;
  text: string;
  html: string;
  links: string[];
  usedReader: boolean;
  /** Which engine produced the text (saved as knowledge_documents metadata.engine). */
  engine?: ReaderEngine;
  /** Credits this page cost on that engine (Tavily batches share a credit). */
  credits?: number;
  /** What our own fetch saw, for diagnostics. */
  status?: number;
  bytes?: number;
  extractedChars?: number;
  contentType?: string;
  headers?: Record<string, string>;
};


class ReaderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderRequestError";
  }
}

function bodyPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function stripHtml(html: string): { title: string; text: string; links: string[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const links = Array.from(html.matchAll(/href=["']([^"'#]+)["']/gi)).map((m) => m[1] ?? "");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")

    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { title: (titleMatch?.[1] ?? "").trim(), text, links };
}

/**
 * Shops answer robots differently from people. We ask as an ordinary browser
 * would, otherwise big storefronts hand back a block page or nothing at all.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
};

/** A fetch that always gives up rather than hanging a crawl. */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...init,
      headers: { ...BROWSER_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The platform's reader key, when one is configured. Null is fine. */
const READER_KEY_NAME = "jina_reader_key";
let readerKeyCache: { value: string | null; at: number } | null = null;
const READER_KEY_TTL_MS = 10 * 60_000;

export async function readerKey(supabase: SupabaseClient): Promise<string | null> {
  if (readerKeyCache && Date.now() - readerKeyCache.at < READER_KEY_TTL_MS) {
    return readerKeyCache.value;
  }
  const { data, error } = await supabase.rpc("read_vault_secret", { p_name: READER_KEY_NAME });
  const value =
    !error && typeof data === "string" && data.trim().length > 0 ? data.trim() : null;
  readerKeyCache = { value, at: Date.now() };
  return value;
}

/**
 * A shell page: markup arrived, words did not. Anything with 300 real
 * characters is good enough on its own — we never pay the reader for it.
 */
function looksEmpty(_html: string, text: string): boolean {
  return text.length < 300;
}

async function readLegacy(
  url: string,
  options: {
    key?: string | null;
    allowReader?: boolean;
    timeoutMs?: number;
    /** Firecrawl credits are charged here; without it we read with our own fetch. */
    budget?: FirecrawlBudget;
    onStage?: (stage: "fetch" | "reader" | "extract") => void;
    /** firecrawl (default) | auto: own fetch first, Firecrawl for thin/JS pages | own: never Firecrawl. */
    engine?: "firecrawl" | "auto" | "own";
  } = {},
): Promise<PageRead | null> {
  options.onStage?.("fetch");
  const timeout = options.timeoutMs ?? 20000;

  if (options.engine === "auto") {
    const own = await readLegacy(url, { ...options, engine: "own", allowReader: false });
    if (own && own.contentType?.toLowerCase().includes("text/html") && !looksEmpty(own.html, own.text)) return own;
  }

  // Firecrawl is the primary reader when its key is configured: it renders
  // the page and hands back clean text plus the processed markup. Any
  // failure falls through to our own fetch below.
  const scraped = options.engine === "own" ? null : await firecrawlScrape(url, options.budget, timeout);
  if (scraped) {
    const { links } = stripHtml(scraped.html);
    return {
      title: scraped.title,
      text: scraped.markdown.replace(/\s+/g, " ").trim(),
      html: scraped.html,
      links,
      usedReader: false,
      engine: "firecrawl",
      credits: 1,
      status: scraped.statusCode,
      bytes: scraped.html.length,
      extractedChars: scraped.markdown.length,
      contentType: "text/html",
      headers: {},
    };
  }

  // Big storefronts are slow and occasionally drop the first connection, so a
  // single miss must not push us onto the paid reader.
  let res = await fetchWithTimeout(url, timeout);
  if (!res || res.status >= 500) res = (await fetchWithTimeout(url, timeout)) ?? res;
  const type = res?.headers.get("content-type") ?? "";
  const readableDirect = Boolean(res?.ok && type.toLowerCase().includes("text/html"));
  const html = readableDirect ? (await res?.text().catch(() => "")) ?? "" : "";
  options.onStage?.("extract");
  const { title, text, links } = stripHtml(html);
  const headers: Record<string, string> = {};
  if (res) {
    for (const name of ["content-type", "x-shopid", "x-shopify-stage", "powered-by", "x-powered-by"]) {
      const value = res.headers.get(name);
      if (value) headers[name] = value;
    }
  }
  const diagnostics = {
    status: res?.status ?? 0,
    bytes: html.length,
    extractedChars: text.length,
    contentType: type,
    headers,
  };


  if (options.allowReader !== false && (!readableDirect || looksEmpty(html, text))) {
    options.onStage?.("reader");
    const readerUrl = `${READER_ENDPOINT}${url}`;
    const cleanKey = options.key?.trim() || null;
    const readerRequest = async (withKey: boolean) => {
      const headers: Record<string, string> = {
        Accept: "text/plain",
        "X-Return-Format": "text",
      };
      if (withKey && cleanKey) headers["Authorization"] = `Bearer ${cleanKey}`;
      const authUsed = Boolean(withKey && cleanKey);
      const response = await fetchWithTimeout(readerUrl, 15000, { headers });
      const auth = `auth=${authUsed ? "yes" : "no"}`;
      if (!response) {
        console.error("[web-reader]", JSON.stringify({ url: readerUrl, auth: authUsed, status: 0, body: "request failed or timed out" }));
        return { response: null, body: "", detail: `reader request failed or timed out; url=${readerUrl}; ${auth}` };
      }
      const body = await response.text().catch((error) => `body read failed: ${error instanceof Error ? error.message : String(error)}`);
      const preview = bodyPreview(body);
      console.info("[web-reader]", JSON.stringify({ url: readerUrl, auth: authUsed, status: response.status, body: preview }));
      return { response, body, detail: `reader HTTP ${response.status}; url=${readerUrl}; ${auth}; body=${preview}` };
    };

    let attempt = await readerRequest(Boolean(cleanKey));
    if ((!attempt.response || !attempt.response.ok) && cleanKey) attempt = await readerRequest(false);
    if (attempt.response?.ok) {
      const rendered = attempt.body.replace(/\s+/g, " ").trim();
      if (rendered.length > text.length) {
        return { title, text: rendered, html, links, usedReader: true, ...diagnostics };
      }
    }
    // A reader outage must never discard text our own fetch already found.
    if (readableDirect && text.length > 0)
      return { title, text, html, links, usedReader: false, ...diagnostics };
    throw new ReaderRequestError(attempt.detail);
  }

  if (!readableDirect) return null;
  return { title, text, html, links, usedReader: false, ...diagnostics };
}

export type ReadOptions = {
  /** Engines to try, in order: primary first, then the fallback order. */
  order?: ReaderEngine[];
  tavilyDepth?: "basic" | "advanced";
  key?: string | null;
  allowReader?: boolean;
  timeoutMs?: number;
  /** Firecrawl credits are charged here. */
  budget?: FirecrawlBudget;
  /** Tavily credits are charged here. */
  tavilyBudget?: TavilyBudget;
  onStage?: (stage: "fetch" | "reader" | "extract") => void;
};

/** Primary first, then fallbacks, each engine once. */
export function engineOrder(primary: string, fallback: unknown): ReaderEngine[] {
  const list = [primary, ...(Array.isArray(fallback) ? fallback : [])].filter((e): e is ReaderEngine =>
    READER_ENGINES.includes(e as ReaderEngine),
  );
  const out = Array.from(new Set(list));
  return out.length ? out : ["own"];
}

/** Our own fetch of the raw markup: JSON-LD / Open Graph and links live here. */
async function rawHtml(url: string, timeoutMs: number): Promise<{ html: string; status: number; headers: Record<string, string> }> {
  const res = await fetchWithTimeout(url, Math.min(timeoutMs, 15000));
  const type = res?.headers.get("content-type") ?? "";
  const html = res?.ok && type.toLowerCase().includes("text/html") ? ((await res.text().catch(() => "")) ?? "") : "";
  const headers: Record<string, string> = {};
  if (res) for (const name of ["content-type", "x-shopid", "x-shopify-stage", "powered-by", "x-powered-by"]) {
    const v = res.headers.get(name);
    if (v) headers[name] = v;
  }
  return { html, status: res?.status ?? 0, headers };
}

/**
 * Read several pages (the crawler hands over up to 5 so Tavily credits are
 * used fully). Each URL walks the engine order until one returns at least
 * MIN_MAIN_TEXT characters; a cap, 402/429 or failure moves to the next
 * engine. When none clears the bar, the longest thin result is kept.
 */
export async function readPages(urls: string[], options: ReadOptions = {}): Promise<Map<string, PageRead | null>> {
  const order = options.order?.length ? options.order : (["own"] as ReaderEngine[]);
  const timeout = options.timeoutMs ?? 20000;
  const out = new Map<string, PageRead | null>();
  const thin = new Map<string, PageRead>();
  const keepThin = (url: string, page: PageRead | null) => {
    if (!page) return;
    const prev = thin.get(url);
    if (!prev || page.text.length > prev.text.length) thin.set(url, page);
  };
  let remaining = Array.from(new Set(urls));
  /** Pages Tavily already read rendered (advanced); no second rendered read. */
  const advancedRead = new Set<string>();
  options.onStage?.("fetch");

  for (let i = 0; i < order.length && remaining.length; i += 1) {
    const engine = order[i]!;
    const last = i === order.length - 1;

    if (engine === "tavily") {
      const depth = options.tavilyDepth ?? "basic";
      const accepted = new Map<string, { title: string; markdown: string; credits: number }>();
      let stop = false;
      const run = async (batch: string[], d: "basic" | "advanced") => {
        const r = await tavilyExtract(batch, d, options.tavilyBudget, Math.max(timeout, 30000));
        if (r.failure && r.failure !== "error") stop = true; // cap/402/429/unconfigured: next engine
        const share = r.credits / Math.max(batch.length, 1);
        return { pages: r.pages, share };
      };
      for (let b = 0; b < remaining.length && !stop; b += 5) {
        const batch = remaining.slice(b, b + 5);
        const first = await run(batch, depth);
        const retry: string[] = [];
        for (const url of batch) {
          const p = first.pages.get(url);
          const len = p ? p.markdown.replace(/\s+/g, " ").trim().length : 0;
          if (p && len >= MIN_MAIN_TEXT) {
            accepted.set(url, { title: p.title, markdown: p.markdown, credits: first.share });
            if (depth === "advanced") advancedRead.add(url);
          }
          else if (depth === "basic" && !stop) retry.push(url);
        }
        if (retry.length) {
          const second = await run(retry, "advanced");
          for (const url of retry) {
            const p = second.pages.get(url);
            const len = p ? p.markdown.replace(/\s+/g, " ").trim().length : 0;
            if (p && len >= MIN_MAIN_TEXT) {
              accepted.set(url, { title: p.title, markdown: p.markdown, credits: first.share + second.share });
              advancedRead.add(url);
            }
          }
        }
      }
      // Tavily gives no full HTML: fetch the static markup ourselves for
      // products and links. Only Tavily's markdown is chunked and embedded.
      await Promise.all(
        Array.from(accepted.entries()).map(async ([url, p]) => {
          const raw = await rawHtml(url, timeout);
          const text = p.markdown.replace(/\s+/g, " ").trim();
          const own = stripHtml(raw.html);
          out.set(url, {
            title: p.title || own.title,
            text,
            html: raw.html,
            links: own.links,
            usedReader: false,
            engine: "tavily",
            credits: p.credits,
            status: raw.status || 200,
            bytes: raw.html.length,
            extractedChars: text.length,
            contentType: "text/html",
            headers: raw.headers,
          });
        }),
      );
      remaining = remaining.filter((u) => !out.has(u));
      continue;
    }

    await Promise.all(
      remaining.map(async (url) => {
        let page: PageRead | null = null;
        try {
          page = await readLegacy(url, {
            ...options,
            engine: engine === "firecrawl" ? "firecrawl" : "own",
            // The paid Jina fallback only runs inside our own reader.
            allowReader: engine === "own" ? options.allowReader !== false : false,
          });
        } catch (error) {
          if (last) console.error("[reader] page failed", url, error instanceof Error ? error.message : String(error));
        }
        if (page && !page.engine) {
          page.engine = "own";
          page.credits = 0;
        }
        if (page && page.text.length >= MIN_MAIN_TEXT) out.set(url, page);
        else keepThin(url, page);
      }),
    );
    remaining = remaining.filter((u) => !out.has(u));
  }
  for (const url of urls) if (!out.has(url)) out.set(url, thin.get(url) ?? null);
  await rereadClientRendered(out, order, options, advancedRead);
  return out;
}

/**
 * Signs that the words arrive after load: an empty app root, or the page's
 * data shipped as a JSON blob for the browser to render.
 */
export function looksClientRendered(html: string): boolean {
  if (!html) return false;
  if (/<div[^>]+id=["'](?:root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html)) return true;
  if (/id=["']__NEXT_DATA__["']|window\.__(?:INITIAL_STATE|NUXT|APOLLO_STATE|PRELOADED_STATE)__|\$_TSR|__TSR_/i.test(html)) return true;
  const blobs = html.match(/<script[^>]+type=["']application\/(?:json|ld\+json)["'][^>]*>[\s\S]{2000,}?<\/script>/gi);
  if (blobs && blobs.some((b) => !/ld\+json/i.test(b))) return true;
  return false;
}

/**
 * A page read without rendering (our own fetch, or Tavily basic) whose markup
 * looks client-rendered is read again rendered: Tavily advanced, then
 * Firecrawl. The rendered text replaces the first read when it is at least
 * 30% longer.
 */
async function rereadClientRendered(
  out: Map<string, PageRead | null>,
  order: ReaderEngine[],
  options: ReadOptions,
  advancedRead: Set<string>,
): Promise<void> {
  const timeout = options.timeoutMs ?? 20000;
  const targets = Array.from(out.entries()).filter(([url, page]) => {
    if (!page || page.engine === "firecrawl" || advancedRead.has(url)) return false;
    return looksClientRendered(page.html);
  });
  if (!targets.length) return;
  const better = (page: PageRead, text: string) => text.length >= Math.max(page.text.length * 1.3, MIN_MAIN_TEXT / 2);

  const replaced = new Set<string>();
  let pending = targets.map(([url]) => url);
  if (order.includes("tavily")) {
    for (let b = 0; b < pending.length; b += 5) {
      const batch = pending.slice(b, b + 5);
      const r = await tavilyExtract(batch, "advanced", options.tavilyBudget, Math.max(timeout, 30000));
      const share = r.credits / Math.max(batch.length, 1);
      for (const url of batch) {
        const page = out.get(url);
        const p = r.pages.get(url);
        if (!page || !p) continue;
        const text = p.markdown.replace(/\s+/g, " ").trim();
        if (better(page, text)) {
          out.set(url, { ...page, title: p.title || page.title, text, engine: "tavily", credits: (page.credits ?? 0) + share, extractedChars: text.length });
          replaced.add(url);
        }
      }
      if (r.failure && r.failure !== "error") break;
    }
    pending = pending.filter((url) => !replaced.has(url));
  }
  if (!order.includes("firecrawl")) return;
  for (const url of pending) {
    const page = out.get(url);
    if (!page) continue;
    const scraped = await firecrawlScrape(url, options.budget, timeout).catch(() => null);
    if (!scraped) continue;
    const text = scraped.markdown.replace(/\s+/g, " ").trim();
    if (better(page, text)) {
      out.set(url, { ...page, title: scraped.title || page.title, text, engine: "firecrawl", credits: (page.credits ?? 0) + 1, extractedChars: text.length });
    }
  }
}

/** One page through the reader interface. */
export async function readPage(url: string, options: ReadOptions = {}): Promise<PageRead | null> {
  return (await readPages([url], options)).get(url) ?? null;
}

/**
 * Site discovery. 'own' = the sitemap (plus Tavily map only when the site
 * publishes no sitemap); 'tavily' / 'firecrawl' = that engine's map.
 */
export async function mapSite(
  url: string,
  engine: ReaderEngine,
  opts: { sitemap: string[]; budget?: FirecrawlBudget; tavilyBudget?: TavilyBudget },
): Promise<{ urls: string[]; engine: ReaderEngine | "sitemap" }> {
  if (engine === "firecrawl") return { urls: await firecrawlMap(url, opts.budget), engine };
  if (engine === "tavily") return { urls: await tavilyMap(url, opts.tavilyBudget), engine };
  if (opts.sitemap.length) return { urls: [], engine: "sitemap" };
  return { urls: await tavilyMap(url, opts.tavilyBudget), engine: "tavily" };
}
