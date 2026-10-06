/**
 * One customer answer as the Aiden control centre shows it: the question, the
 * reply, and what each tool was asked and found. Browser-safe — the admin
 * route shapes runs with it and the panel renders the same shape.
 *
 * The tool list is the run's own metadata.tools (Batch 14.1), else — for runs
 * written before it — the ai_tool_calls trace rows. Both come from the same
 * record (invokeTool's arguments + result summary); nothing is logged twice.
 */

export type ToolTraceEntry = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Rows the tool returned (closest matches count when nothing matched exactly). */
  rows: number | null;
  /** Up to five product / record names it returned. */
  found: string[];
  /** It ran fine and matched nothing exactly. */
  nothing_found?: boolean;
  error?: string;
};

export type AiRunView = {
  id: string;
  created_at: string;
  question: string;
  reply: string;
  status: string;
  escalation: string | null;
  model: string | null;
  conversation_id: string | null;
  tools: ToolTraceEntry[];
};

type Row = Record<string, unknown>;

const record = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];

/** One ai_tool_calls row → the same entry metadata.tools carries. */
export function traceEntry(row: Row): ToolTraceEntry {
  const summary = record(row["result_summary"]);
  return {
    tool: String(row["tool_name"] ?? ""),
    args: record(row["arguments"]),
    ok: row["ok"] === true,
    rows: typeof summary["row_count"] === "number" ? summary["row_count"] : null,
    found: names(summary["identifiers"]),
    ...(summary["found"] === false ? { nothing_found: true } : {}),
    ...(typeof row["error"] === "string" && row["error"] ? { error: row["error"] } : {}),
  };
}

/** An ai_runs row (and its trace rows, for runs older than metadata.tools) → the view. */
export function runView(run: Row, traceRows: Row[] = []): AiRunView {
  const meta = record(run["metadata"]);
  const fromMeta = Array.isArray(meta["tools"])
    ? (meta["tools"] as unknown[]).map((t) => {
        const e = record(t);
        return {
          tool: String(e["tool"] ?? ""),
          args: record(e["args"]),
          ok: e["ok"] === true,
          rows: typeof e["rows"] === "number" ? e["rows"] : null,
          found: names(e["found"]),
          ...(e["nothing_found"] === true ? { nothing_found: true } : {}),
          ...(typeof e["error"] === "string" && e["error"] ? { error: e["error"] } : {}),
        } satisfies ToolTraceEntry;
      })
    : null;
  return {
    id: String(run["id"] ?? ""),
    created_at: String(run["created_at"] ?? ""),
    question: String(run["input_summary"] ?? ""),
    reply: String(run["output"] ?? ""),
    status: String(run["status"] ?? ""),
    escalation: typeof run["escalation_signal"] === "string" ? run["escalation_signal"] : null,
    model: typeof run["model"] === "string" ? run["model"] : null,
    conversation_id: typeof run["conversation_id"] === "string" ? run["conversation_id"] : null,
    tools: fromMeta ?? traceRows.map(traceEntry),
  };
}

/** "category: earrings · gender: female" — the arguments that were actually set. */
export function argsLine(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(
      ([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    )
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}
