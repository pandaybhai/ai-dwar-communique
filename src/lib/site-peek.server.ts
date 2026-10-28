/**
 * Batch 40: one quick look at a business's homepage for the sign-up screen —
 * the website reader's own guarded fetch (no private hosts, every redirect
 * checked), the first 512 KB only, a few seconds at most. It reads; it saves
 * nothing. The real read is the Day-0 read (addWebsiteSource → worker).
 */

import { fetchWithTimeout } from "@/lib/web-reader.server";
import { responseUrl, urlBlocked } from "@/lib/safe-fetch.server";
import { listingLabel } from "@/lib/knowledge.server";
import { normaliseSiteInput, parseSiteBrand, type SiteBrand } from "@/lib/site-peek";

const PEEK_TIMEOUT_MS = 6000;
const PEEK_MAX_BYTES = 512 * 1024;

/** The head of a body: what a <head> needs, never the whole page in memory. */
async function readHead(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (size >= maxBytes || /<\/head>/i.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

export type PeekResult =
  | { ok: true; brand: SiteBrand; listing: string | null }
  | { ok: false; error: string };

export async function peekSite(raw: string): Promise<PeekResult> {
  const url = normaliseSiteInput(raw);
  if (!url) return { ok: false, error: "That doesn't look like a website address — try something like yourshop.in." };
  if (urlBlocked(url)) return { ok: false, error: "We can only read public websites." };
  const res = await fetchWithTimeout(url, PEEK_TIMEOUT_MS);
  if (!res) return { ok: false, error: "We couldn't open that website just now. Check the address, or carry on — Aiden will try again." };
  const landed = responseUrl(res, url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: "That website didn't answer properly. Check the address, or carry on — Aiden will try again." };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html/i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: "That address isn't a web page." };
  }
  const html = await readHead(res.body, PEEK_MAX_BYTES);
  return { ok: true, brand: parseSiteBrand(html, landed), listing: listingLabel(landed) };
}
