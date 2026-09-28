import { interpolate, readPath, type RunContext } from "@/lib/flow-graph";

/**
 * "Webhook / HTTP request" flow step. 10 s timeout, never follows a redirect
 * to somewhere else, and refuses private/internal addresses so a flow can't
 * be used to reach our own network or cloud metadata.
 */
export type HttpSpec = {
  method?: string;
  url?: string;
  headers?: Array<{ key?: string; value?: string }>;
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
    return false;
  }
  // Numeric forms like 2130706433 or 0x7f000001 resolve to IPs — refuse.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  // IPv6 literal
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:")) return true;
  }
  return false;
}

function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

export async function runHttpRequest(spec: HttpSpec, ctx: RunContext): Promise<HttpResult> {
  const saved: Record<string, string> = {};
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(spec.method ?? "GET")) ? String(spec.method ?? "GET") : "GET";
  let url: URL;
  try {
    url = new URL(interpolate(String(spec.url ?? "").trim(), ctx));
  } catch {
    return { ok: false, status: null, error: "invalid_url", saved, preview: "" };
  }
  if (!["https:", "http:"].includes(url.protocol)) return { ok: false, status: null, error: "only_http", saved, preview: "" };
  if (blockedHost(url.hostname)) return { ok: false, status: null, error: "private_address_blocked", saved, preview: "" };

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

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { method, headers, body: body ?? null, signal: ctl.signal, redirect: "manual" });
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
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, status: null, error: aborted ? "timeout_10s" : "request_failed", saved, preview: "" };
  } finally {
    clearTimeout(timer);
  }
}
