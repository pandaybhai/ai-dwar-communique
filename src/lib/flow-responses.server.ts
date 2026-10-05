import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraph } from "@/lib/flow-graph";
import { like, q } from "@/lib/segments.server";
import {
  RESPONSES_EXPORT_MAX,
  RESPONSE_STATUSES,
  answerColumns,
  buildRow,
  questionSteps,
  searchableVariables,
  type QuestionStep,
  type ResponseColumn,
  type ResponseRow,
  type ResponsesFilters,
  type ResponsesSummary,
  type RunRecord,
} from "@/lib/flow-responses";

/**
 * Server side of the Flows v2 Responses tab. Every read is scoped to the
 * caller's organization and the one flow, filtered and paginated in SQL —
 * runs are never all loaded into memory.
 */

export type ResponsesContext = {
  organizationId: string;
  flowId: string;
  flowName: string;
  columns: ResponseColumn[];
  questions: QuestionStep[];
  versions: Map<string, { version: number; graph: FlowGraph }>;
};

/** Filters as SQL pieces; `or` is a PostgREST or-expression for the search. */
type Resolved = { from: string | null; to: string | null; statuses: string[] | null; or: string | null };

const RUN_SELECT =
  "id, contact_id, conversation_id, version_id, status, current_node_id, variables, started_at, contacts(name, phone, attributes)";
/** Drop-off counts are one small count query each; a flow rarely has more questions. */
const MAX_DROP_OFF_STEPS = 30;
const EXPORT_CHUNK = 500;
const MAX_SEARCH_CONTACTS = 200;

