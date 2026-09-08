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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { title: (titleMatch?.[1] ?? "").trim(), text, links };
}

/** A fetch that always gives up rather than hanging a crawl. */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: "follow", ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The platform's reader key, when one is configured. Null is fine. */
export async function readerKey(supabase: SupabaseClient): Promise<string | null> {
  const { data: provider } = await supabase
    .from("platform_ai_providers")
    .select("vault_secret_name, is_active")
    .eq("provider", "jina_reader")
    .maybeSingle();
  const row = provider as { vault_secret_name?: string | null; is_active?: boolean } | null;
  if (!row || row.is_active === false || !row.vault_secret_name) return null;
  const { data, error } = await supabase.rpc("read_vault_secret", { p_name: row.vault_secret_name });
  if (error) return null;
  return typeof data === "string" && data.length > 0 ? data : null;
}

/** A shell page: markup arrived, words did not. */
function looksEmpty(html: string, text: string): boolean {
  if (text.length < 300) return true;
  const shell = /<div[^>]+id=["'](root|__next)["'][^>]*>\s*<\/div>|data-reactroot/i.test(html);
  return shell && text.length < 1200;
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
  const res = await fetchWithTimeout(url, options.timeoutMs ?? 8000);
  const type = res?.headers.get("content-type") ?? "";
  const readableDirect = Boolean(
    res?.ok && (type.includes("text/html") || type.includes("text/plain")),
  );
  const html = readableDirect ? await res?.text().catch(() => "") ?? "" : "";
  options.onStage?.("extract");
  const { title, text, links } = stripHtml(html);

  if (options.allowReader !== false && (!readableDirect || looksEmpty(html, text))) {
    options.onStage?.("reader");
    const readerUrl = `${READER_ENDPOINT}${url}`;
    const cleanKey = options.key?.trim() || null;
    const readerRequest = async (withKey: boolean) => {
      const headers: Record<string, string> = {
        Accept: "text/plain",
        "X-Return-Format": "text",
      };
      if (withKey && cleanKey) headers.Authorization = `Bearer ${cleanKey}`;
      const safeHeaders = { ...headers, ...(headers.Authorization ? { Authorization: "Bearer [masked]" } : {}) };
      const response = await fetchWithTimeout(readerUrl, 15000, { headers });
      if (!response) {
        console.error("[web-reader]", JSON.stringify({ url: readerUrl, headers: safeHeaders, status: 0, body: "request failed or timed out" }));
        return { response: null, body: "", detail: `reader request failed or timed out; url=${readerUrl}; headers=${JSON.stringify(safeHeaders)}` };
      }
      const body = await response.text().catch((error) => `body read failed: ${error instanceof Error ? error.message : String(error)}`);
      const preview = bodyPreview(body);
      console.info("[web-reader]", JSON.stringify({ url: readerUrl, headers: safeHeaders, status: response.status, body: preview }));
      return { response, body, detail: `reader HTTP ${response.status}; url=${readerUrl}; headers=${JSON.stringify(safeHeaders)}; body=${preview}` };
    };

    let attempt = await readerRequest(Boolean(cleanKey));
    if ((!attempt.response || !attempt.response.ok) && cleanKey) attempt = await readerRequest(false);
    if (attempt.response?.ok) {
      const rendered = attempt.body.replace(/\s+/g, " ").trim();
      if (rendered.length > text.length) {
        return { title, text: rendered, html, links, usedReader: true };
      }
    }
    // A reader outage must never discard text our own fetch already found.
    if (readableDirect && text.length > 0) return { title, text, html, links, usedReader: false };
    throw new ReaderRequestError(attempt.detail);
  }

  if (!readableDirect) return null;
  return { title, text, html, links, usedReader: false };
}
