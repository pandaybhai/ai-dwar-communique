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

/** Throws BlockedUrlError when the address (or what it resolves to) is internal. */
export async function assertPublicUrl(raw: string, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("invalid_url", raw);
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new BlockedUrlError("only_http", raw);
  if (blockedHost(url.hostname)) throw new BlockedUrlError("private_address_blocked", raw);
  const dnsError = await resolvedHostError(url, signal, cachedResolve);
  if (dnsError) throw new BlockedUrlError(dnsError, raw);
  return url;
}

/**
 * fetch() for a merchant-supplied address. Every hop (the first request and
 * each redirect target) passes assertPublicUrl first; at most MAX_REDIRECTS
 * hops are followed. Throws BlockedUrlError for a refused hop.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicUrl(raw, init.signal ?? undefined);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body ?? null;
  for (let hop = 0; ; hop += 1) {
    const res = await fetch(url.toString(), { ...init, method, body, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location || hop >= MAX_REDIRECTS) return res;
    await res.body?.cancel().catch(() => undefined);
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      throw new BlockedUrlError("invalid_url", location);
    }
    url = await assertPublicUrl(next, init.signal ?? undefined);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = null;
    }
  }
}
