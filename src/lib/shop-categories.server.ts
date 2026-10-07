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
  const counts = new Map<string, number>();
  let complete = true;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("category")
      .eq("organization_id", organizationId)
      .eq("is_visible", true)
      .not("category", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return EMPTY_VOCABULARY;
    const rows = (data ?? []) as Array<{ category?: unknown }>;
    for (const r of rows) {
      const name = typeof r.category === "string" ? r.category.trim() : "";
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
    if (from + PAGE >= MAX_ROWS) {
      complete = false;
      break;
    }
  }
  // Only the category words, never the rest of the white-label settings.
  const { data: org } = await supabase
    .from("organizations")
    .select(`${CATEGORY_WORDS_SETTING}:branding->${CATEGORY_WORDS_SETTING}`)
    .eq("id", organizationId)
    .maybeSingle();
  const row = (org ?? {}) as Record<string, unknown> & { branding?: Record<string, unknown> | null };
  const words = row[CATEGORY_WORDS_SETTING] ?? row.branding?.[CATEGORY_WORDS_SETTING];
  const categories: ShopCategory[] = [...counts.entries()]
    .map(([name, products]) => ({ name, products }))
    .sort((a, b) => b.products - a.products || a.name.localeCompare(b.name));
  return { categories, words: cleanCategoryWords(words), complete };
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
