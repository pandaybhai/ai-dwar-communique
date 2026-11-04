import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cardOfNode,
  edgeFrom,
  type FlowGraph,
  type FlowNode,
  type RunContext,
} from "@/lib/flow-graph";

/**
 * Batch 63 (E): draw a Send card step's picture while the customer is still
 * reading the buttons, so their tap only sends it.
 *
 * When a run waits at a buttons / list step, every option whose output leads
 * DIRECTLY to a send_card step has that card drawn now, with the values it
 * will have after that tap: the run's variables plus the answer the tap
 * records (last_answer and the step's own variable, exactly as advance()
 * writes them). Through renderCustomerCard, so:
 *  - it lands in customer-cards' cache under the card's cacheKey (workspace +
 *    design + every resolved value, brand paint included); at the tap the
 *    send step resolves its values again and gets this picture only when
 *    they are identical — a value that changed meanwhile is a different
 *    cacheKey and is drawn afresh, never the prefetched picture;
 *  - a real render is recorded once on ai_usage (card_render) as always; the
 *    tap's reuse records nothing. Nothing is charged (cards aren't priced).
 * Never sends, never writes the run, never throws. At most MAX_PREFETCH
 * cards per wait; nothing when the window is closed, there is no number, or
 * cards are off (the send step would send no card then either).
 */

export const MAX_PREFETCH = 3;

type Option = { id: string; title: string };

/** The cards a tap on each option of this step would send next. */
export function cardsAfterChoice(
  graph: FlowGraph,
  node: FlowNode,
  ctx: RunContext,
): Array<{ handle: string; kind: string; vars: Record<string, string> }> {
  if (node.type !== "buttons" && node.type !== "list") return [];
  const d = node.data;
  const options =
    ((node.type === "buttons" ? d["buttons"] : d["rows"]) as Option[] | undefined) ?? [];
  const variable = String(d["variable"] ?? "").trim();
  const out: Array<{ handle: string; kind: string; vars: Record<string, string> }> = [];
  const seen = new Set<string>();
  for (const o of options) {
    const edge = edgeFrom(graph, node.id, o.id);
    const next = edge ? graph.nodes.find((n) => n.id === edge.target) : null;
    if (!next || next.type !== "send_card") continue;
    // The variables as they will be right after this tap (advance(): matchReply → last_answer + variable).
    const vars = {
      ...(ctx.vars ?? {}),
      last_answer: o.title,
      ...(variable ? { [variable]: o.title } : {}),
    };
    const card = cardOfNode(next.data, { ...ctx, vars });
    if (!card) continue;
    const key = `${card.kind}:${JSON.stringify(card.vars)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ handle: o.id, kind: card.kind, vars: card.vars });
    if (out.length >= MAX_PREFETCH) break;
  }
  return out;
}

/** Draws them (in parallel). Resolves to how many pictures are ready. */
export async function prefetchCardsAfter(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    graph: FlowGraph;
    node: FlowNode;
    ctx: RunContext;
    windowOpen: boolean;
    connected: boolean;
  },
): Promise<number> {
  try {
    if (!args.windowOpen || !args.connected) return 0;
    const cards = cardsAfterChoice(args.graph, args.node, args.ctx);
    if (!cards.length) return 0;
    const lib = await import("@/lib/customer-cards.server");
    if (!(await lib.cardsEnabled(supabase, args.organizationId).catch(() => false))) return 0;
    const drawn = await Promise.all(
      cards.map((c) =>
        lib
          .renderCustomerCard(supabase, {
            organizationId: args.organizationId,
            kind: c.kind,
            vars: c.vars,
          })
          .catch(() => null),
      ),
    );
    return drawn.filter(Boolean).length;
  } catch (error) {
    console.warn("[card-prefetch]", error instanceof Error ? error.message : String(error));
    return 0;
  }
}

/** Prefetches started by a run's advance, awaited before its request ends (a Worker drops what isn't). */
const pending = new Map<string, Promise<unknown>[]>();

export function holdPrefetch(runId: string, work: Promise<unknown>): void {
  const list = pending.get(runId) ?? [];
  list.push(work.catch(() => 0));
  pending.set(runId, list);
}

/** Awaited after the prompt went out and the run was saved: the customer already has the buttons. */
export async function settlePrefetch(runId: string): Promise<void> {
  const list = pending.get(runId);
  if (!list) return;
  pending.delete(runId);
  await Promise.all(list);
}
