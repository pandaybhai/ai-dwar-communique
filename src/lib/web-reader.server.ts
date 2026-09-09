/**
 * Reading one web page properly.
 *
 * Our own fetch handles ordinary HTML. Sites that paint themselves in the
 * browser hand back an empty shell, and for those we pay a reader service to
 * render the page and give us the text. Every reader call costs money, so the
 * caller keeps a running total and stops asking once the day's cap is spent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const READER_COST = 0.2;
const READER_ENDPOINT = "https://r.jina.ai/";

export type PageRead = {
  title: string;
  text: string;
  html: string;
  links: string[];
  usedReader: boolean;
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

export async function readPage(
  url: string,
  options: {
    key?: string | null;
    allowReader?: boolean;
    timeoutMs?: number;
    onStage?: (stage: "fetch" | "reader" | "extract") => void;
  } = {},
): Promise<PageRead | null> {
  options.onStage?.("fetch");
  // Big storefronts are slow and occasionally drop the first connection, so a
  // single miss must not push us onto the paid reader.
  const timeout = options.timeoutMs ?? 20000;
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
