import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dateBounds,
  nestCopies,
  sourceClauses,
  statusFilter,
  totalsFrom,
  type SendFilters,
  type SendLine,
  type SendRow,
  type SendStatus,
  type SendTotals,
} from "@/lib/template-sends";

/**
 * Batch 63 (C): the template Sent report's reads, through the member's own
 * client (RLS) — the same messages rows the Inbox shows. Read-only.
 *
 *  - the page: the template's customer sends (copies left out), newest first;
 *  - their copies: rows whose metadata.cc_of is one of the page's ids;
 *  - totals: head counts per status (never the 1,000-row cap), plus copies.
 *
 * 20261350_batch63.sql adds messages_template_sends_idx
 * (organization_id, template_name, created_at desc) for these reads.
 */

export const SEND_PAGE = 50;

const COLUMNS =
  "id, created_at, status, status_updated_at, error_detail, template_name, campaign_id, flow_id, sent_by, metadata, conversation_id, conversations(contact_id, contacts(id, name, phone))";

type Q = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

function scoped(
  client: SupabaseClient,
  args: { organizationId: string; templateName: string; filters: SendFilters },
  columns: string,
  opts?: { count: "exact"; head: true },
): Q {
  let q = client
    .from("messages")
    .select(columns, opts)
    .eq("organization_id", args.organizationId)
    .eq("direction", "outbound")
    .eq("type", "template")
    .eq("template_name", args.templateName) as unknown as Q;
  const { gte, lt } = dateBounds(args.filters);
  if (gte) q = q.gte("created_at", gte) as unknown as Q;
  if (lt) q = q.lt("created_at", lt) as unknown as Q;
  if (args.filters.source !== "all") {
    const c = sourceClauses(args.filters.source);
    for (const [col, v] of c.eq ?? []) q = q.eq(col, v) as unknown as Q;
    for (const [col] of c.is ?? []) q = q.is(col, null) as unknown as Q;
    for (const [col, op, v] of c.not ?? []) q = q.not(col, op, v) as unknown as Q;
    if (c.or) q = q.or(c.or) as unknown as Q;
  }
  return q;
}

const onlyCustomerSends = (q: Q): Q => q.is("metadata->>cc_of", null) as unknown as Q;
const onlyCopies = (q: Q): Q => q.not("metadata->>cc_of", "is", null) as unknown as Q;

function withStatus(q: Q, status: SendStatus | "all"): Q {
  return status === "all" ? q : (q.eq("status", status) as unknown as Q);
}

export type SendsPage = {
  lines: SendLine[];
  totals: SendTotals;
  hasMore: boolean;
  error: string | null;
};

export async function loadTemplateSends(
  client: SupabaseClient,
  args: { organizationId: string; templateName: string; filters: SendFilters; page?: number },
): Promise<SendsPage> {
  const page = Math.max(args.page ?? 0, 0);
  const status = statusFilter(args.filters);
  const count = (s: SendStatus) =>
    withStatus(
      onlyCustomerSends(scoped(client, args, "id", { count: "exact", head: true })),
      s,
    ).then((r: { count?: number | null }) => r.count ?? 0);
  const [rowsRes, sent, delivered, read, failed, copies] = await Promise.all([
    withStatus(onlyCustomerSends(scoped(client, args, COLUMNS)), status)
      .order("created_at", { ascending: false })
      .range(page * SEND_PAGE, page * SEND_PAGE + SEND_PAGE) as unknown as Promise<{
      data: SendRow[] | null;
      error: { message: string } | null;
    }>,
    count("sent"),
    count("delivered"),
    count("read"),
    count("failed"),
    onlyCopies(scoped(client, args, "id", { count: "exact", head: true })).then(
      (r: { count?: number | null }) => r.count ?? 0,
    ),
  ]);
  if (rowsRes.error) {
    return {
      lines: [],
      totals: totalsFrom({}, 0),
      hasMore: false,
      error: "We couldn't load the sends. Please try again.",
    };
  }
  const rows = rowsRes.data ?? [];
  const hasMore = rows.length > SEND_PAGE;
  const pageRows = rows.slice(0, SEND_PAGE);

  // The page's copies (each send has at most 10) and campaign names, read together.
  const ids = pageRows.map((r) => r.id);
  const campaignIds = [
    ...new Set(pageRows.map((r) => r.campaign_id).filter((x): x is string => Boolean(x))),
  ];
  const [copyRes, campaignRes] = await Promise.all([
    ids.length
      ? (client
          .from("messages")
          .select(COLUMNS)
          .eq("organization_id", args.organizationId)
          .in("metadata->>cc_of", ids)
          .limit(ids.length * 10) as unknown as Promise<{ data: SendRow[] | null }>)
      : Promise.resolve({ data: [] as SendRow[] }),
    campaignIds.length
      ? (client.from("campaigns").select("id, name").in("id", campaignIds) as unknown as Promise<{
          data: Array<{ id: string; name: string | null }> | null;
        }>)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string | null }> }),
  ]);
  const names = new Map((campaignRes.data ?? []).map((c) => [c.id, c.name]));
  for (const r of pageRows)
    if (r.campaign_id) r.campaigns = { name: names.get(r.campaign_id) ?? null };

  return {
    lines: nestCopies(pageRows, copyRes.data ?? []),
    totals: totalsFrom({ sent, delivered, read, failed }, copies),
    hasMore,
    error: null,
  };
}

/** Every line for the CSV (owner/admin), up to `max` customer sends. */
export async function loadAllTemplateSends(
  client: SupabaseClient,
  args: { organizationId: string; templateName: string; filters: SendFilters },
  max = 5000,
): Promise<SendLine[]> {
  const out: SendLine[] = [];
  for (let page = 0; page * SEND_PAGE < max; page += 1) {
    const r = await loadTemplateSends(client, { ...args, page });
    if (r.error) break;
    out.push(...r.lines);
    if (!r.hasMore) break;
  }
  return out;
}
