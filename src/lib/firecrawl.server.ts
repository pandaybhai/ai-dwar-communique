/**
 * Firecrawl REST API v2 — page discovery and page reading.
 *
 * The key lives only in server secrets (FIRECRAWL_API_KEY) and is never
 * logged or sent anywhere but api.firecrawl.dev. Every call has a hard
 * timeout so a slow site can never hang a crawl.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

/**
 * Who pays for a call. Every call reserves its credits first against the
 * platform and workspace monthly caps (platform_settings); a refusal means
 * "use our own reader", never "stop the crawl".
 */
export type FirecrawlBudget = {
  supabase: SupabaseClient;
  organizationId: string;
  /** Set once a call was refused this run, so we stop asking and log once. */
  capped?: boolean;
  onCapped?: () => void;
};

async function reserve(budget: FirecrawlBudget | undefined, credits: number): Promise<boolean> {
  if (!budget) return false; // unattributed calls are not allowed
  if (budget.capped) return false;
  // The counter is service-only, so a merchant-triggered Refresh (user client)
  // still records its credits.
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { data, error } = await getServiceClient().rpc("firecrawl_try_spend", {
    _org: budget.organizationId,
    _credits: credits,
  });
  if (error) {
    console.error("[firecrawl] budget check failed", error.message);
    return false;
  }
  if (data !== true) {
    budget.capped = true;
    console.warn("[firecrawl] monthly cap reached", JSON.stringify({ org: budget.organizationId }));
    budget.onCapped?.();
    return false;
  }
  return true;
}

function apiKey(): string | null {
  const key = process.env["FIRECRAWL_API_KEY"];
  return key && key.trim().length > 0 ? key.trim() : null;
}

async function firecrawlPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const key = apiKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${FIRECRAWL_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      console.error(
        "[firecrawl]",
        JSON.stringify({ path, status: res.status, error: String(data?.["error"] ?? "").slice(0, 200) }),
      );
      return null;
    }
    return data;
  } catch (error) {
    console.error(
      "[firecrawl]",
      JSON.stringify({ path, status: 0, error: error instanceof Error ? error.message : String(error) }),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every address Firecrawl can find on the site. Empty when unconfigured. */
export async function firecrawlMap(
  url: string,
  budget: FirecrawlBudget | undefined,
  limit = 2000,
): Promise<string[]> {
  if (!apiKey() || !(await reserve(budget, 1))) return [];
  const data = await firecrawlPost("/map", { url, limit }, 30000);
  const links = data?.["links"];
  if (!Array.isArray(links)) return [];
  return links.filter((link): link is string => typeof link === "string");
}

export type FirecrawlPage = {
  title: string;
  markdown: string;
  html: string;
  statusCode: number;
};

/**
 * One page, rendered and cleaned by Firecrawl. Markdown is the reading text;
 * the processed HTML stays for product extraction and link discovery.
 * Null means "we could not read it" — the caller falls back to its own fetch.
 */
export async function firecrawlScrape(
  url: string,
  budget: FirecrawlBudget | undefined,
  timeoutMs = 25000,
): Promise<FirecrawlPage | null> {
  if (!apiKey() || !(await reserve(budget, 1))) return null;
  const data = await firecrawlPost(
    "/scrape",
    { url, formats: ["markdown", "html"], onlyMainContent: true },
    timeoutMs,
  );
  if (!data) return null;
  // v2 returns document fields at the top level or wrapped in `data`.
  const doc = (typeof data["data"] === "object" && data["data"] !== null
    ? (data["data"] as Record<string, unknown>)
    : data) as Record<string, unknown>;
  const markdown = typeof doc["markdown"] === "string" ? doc["markdown"] : "";
  const html = typeof doc["html"] === "string" ? doc["html"] : "";
  const metadata = (typeof doc["metadata"] === "object" && doc["metadata"] !== null
    ? (doc["metadata"] as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const title = typeof metadata["title"] === "string" ? metadata["title"] : "";
  const statusCode = typeof metadata["statusCode"] === "number" ? metadata["statusCode"] : 200;
  if (!markdown && !html) return null;
  return { title, markdown, html, statusCode };
}
