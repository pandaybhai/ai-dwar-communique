import type { SupabaseClient } from "@supabase/supabase-js";
import { interpolate, lookup, readPath, secretScope, type FlowGraph, type FlowNode, type RunContext } from "@/lib/flow-graph";

/**
 * "Webhook / HTTP request" flow step. 10 s timeout (DNS lookup included),
 * never follows a redirect, and refuses private/internal addresses — both the
 * host as written and every address it resolves to — so a flow can't be used
 * to reach our own network or cloud metadata. Header values are secrets: they
 * live in Vault (flow_http_secrets), never in the graph JSON.
 */
export type HttpHeader = { key?: string; value?: string; secret_id?: string };
export type HttpSpec = {
  method?: string;
  url?: string;
  headers?: HttpHeader[];
  body?: string;
  save?: Array<{ path?: string; variable?: string }>;
};

export type HttpResult = {
  ok: boolean;
  status: number | null;
  error: string | null;
  saved: Record<string, string>;
  preview: string;
};

const TIMEOUT_MS = 10_000;

export function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "metadata.google.internal" || h === "metadata") return true;
  // IPv4 literal
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && Number(v4[3]) === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  // Numeric forms like 2130706433 or 0x7f000001 resolve to IPs — refuse.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  // IPv6 literal
  if (h.includes(":")) return blockedIpv6(h);
  return false;
}

/**
 * IPv6: loopback, unspecified, IPv4-mapped/compatible (all of ::/8), unique
 * local, link-local, multicast, and the tunnels that can wrap an internal
 * IPv4 address (NAT64, 6to4, Teredo).
 */
function blockedIpv6(h: string): boolean {
  const first = parseInt(h.split(":")[0] || "0", 16);
  if (first >>> 8 === 0) return true; // ::/8 — ::1, ::, ::ffff:10.0.0.1 …
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2002 || h.startsWith("64:ff9b:") || /^2001:0?:/.test(h)) return true; // 6to4, NAT64, Teredo
  return false;
}

/** An address a DNS answer gave us: blocked when it is internal in any way. */
export function blockedAddress(ip: string): boolean {
  return blockedHost(ip);
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";

/**
 * Every A/AAAA address the host resolves to (DNS over HTTPS, so it works on
 * the edge runtime too). null when the lookup itself failed.
 */
export async function resolveHost(hostname: string, signal?: AbortSignal): Promise<string[] | null> {
  const one = async (type: "A" | "AAAA"): Promise<string[] | null> => {
    try {
      const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: signal ?? null,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      // 0 = NOERROR, 3 = NXDOMAIN (no such name); anything else is a failure.
      if (body.Status !== 0 && body.Status !== 3) return null;
      return (body.Answer ?? []).filter((a) => (a.type === 1 || a.type === 28) && a.data).map((a) => a.data!.trim());
    } catch {
      return null;
    }
  };
  const [v4, v6] = await Promise.all([one("A"), one("AAAA")]);
  return v4 && v6 ? [...v4, ...v6] : null;
}

/** {{variables}} in a URL are percent-encoded so an answer can't change the address. */
export function interpolateUrl(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const v = lookup(key, ctx);
    return encodeURIComponent(v == null ? "" : String(v));
  });
}

/** Written as an IP (v4 dotted, or v6 which always has a colon): nothing to resolve. */
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]*)$/i;

function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

export async function runHttpRequest(spec: HttpSpec, ctx: RunContext): Promise<HttpResult> {
  const saved: Record<string, string> = {};
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(spec.method ?? "GET")) ? String(spec.method ?? "GET") : "GET";
  let url: URL;
  try {
    url = new URL(interpolateUrl(String(spec.url ?? "").trim(), ctx));
  } catch {
    return { ok: false, status: null, error: "invalid_url", saved, preview: "" };
  }
  if (!["https:", "http:"].includes(url.protocol)) return { ok: false, status: null, error: "only_http", saved, preview: "" };
  if (blockedHost(url.hostname)) return { ok: false, status: null, error: "private_address_blocked", saved, preview: "" };
  if (spec.headers?.some((h) => h.secret_id && !h.value)) return { ok: false, status: null, error: "header_secret_unavailable", saved, preview: "" };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await send(spec, ctx, url, method, saved, ctl.signal);
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, status: null, error: aborted ? "timeout_10s" : "request_failed", saved, preview: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function send(spec: HttpSpec, ctx: RunContext, url: URL, method: string, saved: Record<string, string>, signal: AbortSignal): Promise<HttpResult> {
  // The name must not resolve to anything internal (checked on every address).
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (!IP_LITERAL.test(bare)) {
    const addrs = await resolveHost(bare, signal);
    if (addrs === null) return { ok: false, status: null, error: "dns_lookup_failed", saved, preview: "" };
    if (!addrs.length) return { ok: false, status: null, error: "dns_no_address", saved, preview: "" };
    if (addrs.some(blockedAddress)) return { ok: false, status: null, error: "private_address_blocked", saved, preview: "" };
  }

  const headers = new Headers({ "user-agent": "AiDwar-Flows/1.0" });
  for (const h of spec.headers ?? []) {
    const k = String(h.key ?? "").trim();
    if (!k || /^(host|content-length|connection|transfer-encoding)$/i.test(k)) continue;
    try {
      headers.set(k, interpolate(String(h.value ?? ""), ctx));
    } catch {
      /* invalid header name/value — skipped */
    }
  }
  let body: string | undefined;
  const rawBody = String(spec.body ?? "").trim();
  if (rawBody && method !== "GET") {
    // Variables are escaped so a customer's answer can't break the JSON.
    body = rawBody.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m) => jsonEscape(interpolate(m, ctx)));
    try {
      JSON.parse(body);
    } catch {
      return { ok: false, status: null, error: "invalid_json_body", saved, preview: "" };
    }
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  // Redirects are never followed: a 3xx could point anywhere, internal included.
  const res = await fetch(url.toString(), { method, headers, body: body ?? null, signal, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: "redirect_not_followed", saved, preview: "" };
  const text = (await res.text()).slice(0, 100_000);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  for (const m of spec.save ?? []) {
    const variable = String(m.variable ?? "").trim();
    if (!variable || !/^[a-zA-Z0-9_]+$/.test(variable)) continue;
    const v = readPath(json, String(m.path ?? ""));
    saved[variable] = v == null ? "" : typeof v === "object" ? JSON.stringify(v).slice(0, 1000) : String(v).slice(0, 1000);
  }
  return { ok: res.ok, status: res.status, error: res.ok ? null : `http_${res.status}`, saved, preview: text.slice(0, 1500) };
}

