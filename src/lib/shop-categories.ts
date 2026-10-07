/**
 * A shop's own categories, as its products carry them — the only shelf words
 * product search knows. Nothing here is about one kind of business: a
 * category is whatever the workspace's products say ("rings", "T-Shirts",
 * "Phone cases"), and the extra words its customers use for one ("anguthi",
 * "tees") come from that workspace's own settings
 * (organizations.branding.category_words: { category: [words] }).
 *
 * Pure functions, browser-safe. The loader is shop-categories.server.ts.
 */

/** Where a workspace keeps its customers' words for its categories. */
export const CATEGORY_WORDS_SETTING = "category_words";

export type ShopCategory = { name: string; products: number };

export type ShopVocabulary = {
  /** Every distinct category on the shop's visible products, most products first. */
  categories: ShopCategory[];
  /** The workspace's own extra words, by the category they mean. */
  words: Record<string, string[]>;
  /** False when the list was cut short (a very large catalogue). */
  complete: boolean;
};

export const EMPTY_VOCABULARY: ShopVocabulary = { categories: [], words: {}, complete: true };

/** The shelf a phrase names: the matched words and every shop category they cover. */
export type Shelf = {
  /** The shop's own name for it (the best-matching category, as stored). */
  name: string;
  /** Every stored category value the phrase covers ("rings" covers "Rings" and "Gold rings"). */
  categories: string[];
  /** The phrase's words that named it, stemmed (for "is this word already used"). */
  tokens: string[];
};

/** Gender words customers use. Language, not product words. */
const GENDER_RE: Array<[RegExp, "male" | "female"]> = [
  [/\bgents?\b|\bmens?\b|\bmen['’]s\b|\bmale\b|\bboys?\b|for him/i, "male"],
  [/\bladies\b|\bwomens?\b|\bwomen['’]s\b|\bfemale\b|\bgirls?\b|for her/i, "female"],
];

/**
 * Words that ask for everything rather than a kind of product ("show all",
 * "any products"). Language only.
 */
const BROWSE_WORDS = new Set([
  "all",
  "any",
  "anything",
  "everything",
  "something",
  "some",
  "item",
  "product",
  "piece",
  "thing",
  "stuff",
  "collection",
  "catalogue",
  "catalog",
  "range",
  "design",
  "option",
  "new",
  "latest",
  "for",
  "him",
  "her",
  "the",
  "and",
  "of",
  "a",
  "an",
]);

/** "male" / "female" when a phrase says so, otherwise null. */
export function genderOf(text: string): "male" | "female" | null {
  const t = text.trim();
  if (/^male$/i.test(t)) return "male";
  if (/^female$/i.test(t)) return "female";
  for (const [re, word] of GENDER_RE) if (re.test(t)) return word;
  return null;
}

/** The phrase without its gender words. */
function withoutGender(text: string): string {
  let out = text;
  for (const [re] of GENDER_RE) out = out.replace(new RegExp(re.source, "gi"), " ");
  return out;
}

/** One word, singular: "rings" → "ring", "watches" → "watch", "accessories" → "accessory". */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** A phrase as its words, lower-case and singular, in any script. */
export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);
}

/** `needle` appears in `hay` as consecutive whole words. */
function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

/** The stored categories a set of words covers, most products first. */
function covered(vocab: ShopVocabulary, tokens: string[]): ShopCategory[] {
  return vocab.categories.filter((c) => containsRun(tokensOf(c.name), tokens));
}

/**
 * The shop category a phrase names, from the shop's own category names and
 * its own extra words. The longest match wins ("gold rings" over "rings");
 * a category's own name beats an extra word of the same length.
 */
export function resolveShelf(text: string, vocab: ShopVocabulary): Shelf | null {
  const tokens = tokensOf(text);
  if (tokens.length === 0) return null;
  type Match = { tokens: string[]; direct: boolean; cats: ShopCategory[] };
  const matches: Match[] = [];
  for (const c of vocab.categories) {
    const ct = tokensOf(c.name);
    if (containsRun(tokens, ct)) matches.push({ tokens: ct, direct: true, cats: covered(vocab, ct) });
  }
  for (const [target, words] of Object.entries(vocab.words)) {
    const tt = tokensOf(target);
    const cats = covered(vocab, tt);
    if (cats.length === 0) continue;
    for (const w of words) {
      const wt = tokensOf(w);
      if (containsRun(tokens, wt)) matches.push({ tokens: wt, direct: false, cats });
    }
  }
  if (matches.length === 0) return null;
  const sum = (m: Match) => m.cats.reduce((n, c) => n + c.products, 0);
  matches.sort(
    (a, b) => b.tokens.length - a.tokens.length || Number(b.direct) - Number(a.direct) || sum(b) - sum(a),
  );
  const best = matches[0]!;
  return { name: best.cats[0]!.name, categories: best.cats.map((c) => c.name), tokens: best.tokens };
}

/**
 * The words of a category request that name no shop category: "nose pins"
 * at a shop without them. Gender words and "all"/"any" ask for no kind, so
 * they are never an unknown category.
 */
export function unknownCategory(text: string, vocab: ShopVocabulary): string | null {
  if (resolveShelf(text, vocab)) return null;
  const rest = withoutGender(text);
  const words = tokensOf(rest).filter((t) => !BROWSE_WORDS.has(t));
  return words.length > 0 ? rest.replace(/\s+/g, " ").trim() : null;
}

/** True when the shelf's own name says the gender ("Men's Shirts"): no second gender filter needed. */
export function shelfSaysGender(shelf: Shelf, gender: "male" | "female"): boolean {
  return shelf.categories.every((c) => genderOf(c) === gender);
}

/** The workspace's extra words, cleaned: { category: [word, …] } with no blanks or repeats. */
export function cleanCategoryWords(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = category.trim().slice(0, 120);
    if (!name) continue;
    const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
      .map((w) => (typeof w === "string" ? w.trim().slice(0, 60) : ""))
      .filter(Boolean);
    const unique = Array.from(new Set(list.map((w) => w.toLowerCase()))).slice(0, 30);
    if (unique.length) out[name] = unique;
  }
  return out;
}

/**
 * Every word that names a kind of product at this shop — its categories and
 * its extra words — as stemmed word runs. The "only offer what search
 * found" guard reads these.
 */
export function shelfPhrases(vocab: ShopVocabulary): string[][] {
  const phrases = [
    ...vocab.categories.map((c) => tokensOf(c.name)),
    ...Object.values(vocab.words).flat().map(tokensOf),
  ].filter((t) => t.length > 0);
  const seen = new Set<string>();
  return phrases.filter((t) => {
    const key = t.join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "rings, earrings, tanmaniya" — how a run tells the model what this shop sells. */
export function describeCategories(vocab: ShopVocabulary, max = 40): string {
  return vocab.categories
    .slice(0, max)
    .map((c) => c.name)
    .join(", ");
}
