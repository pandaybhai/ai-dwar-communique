import type { SupabaseClient } from "@supabase/supabase-js";

/** Platform-wide reading settings (platform_settings), edited in /admin/aiden → Reading. */
export type ReadingSettings = {
  reader_primary: "own" | "tavily" | "firecrawl";
  reader_fallback_order: Array<"own" | "tavily" | "firecrawl">;
  tavily_extract_depth: "basic" | "advanced";
  map_engine: "own" | "tavily" | "firecrawl";
  tavily_monthly_credit_cap: number;
  tavily_workspace_monthly_cap: number;
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
  /** Same link isn't read again within this many days (saved copy used). */
  link_reread_days: number;
  trial_links_per_day: number;
  trial_links_total: number;
};

export const READING_DEFAULTS: ReadingSettings = {
  reader_primary: "tavily",
  reader_fallback_order: ["tavily", "firecrawl", "own"],
  tavily_extract_depth: "basic",
  map_engine: "own",
  tavily_monthly_credit_cap: 900,
  tavily_workspace_monthly_cap: 200,
  day0_page_limit: 15,
  full_crawl_trigger: "on_number_connected",
  backfill_pages_per_day: 200,
  on_demand_read: true,
  refresh_days: 7,
  manual_refresh_cooldown_hours: 24,
  firecrawl_monthly_credit_cap: 450,
  firecrawl_workspace_monthly_cap: 100,
  plan_page_overrides: {},
  link_reread_days: 7,
  trial_links_per_day: 3,
  trial_links_total: 10,
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
 * Whether websites are re-read automatically on a schedule
 * (platform_settings.knowledge_auto_refresh). Off unless set: a missing
 * row or a failed read means off — a site is then re-read only when the
 * merchant asks. Read on its own, never in READING_COLUMNS.
 */
export async function loadKnowledgeAutoRefresh(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("platform_settings").select("knowledge_auto_refresh").eq("id", true).maybeSingle();
    if (error) return false;
    return (data as { knowledge_auto_refresh?: unknown } | null)?.knowledge_auto_refresh === true;
  } catch {
    return false;
  }
}

/** Reading AI cap when the setting is missing: ₹/workspace/day (facts run ~₹0.7 a page live; Day-0 is 15 pages). */
export const READING_AI_DAILY_CAP_DEFAULT = 100;
/** ai_usage tasks a website read spends on (facts, picture descriptions, embeddings). */
export const READING_AI_TASKS = ["knowledge_facts", "knowledge_image", "embedding"];

/**
 * Per-workspace daily cap on reading AI spend (platform_settings
 * .reading_ai_daily_cap, ₹). A missing row or failed read = the default; 0 = no cap.
 * Read on its own, like knowledge_auto_refresh.
 */
export async function loadReadingAiDailyCap(supabase: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await supabase.from("platform_settings").select("reading_ai_daily_cap").eq("id", true).maybeSingle();
    const value = Number((data as { reading_ai_daily_cap?: unknown } | null)?.reading_ai_daily_cap);
    return error || !Number.isFinite(value) || value < 0 ? READING_AI_DAILY_CAP_DEFAULT : value;
  } catch {
    return READING_AI_DAILY_CAP_DEFAULT;
  }
}

/** Workspaces already logged as over the cap today ("org:date"), so the log says it once. */
const capLogged = new Set<string>();

/**
 * True once the workspace's reading AI spend today (ai_usage, same UTC day
 * meterAiUsage writes) has reached the cap; logged the first time.
 */
export async function readingAiCapReached(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const cap = await loadReadingAiDailyCap(supabase);
  if (cap <= 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data } = await supabase
      .from("ai_usage")
      .select("cost_amount")
      .eq("organization_id", organizationId)
      .eq("usage_date", today)
      .in("task", READING_AI_TASKS);
    const spent = ((data ?? []) as Array<{ cost_amount: number | null }>).reduce((sum, r) => sum + Number(r.cost_amount ?? 0), 0);
    if (spent < cap) return false;
    const key = `${organizationId}:${today}`;
    if (!capLogged.has(key)) {
      capLogged.add(key);
      console.warn(JSON.stringify({ scope: "reading_ai_cap_hit", organization_id: organizationId, spent: Math.round(spent * 100) / 100, cap, day: today }));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The nightly backfill reads only for a workspace that can use what it reads:
 * a connected WhatsApp number, or Aiden on. Day-0 onboarding reads never ask.
 */
export async function backfillWanted(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const [{ count: numbers }, { data: agent }] = await Promise.all([
    supabase
      .from("whatsapp_accounts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "active"),
    supabase.from("ai_agents").select("mode").eq("organization_id", organizationId).eq("is_default", true).maybeSingle(),
  ]);
  const aiOn = ((agent as { mode?: string } | null)?.mode ?? "off") !== "off";
  return (numbers ?? 0) > 0 || aiOn;
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
  // Other pages that answer customers: where to find the shop, sizes, jobs.
  if (/^\/(?:stores?|store-locator|locations?|find-us|visit-us|size-guide|size-chart|sizing|careers|jobs)(?:\/|$)/.test(path)) return 65;
  if (/(pricing|price|plans)/.test(words)) return 60;
  if (/(\/blog|\/tag|\/tags|\/archive|\/search|\/author|\/feed|\/page\/\d+|\/\d{4}\/\d{2}\/)/.test(path)) return 5;
  if (/(collection|categor|shop|catalog|menu|services|listing)/.test(path)) return 50;
  if (/\/(?:products?|product[-_]details?|item|p)\//.test(path)) return 40;
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
