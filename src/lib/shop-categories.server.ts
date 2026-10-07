import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CATEGORY_WORDS_SETTING,
  cleanCategoryWords,
  EMPTY_VOCABULARY,
  type ShopCategory,
  type ShopVocabulary,
} from "@/lib/shop-categories";

/**
 * Loads a workspace's category list (from its visible products) and its own
 * extra words (organizations.branding.category_words). Read briefly from
 * memory per database client, so one answer's searches share one read and a
 * product import shows up within a minute.
 */

const PAGE = 1000;
/** Rows read at most; a bigger catalogue's list is marked incomplete. */
const MAX_ROWS = 10_000;
const TTL_MS = 60_000;

const cache = new WeakMap<object, Map<string, { at: number; value: Promise<ShopVocabulary> }>>();

async function read(supabase: SupabaseClient, organizationId: string): Promise<ShopVocabulary> {
  const page = (from: number, count = false) =>
    supabase
      .from("products")
      .select("category", count ? { count: "exact" } : undefined)
      .eq("organization_id", organizationId)
      .eq("is_visible", true)
      .not("category", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
  // The first page also says how many rows there are; the rest are read
  // together, so a big catalogue costs two round trips, not one per page.
  // Only the category words, never the rest of the white-label settings.
  const words = supabase
    .from("organizations")
    .select(`${CATEGORY_WORDS_SETTING}:branding->${CATEGORY_WORDS_SETTING}`)
    .eq("id", organizationId)
    .maybeSingle()
    .then(({ data }) => {
      const row = (data ?? {}) as Record<string, unknown> & { branding?: Record<string, unknown> | null };
      return row[CATEGORY_WORDS_SETTING] ?? row.branding?.[CATEGORY_WORDS_SETTING];
    });
  const first = await page(0, true);
  if (first.error) return EMPTY_VOCABULARY;
  const total = Math.min(typeof first.count === "number" ? first.count : 0, MAX_ROWS);
  const rest: number[] = [];
  for (let from = PAGE; from < total; from += PAGE) rest.push(from);
  const more = await Promise.all(rest.map((from) => page(from)));
  if (more.some((r) => r.error)) return EMPTY_VOCABULARY;
  const counts = new Map<string, number>();
  for (const rows of [first.data, ...more.map((r) => r.data)]) {
    for (const r of (rows ?? []) as Array<{ category?: unknown }>) {
      const name = typeof r.category === "string" ? r.category.trim() : "";
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  // No count back and a full first page: there may be more than was read.
  const complete =
    typeof first.count === "number" ? first.count <= MAX_ROWS : (first.data ?? []).length < PAGE;
  const categories: ShopCategory[] = [...counts.entries()]
    .map(([name, products]) => ({ name, products }))
    .sort((a, b) => b.products - a.products || a.name.localeCompare(b.name));
  return { categories, words: cleanCategoryWords(await words.then((w) => w, () => null)), complete };
}

/** The workspace's categories and extra words. Never throws: a failed read is an empty list. */
export function loadShopVocabulary(supabase: SupabaseClient, organizationId: string): Promise<ShopVocabulary> {
  let byOrg = cache.get(supabase);
  if (!byOrg) {
    byOrg = new Map();
    cache.set(supabase, byOrg);
  }
  const hit = byOrg.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = read(supabase, organizationId).catch(() => EMPTY_VOCABULARY);
  byOrg.set(organizationId, { at: Date.now(), value });
  return value;
}
