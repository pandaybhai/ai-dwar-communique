/**
 * Flows v2 graph model — shared by the engine, editor and simulator.
 * Browser-safe: no server imports.
 */

export const MAX_NODES = 200;
export const MAX_STEPS_PER_RUN = 500;
export const MAX_RUN_AGE_DAYS = 14;
export const MAX_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
export const MAX_BRANCHES = 10;
export const MAX_CONDITIONS = 10;

export type NodeType =
  | "start"
  | "text"
  | "buttons"
  | "list"
  | "template"
  | "form"
  | "ask"
  | "wait"
  | "branch"
  | "tag"
  | "set_field"
  | "assign"
  | "needs_you"
  | "end";

export type FlowNode = {
  id: string;
  type: NodeType;
  position?: { x: number; y: number };
  data: Record<string, unknown>;
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  /** Which output of the source: "next", a button id, "timeout", "invalid", "window_closed", "else", a branch id. */
  sourceHandle?: string | null;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  meta?: { legacy?: boolean; flow_key?: string };
};

export type Condition = {
  /** "var:<name>" | "contact:<field>" | "tag" | "time_hour" | "weekday" */
  subject: string;
  op: "eq" | "neq" | "contains" | "not_contains" | "gt" | "lt" | "exists" | "not_exists" | "has" | "not_has";
  value?: string;
};

export type Branch = { id: string; label?: string; match: "all" | "any"; conditions: Condition[] };

export type ValidationKind = "text" | "number" | "email" | "phone" | "pincode" | "date";

export type RunContext = {
  vars: Record<string, unknown>;
  contact: { name: string | null; phone: string; attributes: Record<string, unknown> };
  tags: string[];
  now: Date;
  timezone: string;
};

export function edgeFrom(graph: FlowGraph, nodeId: string, handle: string = "next"): FlowEdge | null {
  return (
    graph.edges.find((e) => e.source === nodeId && (e.sourceHandle ?? "next") === handle) ?? null
  );
}

export function startNode(graph: FlowGraph): FlowNode | null {
  return graph.nodes.find((n) => n.type === "start") ?? null;
}

/** {{name}}, {{last_answer}}, {{contact.email}} → values. Unknown → empty. */
export function interpolate(text: string, ctx: RunContext): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const v = lookup(key, ctx);
    return v == null ? "" : String(v);
  });
}

export function lookup(key: string, ctx: RunContext): unknown {
  if (key === "name" || key === "contact.name") return ctx.contact.name ?? "";
  if (key === "phone" || key === "contact.phone") return ctx.contact.phone;
  if (key.startsWith("contact.")) return ctx.contact.attributes[key.slice(8)];
  return ctx.vars[key];
}

