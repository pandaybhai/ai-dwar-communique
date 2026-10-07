/**
 * The early catalogue search (Batch 15C): the customer's own words go
 * through catalog_search before the first model call, so a product reply can
 * be written in one model step instead of search → send → close.
 *
 * Same tool, same handler, same broker: invokeTool with the run's brokered
 * tools (the 14.1 gender/NULL rule, the rings/earrings split, the caps — all
 * as when the model calls it). Nothing here writes reply text and nothing is
 * specific to one kind of business: whether the results fit is decided from
 * the customer's words and this business's own catalogue only.
 *
 * Results that don't fit are never shown to the model; the run is then
 * exactly as before (the model searches for itself).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrokeredTool, ToolContext, ToolPrincipal, ToolResult } from "@/lib/ai-tools.server";

/** The id the early search carries in the conversation the model reads. */
export const EARLY_CALL_ID = "early_catalog_search";

/** As many products as one send_products call may carry. */
const EARLY_LIMIT = 5;
/** A longer message is a conversation, not a browse: the model searches for itself. */
const MAX_WORDS = 12;

/**
 * Grammar words of the languages customers write in (English, Hinglish):
 * never a filter, whatever a product description happens to contain ("with"
 * is in 43% of Zoori's descriptions). Language only — no shop or product
 * words: a word that names what a business sells is judged by its catalogue.
 */
const FUNCTION_WORDS = new Set([
  "the",
  "and",
  "with",
  "without",
  "for",
  "from",
  "any",
  "some",
  "all",
  "more",
  "other",
  "another",
  "have",
  "has",
  "had",
  "you",
  "your",
  "yours",
  "our",
  "ours",
  "mine",
  "can",
  "could",
  "would",
  "will",
  "does",
  "are",
  "was",
  "were",
  "there",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "how",
  "please",
  "pls",
  "plz",
  "want",
  "need",
  "like",
  "also",
  "only",
  "just",
  "too",
  "very",
  "into",
  "about",
  "show",
  "see",
  "send",
  "give",
  "get",
  "let",
  "look",
  "looking",
  "share",
  "tell",
  "mujhe",
  "mujhko",
  "hume",
  "humein",
  "hamein",
  "aap",
  "aapke",
  "aapki",
  "kuch",
  "koi",
  "aur",
  "bhi",
  "sirf",
  "mein",
  "hai",
  "hain",
  "dikhao",
  "dikhaiye",
  "dikha",
  "dikhana",
  "bhejo",
  "bhejiye",
  "chahiye",
  "wala",
  "wali",
  "wale",
  "kya",
  "kaun",
  "kaunsa",
  "kaunse",
  "kitne",
  "kitna",
]);

export type EarlySearch = {
  /** The arguments the search ran with (the customer's words). */
  args: Record<string, unknown>;
  /** invokeTool's result, null when it did not run. */
  result: ToolResult | null;
  /** True when the results are given to the model. */
  usable: boolean;
  /** Why not, when not: small_talk, too_long, not_offered, no_products, nothing_found, has_figure, words_not_covered, error. */
  reason: string;
  /** Customer words the results don't carry but the catalogue does (why they were held back). */
  missing?: string[];
  ms: number;
};

/** The customer's words, lower-case, 3+ letters, in any script. */
export function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  return Array.from(new Set(words));
}

/** A digit in any script: a budget, a size, a code — a filter the plain words don't carry. */
export function hasFigure(text: string): boolean {
  return /\p{Nd}/u.test(text);
}

