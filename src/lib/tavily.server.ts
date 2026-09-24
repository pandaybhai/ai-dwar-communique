/**
 * Tavily REST API — page reading (/extract) and discovery (/map).
 *
 * Key lives only in TAVILY_API_KEY and is never logged. Credits are reserved
 * up front per call against the Tavily caps in platform_settings
 * (reader_try_spend); a refusal means "next engine", never "stop the read".
 * Billing: 1 credit per 5 successful basic URLs, 2 per 5 advanced — so the
 * caller batches URLs 5 at a time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const TAVILY_BASE = "https://api.tavily.com";

export type TavilyBudget = {
  supabase: SupabaseClient;
  organizationId: string;
  capped?: boolean;
  onCapped?: () => void;
};

export type TavilyFailure = "unconfigured" | "capped" | "http_402" | "http_429" | "error";

function apiKey(): string | null {
  const key = process.env["TAVILY_API_KEY"];
  return key && key.trim().length > 0 ? key.trim() : null;
}

export function tavilyConfigured(): boolean {
  return apiKey() !== null;
}

async function reserve(budget: TavilyBudget | undefined, credits: number): Promise<boolean> {
  if (!budget || budget.capped) return false;
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { data, error } = await getServiceClient().rpc("reader_try_spend", {
    _org: budget.organizationId,
    _engine: "tavily",
    _credits: credits,
  });
  if (error) {
    console.error("[tavily] budget check failed", error.message);
    return false;
  }
  if (data !== true) {
    budget.capped = true;
    console.warn("[tavily] monthly cap reached", JSON.stringify({ org: budget.organizationId }));
    budget.onCapped?.();
    return false;
  }
  return true;
}

async function tavilyPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ data: Record<string, unknown> | null; status: number }> {
  const key = apiKey();
  if (!key) return { data: null, status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${TAVILY_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = (data?.["detail"] as Record<string, unknown> | undefined)?.["error"] ?? data?.["error"] ?? "";
      console.error("[tavily]", JSON.stringify({ path, status: res.status, error: String(detail).slice(0, 200) }));
      return { data: null, status: res.status };
    }
    return { data, status: res.status };
  } catch (error) {
    console.error("[tavily]", JSON.stringify({ path, status: 0, error: error instanceof Error ? error.message : String(error) }));
    return { data: null, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export type TavilyPage = { url: string; title: string; markdown: string };

/**
 * Up to 5 URLs in one call. Returns a page per URL Tavily could read; URLs
 * missing from the map failed. `failure` explains a whole-call failure.
 */
export async function tavilyExtract(
  urls: string[],
  depth: "basic" | "advanced",
  budget: TavilyBudget | undefined,
  timeoutMs = 30000,
): Promise<{ pages: Map<string, TavilyPage>; failure: TavilyFailure | null; credits: number }> {
  const pages = new Map<string, TavilyPage>();
  const batch = urls.slice(0, 5);
  if (!batch.length) return { pages, failure: null, credits: 0 };
  if (!apiKey()) return { pages, failure: "unconfigured", credits: 0 };
  const credits = depth === "advanced" ? 2 : 1;
  if (!(await reserve(budget, credits))) return { pages, failure: "capped", credits: 0 };
  const { data, status } = await tavilyPost(
    "/extract",
    { urls: batch, extract_depth: depth, format: "markdown", include_images: false },
    timeoutMs,
  );
  if (!data) {
    return { pages, failure: status === 402 ? "http_402" : status === 429 ? "http_429" : "error", credits };
  }
  const results = Array.isArray(data["results"]) ? (data["results"] as Array<Record<string, unknown>>) : [];
  for (const r of results) {
    const url = typeof r["url"] === "string" ? r["url"] : "";
    const raw = typeof r["raw_content"] === "string" ? r["raw_content"] : "";
    if (!url || !raw) continue;
    const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
    const page = { url, title: typeof r["title"] === "string" ? r["title"] : heading, markdown: raw };
    // Tavily may echo a normalised address; match it back to what we asked for.
    const asked = batch.find((u) => u === url || u.replace(/\/$/, "") === url.replace(/\/$/, "")) ?? url;
    pages.set(asked, page);
  }
  return { pages, failure: null, credits };
}

/** Site discovery. Empty when unconfigured, capped or failed. */
export async function tavilyMap(url: string, budget: TavilyBudget | undefined, limit = 500): Promise<string[]> {
  if (!apiKey() || !(await reserve(budget, 1))) return [];
  const { data } = await tavilyPost("/map", { url, limit, max_depth: 2 }, 45000);
  const results = data?.["results"];
  if (!Array.isArray(results)) return [];
  return results.filter((l): l is string => typeof l === "string");
}
