/**
 * Flows v2 "Responses" tab — what each customer answered in a chat flow.
 * Browser-safe: shared by the API route, the CSV export and the editor tab.
 * Reads only existing flow_runs data; nothing here changes how a flow runs.
 */
import { csvSafeCell, toCsv } from "@/lib/csv";
import { interpolate, type FlowGraph, type FlowNode } from "@/lib/flow-graph";

export const RESPONSES_PAGE_SIZE = 50;
/** Most rows one CSV download carries (read from the database 500 at a time). */
export const RESPONSES_EXPORT_MAX = 10000;

/** Steps that wait for the customer and save the answer to a variable. */
const ANSWER_TYPES = new Set(["ask", "buttons", "list", "location_request"]);

export type ResponseStatus = "finished" | "waiting" | "stopped" | "failed";

/** flow_runs.status values behind each status the merchant sees. */
export const RESPONSE_STATUSES: Record<ResponseStatus, string[]> = {
  finished: ["done"],
  waiting: ["running", "waiting", "paused"],
  stopped: ["cancelled", "expired"],
  failed: ["failed"],
};

export const RESPONSE_STATUS_LABELS: Record<ResponseStatus, string> = {
  finished: "Finished",
  waiting: "Waiting",
  stopped: "Stopped",
  failed: "Failed",
};

export function responseStatus(dbStatus: string): ResponseStatus {
  for (const [k, list] of Object.entries(RESPONSE_STATUSES)) if (list.includes(dbStatus)) return k as ResponseStatus;
  return "stopped";
}

/** One answer column: a variable saved by a question step, or a field set by an Update field step. */
export type ResponseColumn = { key: string; label: string; kind: "variable" | "field"; nodeIds: string[] };
export type QuestionStep = { nodeId: string; label: string };

export type ResponseRow = {
  run_id: string;
  contact_id: string;
  conversation_id: string | null;
  name: string;
  phone: string;
  started_at: string;
  status: ResponseStatus;
  /** The step an unfinished run is waiting at or stopped at. */
  step: string | null;
  version: number | null;
  answers: Record<string, string>;
};

export type ResponsesSummary = {
  started: number;
  finished: number;
  /** Whole percent of started runs that finished. */
  completion_rate: number;
  /** Unfinished runs whose last step was this question. */
  drop_off: Array<{ node_id: string; label: string; count: number }>;
};

export type ResponsesFilters = {
  from?: string | null | undefined;
  to?: string | null | undefined;
  status?: ResponseStatus | "all" | undefined;
  search?: string | null | undefined;
};

const TYPE_NAMES: Record<string, string> = {
  ask: "Question",
  buttons: "Buttons",
  list: "List",
  location_request: "Ask location",
  set_field: "Update field",
  end: "End",
};

const str = (v: unknown) => (v == null ? "" : String(v)).trim();
const isInternal = (key: string) => !key || key.startsWith("_");

/** The name a merchant recognises: the step label, else the variable/field, else its text. */
export function stepName(node: FlowNode): string {
  const d = node.data;
  const text = str(d["text"]).replace(/\s+/g, " ");
  return (
    str(d["label"]) ||
    str(d["variable"]) ||
    str(d["field"]) ||
    (text.length > 40 ? `${text.slice(0, 39)}…` : text) ||
    TYPE_NAMES[node.type] ||
    node.type
  );
}

/**
 * Answer columns across every version of the flow (newest first), so runs on
 * older versions keep their answers. Internal keys (_attempts, _last_reply…)
 * and built-ins (last_answer) are never columns.
 */
export function answerColumns(graphs: FlowGraph[]): ResponseColumn[] {
  const byKey = new Map<string, ResponseColumn>();
  for (const g of graphs)
    for (const n of g.nodes ?? []) {
      let key: string | null = null;
      let kind: ResponseColumn["kind"] = "variable";
      let name = "";
      if (ANSWER_TYPES.has(n.type)) {
        name = str(n.data["variable"]);
        if (!isInternal(name)) key = `var:${name}`;
      } else if (n.type === "set_field") {
        name = str(n.data["field"]);
        kind = "field";
        if (!isInternal(name)) key = `field:${name}`;
      }
      if (!key) continue;
      const col = byKey.get(key);
      if (col) {
        if (!col.nodeIds.includes(n.id)) col.nodeIds.push(n.id);
      } else byKey.set(key, { key, label: str(n.data["label"]) || name, kind, nodeIds: [n.id] });
    }
  return [...byKey.values()];
}

/** Question steps (they wait for a reply) for the drop-off strip, newest label wins. */
export function questionSteps(graphs: FlowGraph[]): QuestionStep[] {
  const seen = new Map<string, QuestionStep>();
  for (const g of graphs)
    for (const n of g.nodes ?? []) if (ANSWER_TYPES.has(n.type) && !seen.has(n.id)) seen.set(n.id, { nodeId: n.id, label: stepName(n) });
  return [...seen.values()];
}