function rowWords(row: Record<string, unknown>): string[] {
  return ["title", "sku", "brand", "description", "category", "gender"]
    .map((k) => (typeof row[k] === "string" ? (row[k] as string) : ""))
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** "earring" is in "earrings"; "rings" is in "ring". */
function carries(words: string[], word: string): boolean {
  const stem = word.length > 4 ? word.replace(/(es|s)$/, "") : word;
  return words.some((w) => w.startsWith(word) || w.startsWith(stem));
}

/** The customer's words that not every returned product carries. */
export function uncoveredWords(input: string, rows: Array<Record<string, unknown>>): string[] {
  const all = rows.map(rowWords);
  return contentWords(input).filter((w) => !all.every((words) => carries(words, w)));
}

/**
 * Of the words the results don't carry, the ones this catalogue uses: in at
 * least one visible product. "emerald" in "rings with emerald" is one (the
 * shelf alone ignored it), so the results are held back; "wife", "gift" or a
 * grammar word are not. A word a catalogue uses everywhere ("gold" at a
 * jeweller's) is normally carried by the results already.
 */
export async function catalogueFilters(
  supabase: SupabaseClient,
  organizationId: string,
  words: string[],
): Promise<string[]> {
  const checks = await Promise.all(
    words.map(async (word) => {
      if (FUNCTION_WORDS.has(word)) return null;
      // Only plain letters and digits reach the text search; any other word
      // can't be checked here, so it is treated as a filter (held back).
      if (!/^[a-z0-9]+$/.test(word)) return word;
      const { count, error } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("is_visible", true)
        .textSearch("search_vector", word, { config: "simple" });
      if (error) return word;
      return (count ?? 0) > 0 ? word : null;
    }),
  );
  return checks.filter((w): w is string => Boolean(w));
}

/**
 * Runs the early search for the customer's words through the brokered
 * catalog_search, and decides whether its results may be given to the model.
 * Never throws: a failure is just "not usable".
 */
export async function earlyCatalogSearch(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    input: string;
    /** The run's brokered tools (catalog_search must be among them). */
    tools: Promise<BrokeredTool[]>;
    /** Visible products (the run's prelude): none, and there is nothing to search. */
    visibleProducts: Promise<number>;
    subject?: ToolContext["subject"];
    /** The run's own principal and acting user (the agent, on a live answer). */
    principal: ToolPrincipal;
    actorUserId: string | null;
    smallTalk: boolean;
  },
): Promise<EarlySearch> {
  const started = Date.now();
  const query = args.input.trim();
  const searchArgs: Record<string, unknown> = { query, limit: EARLY_LIMIT };
  const done = (partial: Omit<EarlySearch, "args" | "ms">): EarlySearch => ({
    args: searchArgs,
    ...partial,
    ms: Date.now() - started,
  });
  try {
    if (!query || args.smallTalk)
      return done({ result: null, usable: false, reason: "small_talk" });
    if (contentWords(query).length > MAX_WORDS)
      return done({ result: null, usable: false, reason: "too_long" });
    const [tools, visible] = await Promise.all([args.tools, args.visibleProducts]);
    if (!tools.some((t) => t.name === "catalog_search"))
      return done({ result: null, usable: false, reason: "not_offered" });
    if (visible <= 0) return done({ result: null, usable: false, reason: "no_products" });
    const { invokeTool } = await import("@/lib/ai-tools.server");
    const result = await invokeTool(
      {
        supabase,
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        principal: args.principal,
        initiatedBy: "ai",
        ...(args.subject ? { subject: args.subject } : {}),
      },
      "catalog_search",
      searchArgs,
      { brokered: tools },
    );
    const rows =
      result.ok && result.found !== false && Array.isArray(result.data)
        ? (result.data as Array<Record<string, unknown>>)
        : [];
    if (rows.length === 0)
      return done({ result, usable: false, reason: result.ok ? "nothing_found" : "error" });
    // A budget, a size or a code is a filter the plain words don't carry:
    // the model searches with it itself.
    if (hasFigure(query)) return done({ result, usable: false, reason: "has_figure" });
    const loose = uncoveredWords(query, rows);
    if (loose.length > 0) {
      const missing = await catalogueFilters(supabase, args.organizationId, loose);
      if (missing.length > 0)
        return done({ result, usable: false, reason: "words_not_covered", missing });
    }
    return done({ result, usable: true, reason: "used" });
  } catch {
    return done({ result: null, usable: false, reason: "error" });
  }
}
