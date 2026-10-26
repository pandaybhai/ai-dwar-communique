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

/**
 * Background AI runs per workspace per day when the setting is missing
 * (Batch 28: extract_facts ran 818 times for 69 page texts on 1 Oct, mostly
 * on test workspaces — runs whose cost was unknown never reached the ₹ cap).
 */
export const BACKGROUND_AI_DAILY_CAP_DEFAULT = 300;
/**
 * The AI tasks counted against the background cap (ai_runs.task): turning
 * pages into facts, summaries (the behaviour suggested after a read among
 * them) and labels. The cap stops only work no person is waiting on —
 * the reader's facts pass and the suggested behaviour; a person's own
 * Inbox request still runs.
 */
export const BACKGROUND_AI_TASKS = ["extract_facts", "summarise", "auto_tag"];

/**
 * Per-workspace daily cap on background AI runs (platform_settings
 * .background_ai_daily_cap, a count). A missing row, a missing column (the
 * Batch 28 SQL not applied: PGRST204 / 42703) or a failed read = the
 * default; 0 = no cap. Read on its own, like reading_ai_daily_cap.
 */
export async function loadBackgroundAiDailyCap(supabase: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await supabase.from("platform_settings").select("background_ai_daily_cap").eq("id", true).maybeSingle();
    const raw = (data as { background_ai_daily_cap?: unknown } | null)?.background_ai_daily_cap;
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return error || !Number.isFinite(value) || value < 0 ? BACKGROUND_AI_DAILY_CAP_DEFAULT : Math.floor(value);
  } catch {
    return BACKGROUND_AI_DAILY_CAP_DEFAULT;
  }
}

/** Today (UTC, the day ai_usage rolls up by) and the moment it began. */
function utcToday(): { day: string; since: string } {
  const day = new Date().toISOString().slice(0, 10);
  return { day, since: `${day}T00:00:00.000Z` };
}

/** Workspaces already logged as over a cap today ("action:org:date"), so this process asks the log once. */
const capLogged = new Set<string>();

/**
 * Say a cap was hit at most once per workspace per day: an activity_log row
 * of that action already written today (by any worker, before any restart)
 * means it was said. A failed check still says it, once per process.
 */
async function logCapHitOnce(
  supabase: SupabaseClient,
  organizationId: string,
  action: "reading_ai_cap_hit" | "background_ai_cap_hit",
  details: Record<string, unknown>,
): Promise<void> {
  const { day, since } = utcToday();
  const key = `${action}:${organizationId}:${day}`;
  if (capLogged.has(key)) return;
  capLogged.add(key);
  try {
    const { data, error } = await supabase
      .from("activity_log")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("action", action)
      .gte("created_at", since)
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) return;
  } catch {
    // Unknown: say it (this process says it only once).
  }
  console.warn(JSON.stringify({ scope: action, organization_id: organizationId, ...details, day }));
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, organizationId, null, action, { ...details, day });
}

/**
 * True once the workspace's background AI runs today (ai_runs of
 * BACKGROUND_AI_TASKS, any status) have reached the cap; said once a day.
 * A failed count never stops the work (the ₹ reading cap still applies).
 */
export async function backgroundAiCapReached(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const cap = await loadBackgroundAiDailyCap(supabase);
  if (cap <= 0) return false;
  try {
    const { count, error } = await supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", utcToday().since)
      .in("task", BACKGROUND_AI_TASKS);
    if (error) return false;
    const runs = Number(count ?? 0);
    if (runs < cap) return false;
    await logCapHitOnce(supabase, organizationId, "background_ai_cap_hit", { runs, cap });
    return true;
  } catch {
    return false;
  }
}

/**
 * True once the workspace's reading AI spend today (ai_usage, same UTC day
 * meterAiUsage writes) has reached the cap, or its background AI runs have
 * (backgroundAiCapReached); logged once a day.
 */
export async function readingAiCapReached(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  if (await backgroundAiCapReached(supabase, organizationId)) return true;
  const cap = await loadReadingAiDailyCap(supabase);
  if (cap <= 0) return false;
  const today = utcToday().day;
  try {
    const { data } = await supabase
      .from("ai_usage")
      .select("cost_amount")
      .eq("organization_id", organizationId)
      .eq("usage_date", today)
      .in("task", READING_AI_TASKS);
    const spent = ((data ?? []) as Array<{ cost_amount: number | null }>).reduce((sum, r) => sum + Number(r.cost_amount ?? 0), 0);
    if (spent < cap) return false;
    await logCapHitOnce(supabase, organizationId, "reading_ai_cap_hit", { spent: Math.round(spent * 100) / 100, cap });
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
