import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunMedia } from "@/lib/ai-run.server";
import type { productQueryOf } from "@/lib/flow-graph";
import type { ReplyTimer } from "@/lib/reply-timing";

/**
 * Flows v2 "Show products": no AI. The workspace's own products are searched
 * with the same search Aiden's catalogue tool uses, and each match goes out as
 * a picture with its name, price and link (the same pictures Aiden sends).
 * Nothing at that budget: the nearest real products are offered with their
 * real starting price. Nothing is ever made up.
 */

export type ProductQuery = ReturnType<typeof productQueryOf>;

type Row = Record<string, unknown>;

const money = (n: number) => `₹${new Intl.NumberFormat("en-IN").format(Math.floor(n))}`;

/** "under ₹25,000", "between ₹25,000 and ₹50,000", "from ₹1,00,000", or "". */
export function budgetWords(q: Pick<ProductQuery, "minPrice" | "maxPrice">): string {
  if (q.minPrice !== null && q.maxPrice !== null) return `between ${money(q.minPrice)} and ${money(q.maxPrice)}`;
  if (q.maxPrice !== null) return `under ${money(q.maxPrice)}`;
  if (q.minPrice !== null) return `from ${money(q.minPrice)}`;
  return "";
}

/** The catalogue search arguments for a step's query. */
export function searchArgs(q: ProductQuery, shelf: string): Record<string, unknown> {
  return {
    limit: q.limit,
    // A shelf the search knows filters by category; any other word is
    // searched for by name.
    ...(shelf ? { category: q.category } : q.category ? { query: q.category } : {}),
    ...(q.maxPrice !== null ? { max_price: q.maxPrice } : {}),
    ...(q.minPrice !== null ? { min_price: q.minPrice } : {}),
  };
}

/** Rows → pictures (those with a picture) and plain lines (those without). */
function split(rows: Row[], collect: (rows: Row[], into: RunMedia[]) => void): { pictures: RunMedia[]; plain: Row[] } {
  const pictures: RunMedia[] = [];
  collect(rows, pictures);
  const shown = new Set(pictures.map((p) => p.title));
  return { pictures, plain: rows.filter((r) => !shown.has(String(r["title"] ?? "").trim()) && String(r["title"] ?? "").trim()) };
}

function plainLine(row: Row): string {
  const price = Number(row["price"]);
  const url = typeof row["product_url"] === "string" ? row["product_url"] : "";
  return `${String(row["title"]).trim()}${Number.isFinite(price) && price > 0 ? ` — ${money(price)}` : ""}${url ? `\n${url}` : ""}`;
}

export async function showProducts(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string | null;
    conversationId: string;
    to: string;
    phoneNumberId: string;
    accessToken: string;
    windowOpen: boolean;
    timer?: ReplyTimer;
    metadata: Record<string, unknown>;
    query: ProductQuery;
  },
): Promise<{ ok: boolean; found: boolean; shown: number; error: string | null }> {
  const { AI_TOOL_HANDLERS, canonCategory } = await import("@/lib/ai-tools.server");
  const { collectProductMedia } = await import("@/lib/ai-run.server");
  const { enabledFlags } = await import("@/lib/feature-flags.server");
  const { sendProductPictures } = await import("@/lib/product-pictures.server");
  const { sendServiceText } = await import("@/lib/service-text.server");

  const q = args.query;
  const shelf = canonCategory(q.category);
  const result = await AI_TOOL_HANDLERS["catalogSearch"]!(
    { supabase, organizationId: args.organizationId, actorUserId: null, initiatedBy: "ai" },
    searchArgs(q, shelf),
  );
  if (!result.ok) return { ok: false, found: false, shown: 0, error: result.error ?? "product_search_failed" };

  const collect = (rows: Row[], into: RunMedia[]) => collectProductMedia("catalog_search", { ok: true, data: rows }, into);
  const sender = {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.to,
    windowOpen: args.windowOpen,
    ...(args.timer ? { timer: args.timer } : {}),
  };
  const cards = (await enabledFlags(supabase, args.organizationId).catch(() => new Set<string>())).has("cards");
  let failure: string | null = null;
  const send = async (rows: Row[]): Promise<number> => {
    const { pictures, plain } = split(rows, collect);
    let shown = await sendProductPictures(supabase, {
      ...sender,
      contactId: args.contactId,
      items: pictures,
      cards,
      withLink: true,
      metadata: args.metadata,
      onFailure: (error) => (failure = error ?? "send_failed"),
    });
    if (plain.length > 0) {
      const res = await sendServiceText(supabase, { ...sender, body: plain.map(plainLine).join("\n\n"), metadata: args.metadata });
      if (res.ok) shown += plain.length;
      else failure = res.error ?? "send_failed";
    }
    return shown;
  };

  const rows = Array.isArray(result.data) ? (result.data as Row[]).slice(0, q.limit) : [];
  if (rows.length > 0) {
    const shown = await send(rows);
    return shown > 0 ? { ok: true, found: true, shown, error: null } : { ok: false, found: true, shown: 0, error: failure ?? "send_failed" };
  }

  // Nothing matches: say what does exist and what it really costs.
  const data = (result.data ?? {}) as { closest_above?: Row[]; lowest_price?: number | null };
  const closest = (data.closest_above ?? []).slice(0, Math.min(q.limit, 3));
  const lowest = typeof data.lowest_price === "number" ? data.lowest_price : null;
  if (closest.length === 0 || lowest === null) return { ok: true, found: false, shown: 0, error: null };
  const word = (shelf || q.category || "products").toLowerCase();
  const budget = budgetWords(q);
  const intro = await sendServiceText(supabase, {
    ...sender,
    body: `We don't have ${word}${budget ? ` ${budget}` : ""} right now — our ${word} start at ${money(lowest)}. Here ${closest.length === 1 ? "is the closest one" : "are the closest ones"}:`,
    metadata: args.metadata,
  });
  if (!intro.ok) return { ok: false, found: false, shown: 0, error: intro.error ?? "send_failed" };
  const shown = await send(closest);
  return { ok: true, found: false, shown, error: null };
}