/** The organization's own Flows v2 flow with its versions, or null. */
export async function loadResponsesContext(
  db: SupabaseClient,
  organizationId: string,
  flowId: string,
): Promise<ResponsesContext | null> {
  const { data: flow } = await db
    .from("flows")
    .select("id, name, key")
    .eq("id", flowId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const f = flow as { id: string; name: string; key: string } | null;
  if (!f || !String(f.key ?? "").startsWith("v2:")) return null;
  const { data: vers } = await db
    .from("flow_versions")
    .select("id, version, status, graph")
    .eq("flow_id", flowId)
    .eq("organization_id", organizationId)
    .order("version", { ascending: false });
  // Runs only ever start on a published version, so a draft adds no columns.
  const rows = ((vers ?? []) as Array<{ id: string; version: number; status: string; graph: FlowGraph | null }>).filter(
    (v) => v.status !== "draft",
  );
  const graphs = rows.map((v) => v.graph ?? { nodes: [], edges: [] });
  return {
    organizationId,
    flowId,
    flowName: f.name,
    columns: answerColumns(graphs),
    questions: questionSteps(graphs),
    versions: new Map(rows.map((v, i) => [v.id, { version: v.version, graph: graphs[i]! }])),
  };
}

/** Search text safe inside a PostgREST filter: no wildcards, separators or quotes. */
export function cleanSearch(raw: string | null | undefined): string {
  return like(String(raw ?? ""))
    .replace(/[%,()"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** null when the search can match nothing. */
async function resolveFilters(db: SupabaseClient, ctx: ResponsesContext, f: ResponsesFilters, withStatus: boolean): Promise<Resolved | null> {
  const status = withStatus && f.status && f.status !== "all" ? RESPONSE_STATUSES[f.status] : null;
  const out: Resolved = { from: f.from || null, to: f.to || null, statuses: status, or: null };
  const s = cleanSearch(f.search);
  if (!s) return out;
  const parts: string[] = [];
  // Customers of this flow whose name or phone matches (capped: the ids travel in the request URL).
  const digits = s.replace(/\D/g, "");
  const who = [`name.ilike.${q(`*${s}*`)}`, ...(digits.length >= 3 ? [`phone.ilike.${q(`*${digits}*`)}`] : [])];
  const { data: people } = await db
    .from("contacts")
    .select("id, flow_runs!inner(id)")
    .eq("organization_id", ctx.organizationId)
    .eq("flow_runs.flow_id", ctx.flowId)
    .or(who.join(","))
    .limit(1, { referencedTable: "flow_runs" })
    .limit(MAX_SEARCH_CONTACTS);
  const ids = ((people ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (ids.length) parts.push(`contact_id.in.(${ids.join(",")})`);
  // Answers: only the variables shown as columns (never internal keys).
  for (const v of searchableVariables(ctx.columns)) parts.push(`variables->>${v}.ilike.${q(`*${s}*`)}`);
  if (!parts.length) return null;
  out.or = parts.join(",");
  return out;
}

/** rows: just rows; counted: rows and the total; head: the total only. */
function scopedRuns(db: SupabaseClient, ctx: ResponsesContext, r: Resolved, select: string, mode: "rows" | "counted" | "head") {
  let query = db
    .from("flow_runs")
    .select(select, mode === "rows" ? {} : { count: "exact", head: mode === "head" })
    .eq("organization_id", ctx.organizationId)
    .eq("flow_id", ctx.flowId);
  if (r.from) query = query.gte("started_at", r.from);
  if (r.to) query = query.lt("started_at", r.to);
  if (r.statuses) query = query.in("status", r.statuses);
  if (r.or) query = query.or(r.or);
  return query;
}

/** Update field steps each run passed (`${run_id}:${node_id}`). */
async function fieldStepsPassed(db: SupabaseClient, ctx: ResponsesContext, runIds: string[]): Promise<Set<string>> {
  const nodeIds = ctx.columns.filter((c) => c.kind === "field").flatMap((c) => c.nodeIds);
  if (!nodeIds.length || !runIds.length) return new Set();
  const { data } = await db
    .from("flow_run_events")
    .select("run_id, node_id")
    .eq("organization_id", ctx.organizationId)
    .in("run_id", runIds)
    .in("node_id", nodeIds)
    .eq("event", "exited")
    .limit(5000);
  return new Set(((data ?? []) as Array<{ run_id: string; node_id: string }>).map((e) => `${e.run_id}:${e.node_id}`));
}

async function rowsFor(db: SupabaseClient, ctx: ResponsesContext, runs: RunRecord[]): Promise<ResponseRow[]> {
  const passed = await fieldStepsPassed(db, ctx, runs.map((r) => r.id));
  return runs.map((r) => buildRow(r, ctx.columns, ctx.versions, passed));
}

/** Runs started, finished, completion rate and drop-off per question — date range and search, any status. */
export async function responsesSummary(db: SupabaseClient, ctx: ResponsesContext, f: ResponsesFilters): Promise<ResponsesSummary> {
  const r = await resolveFilters(db, ctx, f, false);
  const steps = ctx.questions.slice(0, MAX_DROP_OFF_STEPS);
  if (!r) return { started: 0, finished: 0, completion_rate: 0, drop_off: steps.map((s) => ({ node_id: s.nodeId, label: s.label, count: 0 })) };
  const n = async (p: PromiseLike<{ count: number | null }>) => (await p).count ?? 0;
  const [started, finished, ...dropped] = await Promise.all([
    n(scopedRuns(db, ctx, r, "id", "head")),
    n(scopedRuns(db, ctx, r, "id", "head").eq("status", "done")),
    ...steps.map((s) => n(scopedRuns(db, ctx, r, "id", "head").eq("current_node_id", s.nodeId).neq("status", "done"))),
  ]);
  return {
    started: started!,
    finished: finished!,
    completion_rate: started ? Math.round((finished! / started!) * 100) : 0,
    drop_off: steps.map((s, i) => ({ node_id: s.nodeId, label: s.label, count: dropped[i] ?? 0 })),
  };
}

/** One page of rows, newest first. */
export async function listResponses(
  db: SupabaseClient,
  ctx: ResponsesContext,
  f: ResponsesFilters,
  page: number,
  pageSize: number,
): Promise<{ rows: ResponseRow[]; total: number; error: string | null }> {
  const r = await resolveFilters(db, ctx, f, true);
  if (!r) return { rows: [], total: 0, error: null };
  const from = page * pageSize;
  const { data, count, error } = await scopedRuns(db, ctx, r, RUN_SELECT, "counted")
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) return { rows: [], total: 0, error: error.message };
  return { rows: await rowsFor(db, ctx, (data ?? []) as unknown as RunRecord[]), total: count ?? 0, error: null };
}

/** Every filtered row for the CSV (read 500 at a time, at most RESPONSES_EXPORT_MAX). */
export async function exportResponses(
  db: SupabaseClient,
  ctx: ResponsesContext,
  f: ResponsesFilters,
  max = RESPONSES_EXPORT_MAX,
): Promise<{ rows: ResponseRow[]; truncated: boolean; error: string | null }> {
  const r = await resolveFilters(db, ctx, f, true);
  if (!r) return { rows: [], truncated: false, error: null };
  const rows: ResponseRow[] = [];
  for (let from = 0; from < max; from += EXPORT_CHUNK) {
    const to = Math.min(from + EXPORT_CHUNK, max) - 1;
    const { data, error } = await scopedRuns(db, ctx, r, RUN_SELECT, "rows")
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    if (error) return { rows: [], truncated: false, error: error.message };
    const chunk = (data ?? []) as unknown as RunRecord[];
    rows.push(...(await rowsFor(db, ctx, chunk)));
    if (chunk.length < to - from + 1) return { rows, truncated: false, error: null };
    if (to + 1 >= max) {
      const { count } = await scopedRuns(db, ctx, r, "id", "head");
      return { rows, truncated: (count ?? 0) > max, error: null };
    }
  }
  return { rows, truncated: false, error: null };
}