// ---------------------------------------------------------------- header secrets

const SEAL_ERROR = "Couldn't store the request header values securely. Please try again.";

function headersOf(n: FlowNode): HttpHeader[] {
  return ((n.data["headers"] as HttpHeader[] | undefined) ?? []).filter((h) => h && typeof h === "object");
}

/**
 * Before a graph is stored: every typed header value goes to Vault and the
 * header keeps only a secret_id. A saved secret stays bound to the address it
 * was entered for (scheme, host and path) — point the step somewhere else and
 * the value must be typed again, so a saved secret can't be sent to a new
 * address. Secrets from another flow of this workspace (a duplicate) are
 * copied; anything else is dropped. Fails closed: on any storage error the
 * graph is not saved.
 */
export async function sealHttpSecrets(
  supabase: SupabaseClient,
  organizationId: string,
  flowId: string,
  graph: FlowGraph,
): Promise<{ graph: FlowGraph; error: string | null }> {
  const httpNodes = graph.nodes.filter((n) => n.type === "http");
  if (!httpNodes.length) return { graph, error: null };
  const refs = [...new Set(httpNodes.flatMap((n) => headersOf(n).map((h) => h.secret_id).filter((x): x is string => Boolean(x))))];
  const known = new Map<string, { flow_id: string | null; scope: string }>();
  if (refs.length) {
    const { data, error } = await supabase.from("flow_http_secrets").select("id, flow_id, scope").eq("organization_id", organizationId).in("id", refs);
    if (error) return { graph, error: SEAL_ERROR };
    for (const r of (data ?? []) as Array<{ id: string; flow_id: string | null; scope: string }>) known.set(r.id, r);
  }
  const store = async (id: string | null, scope: string, secret: string): Promise<string | null> => {
    const { data, error } = await supabase.rpc("flow_http_secret_set", { p_org: organizationId, p_flow: flowId, p_id: id, p_scope: scope, p_secret: secret });
    return error || !data ? null : String(data);
  };
  const nodes: FlowNode[] = [];
  for (const n of graph.nodes) {
    if (n.type !== "http") {
      nodes.push(n);
      continue;
    }
    const scope = secretScope(n.data["url"]);
    const headers: HttpHeader[] = [];
    for (const h of headersOf(n)) {
      const key = String(h.key ?? "");
      const value = String(h.value ?? "");
      const ref = h.secret_id ? known.get(h.secret_id) : undefined;
      if (value) {
        const id = await store(ref && ref.flow_id === flowId ? h.secret_id! : null, scope, value);
        if (!id) return { graph, error: SEAL_ERROR };
        headers.push({ key, value: "", secret_id: id });
      } else if (ref && ref.scope === scope) {
        if (ref.flow_id === flowId) headers.push({ key, value: "", secret_id: h.secret_id! });
        else {
          const { data, error } = await supabase.rpc("flow_http_secrets_get", { p_org: organizationId, p_ids: [h.secret_id], p_scope: scope });
          const secret = ((data ?? []) as Array<{ secret: string | null }>)[0]?.secret;
          const id = !error && secret ? await store(null, scope, secret) : null;
          if (!id) return { graph, error: SEAL_ERROR };
          headers.push({ key, value: "", secret_id: id });
        }
      } else headers.push({ key, value: "" });
    }
    nodes.push({ ...n, data: { ...n.data, headers } });
  }
  return { graph: { ...graph, nodes }, error: null };
}

/**
 * Fills saved header values in, server-side only, just before a request —
 * and only for the address the value was saved for. A value that can't be
 * loaded stays empty, and the step then fails with header_secret_unavailable.
 */
export async function loadHttpSecrets(supabase: SupabaseClient, organizationId: string, spec: HttpSpec): Promise<HttpSpec> {
  const ids = (spec.headers ?? []).filter((h) => h.secret_id && !h.value).map((h) => h.secret_id!);
  if (!ids.length) return spec;
  const { data, error } = await supabase.rpc("flow_http_secrets_get", { p_org: organizationId, p_ids: ids, p_scope: secretScope(spec.url) });
  if (error) return spec;
  const byId = new Map(((data ?? []) as Array<{ id: string; secret: string | null }>).filter((r) => r.secret).map((r) => [r.id, r.secret!]));
  return {
    ...spec,
    headers: (spec.headers ?? []).map((h) => (h.secret_id && !h.value && byId.has(h.secret_id) ? { ...h, value: byId.get(h.secret_id)! } : h)),
  };
}
