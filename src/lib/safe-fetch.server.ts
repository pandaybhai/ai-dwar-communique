/**
 * Fetching an address a merchant gave us (website reading, product
 * extraction). Same rule as the Flows HTTP step (flow-http.server.ts): no
 * private/internal hosts, neither as written nor as resolved. Redirects are
 * followed by hand so every hop is checked the same way before we go there.
 */
import { blockedHost, resolveHost, resolvedHostError } from "@/lib/flow-http.server";

export const MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  constructor(public readonly code: string, public readonly url: string) {
    super(`blocked_url:${code}`);
    this.name = "BlockedUrlError";
  }
}

/**
 * Cheap, no-network check: not http(s), unparseable, or a private/internal
 * host as written. Used before handing an address to a third-party reader
 * (Firecrawl, Tavily, Jina) that fetches it on its own network.
 */
export function urlBlocked(raw: string): boolean {
  try {
    const url = new URL(raw);
    return !["https:", "http:"].includes(url.protocol) || blockedHost(url.hostname);
  } catch {
    return true;
  }
}

/** A crawl reads hundreds of pages of one site: resolve each name once a minute. */
const DNS_TTL_MS = 60_000;
const dnsCache = new Map<string, { addrs: string[]; at: number }>();

async function cachedResolve(host: string, signal?: AbortSignal): Promise<string[] | null> {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.addrs;
  const addrs = await resolveHost(host, signal);
  if (addrs) {
    if (dnsCache.size > 500) dnsCache.clear();
    dnsCache.set(host, { addrs, at: Date.now() });
  }
  return addrs;
}

/** Test hook. */
export function clearSafeFetchDnsCache(): void {
  dnsCache.clear();
}

export type GuardOptions = {
  /** Every hop must be https (the Public API's document links, Batch 34). */
  httpsOnly?: boolean;
};

/** Throws BlockedUrlError when the address (or what it resolves to) is internal. */
export async function assertPublicUrl(raw: string, signal?: AbortSignal, options: GuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("invalid_url", raw);
  }
  if (options.httpsOnly && url.protocol !== "https:") throw new BlockedUrlError("only_https", raw);
  if (!["https:", "http:"].includes(url.protocol)) throw new BlockedUrlError("only_http", raw);
  if (blockedHost(url.hostname)) throw new BlockedUrlError("private_address_blocked", raw);
  const dnsError = await resolvedHostError(url, signal, cachedResolve);
  if (dnsError) throw new BlockedUrlError(dnsError, raw);
  return url;
}

/** Where each guarded response finally came from (after its redirects). */
const landedAt = new WeakMap<Response, string>();

/** The address a guardedFetch response was finally served from. */
export function responseUrl(res: Response, asked: string): string {
  return landedAt.get(res) || res.url || asked;
}

/**
 * fetch() for a merchant-supplied address. Every hop (the first request and
 * each redirect target) passes assertPublicUrl first; at most MAX_REDIRECTS
 * hops are followed. Throws BlockedUrlError for a refused hop.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}, options: GuardOptions = {}): Promise<Response> {
  let url = await assertPublicUrl(raw, init.signal ?? undefined, options);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body ?? null;
  for (let hop = 0; ; hop += 1) {
    const res = await fetch(url.toString(), { ...init, method, body, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location || hop >= MAX_REDIRECTS) {
      landedAt.set(res, url.toString());
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      throw new BlockedUrlError("invalid_url", location);
    }
    url = await assertPublicUrl(next, init.signal ?? undefined, options);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = null;
    }
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`body_too_large:${limit}`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a body, stopping (and cancelling the rest) as soon as it passes
 * maxBytes — a large or endless answer is never held in memory whole.
 * Throws BodyTooLargeError.
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export type PublicFileResult =
  | { ok: true; bytes: Uint8Array; contentType: string | null }
  | { ok: false; code: "blocked" | "too_large" | "timeout" | "http_error" | "unreachable"; detail: string };

/**
 * A file at a merchant-given https address (Batch 34: an invoice PDF): every
 * hop https and public (guardedFetch with httpsOnly — a redirect to a private
 * address is refused before we go there), one overall timeout, and the body
 * read only up to maxBytes. Never throws.
 */
export async function fetchPublicFile(
  raw: string,
  options: { maxBytes: number; timeoutMs: number },
): Promise<PublicFileResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await guardedFetch(raw, { signal: controller.signal, headers: { accept: "application/pdf,*/*;q=0.5", "user-agent": "AiDwar/1.0" } }, { httpsOnly: true });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: "http_error", detail: "too_many_redirects" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: "http_error", detail: `status_${res.status}` };
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: "too_large", detail: `declared_${declared}` };
    }
    const bytes = await readBodyCapped(res.body, options.maxBytes);
    return { ok: true, bytes, contentType: res.headers.get("content-type") };
  } catch (error) {
    if (error instanceof BlockedUrlError) return { ok: false, code: "blocked", detail: error.code };
    if (error instanceof BodyTooLargeError) return { ok: false, code: "too_large", detail: "streamed" };
    if (controller.signal.aborted) return { ok: false, code: "timeout", detail: `timeout_${options.timeoutMs}ms` };
    return { ok: false, code: "unreachable", detail: "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}
