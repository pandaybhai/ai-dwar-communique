import type { SupabaseClient } from "@supabase/supabase-js";
import { REFUSAL_COLUMNS, type RefusalRecord } from "@/lib/api-refusals";
import {
  dateBounds,
  nestCopies,
  refusalLine,
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
 *
 * Batch 67: plus the template's refused API sends (public.api_refusals,
 * 20261370, through the member's own client): listed with the sends, newest
 * first — each page of sends carries the refusals between its oldest send
 * and the previous page's (at most REFUSAL_WINDOW_MAX), so paging never
 * skips or repeats one — counted in totals.refused, and alone with the
 * "Refused" status filter. templateName null: only the refusals that named
 * no template ("Refused (no template)"). Without the table the reads come
 * back empty and the report is what it was.
 */

export const SEND_PAGE = 50;

const COLUMNS =
  "id, created_at, status, status_updated_at, error_detail, template_name, campaign_id, flow_id, sent_by, metadata, conversation_id, conversations(contact_id, contacts(id, name, phone))";

type Q = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

export const REFUSAL_WINDOW_MAX = 500;

type Args = { organizationId: string; templateName: string | null; filters: SendFilters };

/** The template's (or, null, the no-template) refusals in the filters' dates. */
function refusals(
  client: SupabaseClient,
  args: Args,
  columns: string,
  opts?: { count: "exact"; head: true },
): Q {
  let q = client
    .from("api_refusals")
    .select(columns, opts)
    .eq("organization_id", args.organizationId) as unknown as Q;
  q = (args.templateName === null
    ? q.is("template_name", null)
    : q.eq("template_name", args.templateName)) as unknown as Q;
  const { gte, lt } = dateBounds(args.filters);
  if (gte) q = q.gte("created_at", gte) as unknown as Q;
  if (lt) q = q.lt("created_at", lt) as unknown as Q;
  return q;
}

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
  args: Args & { page?: number },
): Promise<SendsPage> {
  const page = Math.max(args.page ?? 0, 0);
  const status = statusFilter(args.filters);
  // Refusals are API sends: shown for "all" or "API" sources, any or "Refused" status.
  const wantRefusals =
    (args.filters.source === "all" || args.filters.source === "api") &&
    (status === "all" || status === "refused");
  const refusedTotal = (): Promise<number> =>
    args.filters.source === "all" || args.filters.source === "api"
      ? (
          refusals(client, args, "id", { count: "exact", head: true }) as unknown as Promise<{
            count?: number | null;
            error?: unknown;
          }>
        ).then(
          (r) => (r.error ? 0 : (r.count ?? 0)),
          () => 0,
        )
      : Promise.resolve(0);
  const failedLoad = (): SendsPage => ({
    lines: [],
    totals: totalsFrom({}, 0),
    hasMore: false,
    error: "We couldn't load the sends. Please try again.",
  });

  // ---- only refusals: the "Refused" filter, or no template at all ----
  if (args.templateName === null || status === "refused") {
    const [listRes, refused] = await Promise.all([
      wantRefusals
        ? (refusals(client, args, REFUSAL_COLUMNS)
            .order("created_at", { ascending: false })
            .range(page * SEND_PAGE, page * SEND_PAGE + SEND_PAGE) as unknown as Promise<{
            data: RefusalRecord[] | null;
            error: { message: string } | null;
          }>)
        : Promise.resolve({ data: [] as RefusalRecord[], error: null }),
      refusedTotal(),
    ]);
    if (listRes.error) return failedLoad();
    const list = listRes.data ?? [];
    const counts =
      args.templateName === null ? totalsFrom({}, 0, refused) : await messageTotals(refused);
    return {
      lines: list.slice(0, SEND_PAGE).map(refusalLine),
      totals: counts,
      hasMore: list.length > SEND_PAGE,
      error: null,
    };
  }

  async function messageTotals(refused: number): Promise<SendTotals> {
    const named = { ...args, templateName: args.templateName as string };
    const count = (st: SendStatus) =>
      withStatus(
        onlyCustomerSends(scoped(client, named, "id", { count: "exact", head: true })),
        st,
      ).then((r: { count?: number | null }) => r.count ?? 0);
    const [sent, delivered, read, failed, copies] = await Promise.all([
      count("sent"),
      count("delivered"),
      count("read"),
      count("failed"),
      onlyCopies(scoped(client, named, "id", { count: "exact", head: true })).then(
        (r: { count?: number | null }) => r.count ?? 0,
      ),
    ]);
    return totalsFrom({ sent, delivered, read, failed }, copies, refused);
  }

  const named = { ...args, templateName: args.templateName };
  // Page > 0 also reads the row just before it: the window's upper edge for refusals.
  const start = page > 0 ? page * SEND_PAGE - 1 : 0;
  const [rowsRes, totals] = await Promise.all([
    withStatus(onlyCustomerSends(scoped(client, named, COLUMNS)), status)
      .order("created_at", { ascending: false })
      .range(start, page * SEND_PAGE + SEND_PAGE) as unknown as Promise<{
      data: SendRow[] | null;
      error: { message: string } | null;
    }>,
    refusedTotal().then(messageTotals),
  ]);
  if (rowsRes.error) return failedLoad();
  let rows = rowsRes.data ?? [];
  let upper: string | null = dateBounds(args.filters).lt;
  if (page > 0) {
    upper = rows[0]?.created_at ?? upper;
    rows = rows.slice(1);
  }
  const hasMore = rows.length > SEND_PAGE;
  const pageRows = rows.slice(0, SEND_PAGE);

  // The page's copies (each send has at most 10), campaign names and refusals, read together.
  const ids = pageRows.map((r) => r.id);
  const campaignIds = [
    ...new Set(pageRows.map((r) => r.campaign_id).filter((x): x is string => Boolean(x))),
  ];
  const lower = hasMore ? (pageRows[pageRows.length - 1]?.created_at ?? null) : null;
  const refusalsInWindow = (): Promise<RefusalRecord[]> => {
    if (!wantRefusals) return Promise.resolve([]);
    let q = refusals(client, args, REFUSAL_COLUMNS);
    if (upper) q = q.lt("created_at", upper) as unknown as Q;
    if (lower) q = q.gte("created_at", lower) as unknown as Q;
    return (
      q.order("created_at", { ascending: false }).limit(REFUSAL_WINDOW_MAX) as unknown as Promise<{
        data: RefusalRecord[] | null;
        error: unknown;
      }>
    ).then(
      (r) => (r.error ? [] : (r.data ?? [])),
      () => [],
    );
  };
  const [copyRes, campaignRes, refused] = await Promise.all([
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
    refusalsInWindow(),
  ]);
  const names = new Map((campaignRes.data ?? []).map((c) => [c.id, c.name]));
  for (const r of pageRows)
    if (r.campaign_id) r.campaigns = { name: names.get(r.campaign_id) ?? null };

  const lines = [...nestCopies(pageRows, copyRes.data ?? []), ...refused.map(refusalLine)].sort(
    (a, b) => b.at.localeCompare(a.at),
  );
  return { lines, totals, hasMore, error: null };
}

/** Every line for the CSV (owner/admin), up to `max` customer sends. */
export async function loadAllTemplateSends(
  client: SupabaseClient,
  args: Args,
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
