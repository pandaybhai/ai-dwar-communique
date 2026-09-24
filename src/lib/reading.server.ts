import type { SupabaseClient } from "@supabase/supabase-js";

/** Platform-wide reading settings (platform_settings), edited in /admin/aiden → Reading. */
export type ReadingSettings = {
  crawl_engine: "firecrawl" | "auto" | "own";
  day0_page_limit: number;
  full_crawl_trigger: "on_number_connected" | "on_plan_active" | "manual";
  backfill_pages_per_day: number;
  on_demand_read: boolean;
  refresh_days: number;
  manual_refresh_cooldown_hours: number;
  firecrawl_monthly_credit_cap: number;
  firecrawl_workspace_monthly_cap: number;
  /** plan_id → page limit, overriding plan_versions.limits.pages. */
  plan_page_overrides: Record<string, number>;
};

export const READING_DEFAULTS: ReadingSettings = {
  crawl_engine: "firecrawl",
  day0_page_limit: 15,
  full_crawl_trigger: "on_number_connected",
  backfill_pages_per_day: 200,
  on_demand_read: true,
  refresh_days: 7,
  manual_refresh_cooldown_hours: 24,
  firecrawl_monthly_credit_cap: 3000,
  firecrawl_workspace_monthly_cap: 500,
  plan_page_overrides: {},
};

export const READING_COLUMNS = Object.keys(READING_DEFAULTS).join(", ");

export async function loadReadingSettings(supabase: SupabaseClient): Promise<ReadingSettings> {
  try {
    const { data } = await supabase.from("platform_settings").select(READING_COLUMNS).eq("id", true).maybeSingle();
    return { ...READING_DEFAULTS, ...((data ?? {}) as Partial<ReadingSettings>) };
  } catch {
    return READING_DEFAULTS;
  }
}

/**
 * Reading order for every read: home, contact/about, policies, FAQ, pricing,
 * collections, products, the rest; blog/tag/archive/search last.
 * Returns null for pages we never read.
 */
export function urlPriority(url: string, origin: string, title = ""): number | null {
  const path = (url.slice(origin.length).toLowerCase() || "/").split("?")[0] ?? "/";
  const words = `${path} ${title.toLowerCase()}`;
  if (/\/(cart|checkout|login|signin|sign-in|register|account|my-account|wp-admin|wp-login)(\/|$)/.test(path)) return null;
  if (/\.(?:pdf|xml|jpe?g|png|gif|webp|svg|css|js|zip)(?:$|\/)/i.test(path)) return null;
  if (path === "/" || path === "") return 100;
  if (/(contact|about|our-story|who-we-are)/.test(words)) return 90;
  if (/(shipping|delivery|return|refund|terms|privacy|policy|policies|warranty)/.test(words)) return 80;
  if (/(faq|help|questions)/.test(words)) return 70;
  if (/(pricing|price|plans)/.test(words)) return 60;
  if (/(\/blog|\/tag|\/tags|\/archive|\/search|\/author|\/feed|\/page\/\d+|\/\d{4}\/\d{2}\/)/.test(path)) return 5;
  if (/(collection|categor|shop|catalog|menu|services)/.test(path)) return 50;
  if (/\/products?\//.test(path)) return 40;
  return 20;
}

/** Words worth matching in a question: no stop words, no tiny words. */
const STOP = new Set(
  "the and for you your are was what when where which with this that have has how can does from about any all our not but get got want need please tell show give kya hai hain aap mujhe".split(" "),
);
export function questionWords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097f\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP.has(w)),
    ),
  );
}