/** Variable names that answer columns read — the only jsonb keys text search looks in. */
export function searchableVariables(columns: ResponseColumn[]): string[] {
  return columns.filter((c) => c.kind === "variable").map((c) => c.key.slice(4)).filter((k) => /^[a-zA-Z0-9_]+$/.test(k));
}

export function answerText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export type RunRecord = {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  version_id: string;
  status: string;
  current_node_id: string | null;
  variables: Record<string, unknown> | null;
  started_at: string;
  contacts: { name: string | null; phone: string | null; attributes?: Record<string, unknown> | null } | null;
};

/**
 * One table row. `fieldSteps` holds `${run_id}:${node_id}` for each Update
 * field step the run passed — a field only shows for runs that reached it.
 */
export function buildRow(
  run: RunRecord,
  columns: ResponseColumn[],
  versions: Map<string, { version: number; graph: FlowGraph }>,
  fieldSteps: Set<string>,
): ResponseRow {
  const vars = run.variables ?? {};
  const v = versions.get(run.version_id);
  const status = responseStatus(run.status);
  const node = run.current_node_id ? v?.graph.nodes.find((n) => n.id === run.current_node_id) : undefined;
  const contact = { name: run.contacts?.name ?? null, phone: run.contacts?.phone ?? "", attributes: run.contacts?.attributes ?? {} };
  const answers: Record<string, string> = {};
  for (const c of columns) {
    if (c.kind === "variable") {
      answers[c.key] = answerText(vars[c.key.slice(4)]);
      continue;
    }
    const step = v?.graph.nodes.find((n) => n.type === "set_field" && c.nodeIds.includes(n.id) && fieldSteps.has(`${run.id}:${n.id}`));
    answers[c.key] = step
      ? interpolate(str(step.data["value"]), { vars, contact, tags: [], now: new Date(run.started_at), timezone: "Asia/Kolkata" })
      : "";
  }
  return {
    run_id: run.id,
    contact_id: run.contact_id,
    conversation_id: run.conversation_id,
    name: contact.name ?? "",
    phone: contact.phone,
    started_at: run.started_at,
    status,
    step: status === "finished" ? null : node ? stepName(node) : null,
    version: v?.version ?? null,
    answers,
  };
}

/** "2026-10-05 14:30" in the workspace time zone. */
export function formatStarted(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p["year"]}-${p["month"]}-${p["day"]} ${p["hour"]}:${p["minute"]}`;
}

export const RESPONSES_CSV_HEADERS = ["Customer name", "Phone", "Started", "Status", "Stopped at step", "Flow version"];

/** Header row plus one row per run — same columns as the table. Every cell is formula-safe. */
export function responsesCsvRows(columns: ResponseColumn[], rows: ResponseRow[], timezone: string): string[][] {
  const out: string[][] = [[...RESPONSES_CSV_HEADERS, ...columns.map((c) => c.label)]];
  for (const r of rows)
    out.push([
      r.name,
      r.phone,
      formatStarted(r.started_at, timezone),
      RESPONSE_STATUS_LABELS[r.status],
      r.step ?? "",
      r.version == null ? "" : `v${r.version}`,
      ...columns.map((c) => r.answers[c.key] ?? ""),
    ]);
  return out.map((row) => row.map(csvSafeCell));
}

export function responsesCsv(columns: ResponseColumn[], rows: ResponseRow[], timezone: string): string {
  // BOM so Excel reads names in any script as UTF-8.
  return `\uFEFF${toCsv(responsesCsvRows(columns, rows, timezone))}`;
}

export type ResponsesRange = "today" | "7d" | "30d" | "custom";

/**
 * Date range → started_at bounds (ISO, `to` exclusive) in the viewer's local
 * time. Custom takes yyyy-mm-dd dates, both days included.
 */
export function rangeBounds(range: ResponsesRange, custom: { from: string; to: string }, now = new Date()): { from: string | null; to: string | null } {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAgo = (n: number) => {
    const d = startOfDay(now);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };
  if (range === "today") return { from: daysAgo(0), to: null };
  if (range === "7d") return { from: daysAgo(6), to: null };
  if (range === "30d") return { from: daysAgo(29), to: null };
  const day = (s: string, plus = 0) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus).toISOString() : null;
  };
  return { from: day(custom.from), to: day(custom.to, 1) };
}

/** A flow's runs on the flows list: how many, and when the newest started. */
export type FlowResponseCount = { count: number; last: string | null };

/** "12 responses · last 3 hr ago", or "No responses yet". */
export function responsesLine(c: FlowResponseCount, relative: (iso: string) => string): string {
  if (!c.count) return "No responses yet";
  const n = `${c.count.toLocaleString("en-IN")} response${c.count === 1 ? "" : "s"}`;
  return c.last ? `${n} · last ${relative(c.last)}` : n;
}