function zonedParts(now: Date, timezone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "Asia/Kolkata",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return { hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

export function evalCondition(c: Condition, ctx: RunContext): boolean {
  let subject: unknown;
  if (c.subject === "tag") {
    const has = ctx.tags.map((t) => t.toLowerCase()).includes(String(c.value ?? "").toLowerCase());
    return c.op === "not_has" || c.op === "neq" ? !has : has;
  }
  if (c.subject === "time_hour") subject = zonedParts(ctx.now, ctx.timezone).hour;
  else if (c.subject === "weekday") subject = zonedParts(ctx.now, ctx.timezone).weekday;
  else if (c.subject.startsWith("var:")) subject = ctx.vars[c.subject.slice(4)];
  else if (c.subject.startsWith("contact:")) subject = lookup(`contact.${c.subject.slice(8)}`, ctx);
  else subject = lookup(c.subject, ctx);

  const s = subject == null ? "" : String(subject).trim().toLowerCase();
  const v = String(c.value ?? "").trim().toLowerCase();
  switch (c.op) {
    case "eq":
      return s === v;
    case "neq":
      return s !== v;
    case "contains":
      return s.includes(v);
    case "not_contains":
      return !s.includes(v);
    case "gt":
      return Number(s) > Number(v);
    case "lt":
      return Number(s) < Number(v);
    case "exists":
      return s !== "";
    case "not_exists":
      return s === "";
    default:
      return false;
  }
}

/** First matching branch id, or "else". */
export function pickBranch(branches: Branch[], ctx: RunContext): string {
  for (const b of branches.slice(0, MAX_BRANCHES)) {
    const conds = b.conditions.slice(0, MAX_CONDITIONS);
    if (!conds.length) continue;
    const ok = b.match === "any" ? conds.some((c) => evalCondition(c, ctx)) : conds.every((c) => evalCondition(c, ctx));
    if (ok) return b.id;
  }
  return "else";
}

/** Returns a normalized value, or null when the answer doesn't fit. */
export function validateAnswer(kind: ValidationKind | undefined, raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  switch (kind ?? "text") {
    case "number": {
      const n = text.replace(/[,\s₹]/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) ? text.toLowerCase() : null;
    case "phone": {
      const d = text.replace(/\D/g, "");
      return d.length >= 10 && d.length <= 13 ? d : null;
    }
    case "pincode": {
      const d = text.replace(/\s/g, "");
      return /^[1-9]\d{5}$/.test(d) ? d : null;
    }
    case "date": {
      const m = text.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})$/);
      if (m) {
        const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
        const d = new Date(`${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}T00:00:00Z`);
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      }
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    default:
      return text;
  }
}

/** Output handles each node type offers. */
export function outputsOf(node: FlowNode): string[] {
  const d = node.data;
  switch (node.type) {
    case "end":
      return [];
    case "buttons":
      return [
        ...((d["buttons"] as Array<{ id: string }> | undefined) ?? []).map((b) => b.id),
        "window_closed",
      ];
    case "list":
      return [...((d["rows"] as Array<{ id: string }> | undefined) ?? []).map((r) => r.id), "window_closed"];
    case "ask":
      return ["next", "invalid", "timeout", "window_closed"];
    case "text":
    case "form":
      return ["next", "window_closed"];
    case "branch":
      return [...((d["branches"] as Branch[] | undefined) ?? []).map((b) => b.id), "else"];
    default:
      return ["next"];
  }
}

/** Handles that must be connected for a node to be publishable. */
function requiredOutputs(node: FlowNode): string[] {
  const optional = new Set(["window_closed", "invalid", "timeout"]);
  return outputsOf(node).filter((h) => !optional.has(h));
}

export type GraphProblem = { nodeId: string | null; message: string };

/** Structural checks before publish. Template approval is checked server-side. */
export function validateGraph(graph: FlowGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  if (graph.nodes.length > MAX_NODES) problems.push({ nodeId: null, message: `A flow can have at most ${MAX_NODES} steps.` });
  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) problems.push({ nodeId: null, message: "A flow needs exactly one start." });
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) problems.push({ nodeId: e.source, message: "A connection points to a step that no longer exists." });
  }
  for (const node of graph.nodes) {
    for (const h of requiredOutputs(node)) {
      if (!edgeFrom(graph, node.id, h))
        problems.push({ nodeId: node.id, message: h === "next" ? "Connect this step to what happens next (or an End)." : `Output “${h}” isn't connected.` });
    }
    const d = node.data;
    if (node.type === "text" && !String(d["text"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Write the message." });
    if (node.type === "buttons") {
      const b = (d["buttons"] as Array<{ title?: string }> | undefined) ?? [];
      if (!b.length || b.length > MAX_BUTTONS) problems.push({ nodeId: node.id, message: `Use 1–${MAX_BUTTONS} buttons.` });
      if (b.some((x) => !String(x.title ?? "").trim() || String(x.title).length > 20)) problems.push({ nodeId: node.id, message: "Button labels need 1–20 characters." });
      if (!String(d["text"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Write the message above the buttons." });
    }
    if (node.type === "list") {
      const r = (d["rows"] as Array<{ title?: string }> | undefined) ?? [];
      if (!r.length || r.length > MAX_LIST_ROWS) problems.push({ nodeId: node.id, message: `Use 1–${MAX_LIST_ROWS} rows.` });
      if (r.some((x) => !String(x.title ?? "").trim() || String(x.title).length > 24)) problems.push({ nodeId: node.id, message: "Row titles need 1–24 characters." });
    }
    if (node.type === "ask" && !String(d["variable"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Name the variable the answer is saved to." });
    if (node.type === "template" && !d["template_id"]) problems.push({ nodeId: node.id, message: "Pick a template." });
    if (node.type === "form" && !d["form_id"]) problems.push({ nodeId: node.id, message: "Pick a form." });
    if (node.type === "branch") {
      const br = (d["branches"] as Branch[] | undefined) ?? [];
      if (br.length > MAX_BRANCHES) problems.push({ nodeId: node.id, message: `At most ${MAX_BRANCHES} branches.` });
      if (br.some((b) => b.conditions.length > MAX_CONDITIONS)) problems.push({ nodeId: node.id, message: `At most ${MAX_CONDITIONS} conditions per branch.` });
    }
    if ((node.type === "tag") && !String(d["tag"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Pick a tag." });
  }
  // Variables used must be set somewhere (ask nodes or built-ins).
  const defined = new Set(["name", "phone", "last_answer"]);
  for (const n of graph.nodes) if (n.type === "ask" && d(n, "variable")) defined.add(d(n, "variable"));
  for (const n of graph.nodes) {
    const text = JSON.stringify(n.data);
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      if (!defined.has(m[1]!)) problems.push({ nodeId: n.id, message: `Variable {{${m[1]}}} is never set.` });
    }
  }
  return problems;
}

function d(n: FlowNode, key: string): string {
  return String(n.data[key] ?? "").trim();
}
