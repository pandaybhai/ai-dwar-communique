/**
 * Flows v2 graph model — shared by the engine, editor and simulator.
 * Browser-safe: no server imports.
 */
import { cardDesign, isCardKind, type CardAttachment } from "@/lib/customer-cards";

export const MAX_NODES = 200;
export const MAX_STEPS_PER_RUN = 500;
export const MAX_RUN_AGE_DAYS = 14;
export const MAX_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
export const MAX_BRANCHES = 10;
export const MAX_CONDITIONS = 10;
/** Pictures shown by one "Show products" step. */
export const MAX_PRODUCT_ITEMS = 10;
/** WhatsApp image messages and image headers: JPEG or PNG, at most 5 MB. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png"];

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
  | "end"
  | "note"
  | "cta_url"
  | "location_request"
  | "location_send"
  | "contact_card"
  | "carousel"
  | "set_variable"
  | "business_hours"
  | "internal_note"
  | "close_chat"
  | "opt"
  | "segment"
  | "goto_flow"
  | "ab_split"
  | "sheets_append"
  | "payment"
  | "http"
  | "email_team"
  | "wait_until"
  | "order_draft"
  | "show_products"
  | "send_card";

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
  meta?: {
    legacy?: boolean;
    flow_key?: string;
    /** Runs when the flow ends normally. */
    on_finish?: { tag?: string; needs_you?: string; close_chat?: boolean };
    business_hours?: BusinessHours;
  };
};

export type Condition = {
  /** "var:<name>" | "contact:<field>" | "tag" | "time_hour" | "weekday" */
  subject: string;
  op: "eq" | "neq" | "contains" | "not_contains" | "gt" | "lt" | "exists" | "not_exists" | "has" | "not_has" | "matches";
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
  /** The flow's weekly schedule (graph.meta.business_hours), for "Business hours" conditions. */
  businessHours?: BusinessHours | undefined;
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
  if (key === "today" && !(key in ctx.vars)) return fmtDate(ctx.now, ctx.timezone);
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
  if (c.subject === "business_hours") {
    // The flow's own weekly schedule (Flow settings), as the Business hours step uses.
    const open = isBusinessOpen((ctx.businessHours ?? ctx.vars["_business_hours"]) as BusinessHours | undefined, ctx.now, ctx.timezone);
    return (String(c.value ?? "open").toLowerCase() === "open") === open ? c.op !== "neq" : c.op === "neq";
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
    case "matches":
      return safeRegex(String(c.value ?? ""))?.test(subject == null ? "" : String(subject)) ?? false;
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
    case "date":
      return parseDateAnswer(text);
    default:
      return text;
  }
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** 1–12 for a month's full name or its three-letter short form ("sept" too), else 0. */
function monthNumber(name: string): number {
  const n = name.toLowerCase();
  const i = MONTHS.findIndex((m) => m === n || m.slice(0, 3) === n || (m === "september" && n === "sept"));
  return i + 1;
}

/** yyyy-mm-dd when it's a real calendar day (no 31 February), else null. */
function calendarDay(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A customer's date answer as yyyy-mm-dd. Takes dd-mm-yyyy (also / . or
 * space, two-digit years as 20yy), yyyy-mm-dd, and "25 Dec 2026" /
 * "December 25, 2026". Anything else — a bare number, a pincode, "tomorrow",
 * a day that doesn't exist, a date without a year — is null, so the step asks
 * again instead of saving a wrong date.
 */
export function parseDateAnswer(raw: string): string | null {
  const text = raw.trim();
  let m = text.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/);
  if (m) return calendarDay(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  m = text.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{4})$/i);
  if (m && monthNumber(m[2]!)) return calendarDay(Number(m[3]), monthNumber(m[2]!), Number(m[1]));
  m = text.match(/^([a-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})$/i);
  if (m && monthNumber(m[1]!)) return calendarDay(Number(m[3]), monthNumber(m[1]!), Number(m[2]));
  return null;
}

/** Output handles each node type offers. */
export function outputsOf(node: FlowNode): string[] {
  const d = node.data;
  switch (node.type) {
    case "end":
    case "note":
      return [];
    case "buttons":
      return [
        ...((d["buttons"] as Array<{ id: string }> | undefined) ?? []).map((b) => b.id),
        "window_closed",
      ];
    case "list":
      return [...((d["rows"] as Array<{ id: string }> | undefined) ?? []).map((r) => r.id), "window_closed"];
    case "ask":
    case "location_request":
      return ["next", "invalid", "timeout", "window_closed"];
    case "cta_url":
    case "location_send":
    case "contact_card":
    case "carousel":
      return ["next", "window_closed"];
    case "business_hours":
      return ["open", "closed"];
    case "sheets_append":
    case "email_team":
    case "send_card":
      return ["next", "failed"];
    case "http":
      return ["success", "failed"];
    case "show_products":
      return ["found", "none", "window_closed"];
    case "payment":
      return ["paid", "not_paid", "window_closed"];
    case "ab_split":
      return ["a", "b"];
    case "goto_flow":
    case "close_chat":
      return [];
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
  const optional = new Set(["window_closed", "invalid", "timeout", "failed"]);
  return outputsOf(node).filter((h) => !optional.has(h));
}

export type GraphProblem = { nodeId: string | null; message: string };

/** Structural checks before publish. Template approval is checked server-side. */
/**
 * The address a saved HTTP header secret is bound to: scheme, host and path of
 * the step's URL as written (query and fragment ignored, {{variables}} kept).
 */
export function secretScope(url: unknown): string {
  const m = String(url ?? "").trim().match(/^(https?:\/\/)([^/?#]*)([^?#]*)/i);
  return m ? `${m[1]!.toLowerCase()}${m[2]!.toLowerCase()}${m[3]}` : "";
}

/**
 * HTTP header values are secrets: an exported or imported flow carries header
 * names only — never values, never references to stored secrets.
 */
export function maskHttpSecrets(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type !== "http"
        ? n
        : {
            ...n,
            data: {
              ...n.data,
              headers: ((n.data["headers"] as Array<{ key?: string }> | undefined) ?? []).map((h) => ({ key: String(h?.key ?? ""), value: "" })),
            },
          },
    ),
  };
}

/** Longest tag a Tag step makes from {{variables}} (a customer's answer can be long). */
export const MAX_FILLED_TAG = 100;

/**
 * The tag a Tag step adds or removes. A name without {{ }} is returned exactly
 * as written — the step behaves as it always has. With {{variables}} they're
 * filled in from this run ("lead-{{product}}-{{budget}}" → "lead-Rings-Under
 * 25k"), spaces tidied, at most MAX_FILLED_TAG characters; "" means the
 * variables came out empty and the step is skipped.
 */
export function tagOfNode(data: Record<string, unknown>, ctx: RunContext): string {
  const raw = String(data["tag"] ?? "");
  if (!raw.includes("{{")) return raw;
  return interpolate(raw, ctx).replace(/\s+/g, " ").trim().slice(0, MAX_FILLED_TAG).trim();
}

/** Shown on a Send card step when the workspace has the cards feature switched off. */
export const CARDS_REQUIRED = "Cards are switched off for this workspace — remove this step or ask us to switch cards on.";

/** A Send card step's design and its values with this run's answers filled in. */
export function cardOfNode(data: Record<string, unknown>, ctx: RunContext): CardAttachment | null {
  if (!isCardKind(data["kind"])) return null;
  const raw = (data["vars"] as Record<string, unknown> | undefined) ?? {};
  const vars: Record<string, string> = {};
  for (const v of cardDesign(data["kind"])!.vars) vars[v.key] = interpolate(String(raw[v.key] ?? ""), ctx).trim();
  return { kind: data["kind"], vars };
}

/** Shown on a WhatsApp shop step (internal type "carousel") when the workspace has no connected WhatsApp catalogue. */
export const WHATSAPP_SHOP_REQUIRED = "Connect WhatsApp shop first";

/**
 * opts.whatsappShop: whether the workspace has a connected WhatsApp catalogue.
 * Only `false` adds a problem, and only on WhatsApp shop steps; left out (as
 * every older caller does) nothing changes.
 * opts.cards: whether the workspace has the cards feature on. Only `false`
 * adds a problem, and only on Send card steps.
 */
export function validateGraph(graph: FlowGraph, opts: { now?: Date; timezone?: string; whatsappShop?: boolean; cards?: boolean } = {}): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const nowMs = (opts.now ?? new Date()).getTime();
  if (graph.nodes.length > MAX_NODES) problems.push({ nodeId: null, message: `A flow can have at most ${MAX_NODES} steps.` });
  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) problems.push({ nodeId: null, message: "A flow needs exactly one start." });
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) problems.push({ nodeId: e.source, message: "A connection points to a step that no longer exists." });
  }
  for (const node of graph.nodes) {
    // First, so the step itself says what's missing.
    if (node.type === "carousel" && opts.whatsappShop === false) problems.push({ nodeId: node.id, message: WHATSAPP_SHOP_REQUIRED });
    if (node.type === "send_card" && opts.cards === false) problems.push({ nodeId: node.id, message: CARDS_REQUIRED });
    for (const h of requiredOutputs(node)) {
      if (!edgeFrom(graph, node.id, h))
        problems.push({ nodeId: node.id, message: h === "next" ? "Connect this step to what happens next (or an End)." : `Output “${h}” isn't connected.` });
    }
    const d = node.data;
    if (node.type === "text" && !String(d["text"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Write the message." });
    if ((node.type === "text" || node.type === "buttons") && imageProblem(d["image_url"])) problems.push({ nodeId: node.id, message: imageProblem(d["image_url"])! });
    if (node.type === "text" && String(d["image_url"] ?? "").trim() && String(d["text"] ?? "").length > 1024)
      problems.push({ nodeId: node.id, message: "With a picture, the message is its caption: keep it under 1,024 characters." });
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
  for (const node of graph.nodes) {
    const x = node.data;
    if (node.type === "cta_url") {
      if (!/^https?:\/\/\S+$/.test(String(x["url"] ?? ""))) problems.push({ nodeId: node.id, message: "Add a full link starting with https://" });
      if (!String(x["button_text"] ?? "").trim() || String(x["button_text"]).length > 20) problems.push({ nodeId: node.id, message: "Button text needs 1–20 characters." });
    }
    if (node.type === "location_send" && (!Number.isFinite(Number(x["latitude"])) || !Number.isFinite(Number(x["longitude"])) || x["latitude"] === "" || x["longitude"] === ""))
      problems.push({ nodeId: node.id, message: "Add the latitude and longitude." });
    if (node.type === "contact_card" && (!String(x["name"] ?? "").trim() || String(x["phone"] ?? "").replace(/\D/g, "").length < 10))
      problems.push({ nodeId: node.id, message: "Add a name and a phone number." });
    if (node.type === "carousel") {
      const ids = (x["retailer_ids"] as string[] | undefined) ?? [];
      if (!ids.length || ids.length > 10) problems.push({ nodeId: node.id, message: "Pick 1–10 products." });
    }
    if (node.type === "set_variable" && !String(x["variable"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Name the variable." });
    if (node.type === "set_variable" && x["mode"] === "math" && computeVariable({ mode: "math", expression: String(x["expression"] ?? "") }, { vars: {}, contact: { name: "", phone: "", attributes: {} }, tags: [], now: new Date(), timezone: "Asia/Kolkata" }, true) === null)
      problems.push({ nodeId: node.id, message: "The calculation can only use numbers, {{variables}} and + - * / ( )." });
    if (node.type === "segment" && !String(x["segment_name"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Pick a segment." });
    if (node.type === "sheets_append") {
      if (!String(x["sheet"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Paste the Google Sheet link." });
      if (!((x["columns"] as string[] | undefined) ?? []).some((c) => String(c).trim())) problems.push({ nodeId: node.id, message: "Add at least one column value." });
    }
    if (node.type === "payment") {
      const amt = String(x["amount"] ?? "").trim();
      if (!amt || (!/\{\{/.test(amt) && !(Number(amt) >= 1))) problems.push({ nodeId: node.id, message: "Set an amount of at least ₹1 (or a {{variable}})." });
      const h = Number(x["wait_hours"] ?? 24);
      if (!(h >= 1 && h <= 312)) problems.push({ nodeId: node.id, message: "Wait between 1 and 312 hours for payment." });
    }
    if (node.type === "goto_flow" && !String(x["flow_id"] ?? "")) problems.push({ nodeId: node.id, message: "Pick the flow to go to." });
    if (node.type === "http") {
      const url = String(x["url"] ?? "").trim();
      if (!/^https?:\/\/\S+$/.test(url)) problems.push({ nodeId: node.id, message: "Add the full address starting with https://" });
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(x["method"] ?? "GET"))) problems.push({ nodeId: node.id, message: "Pick GET, POST, PUT, PATCH or DELETE." });
      const bodyText = String(x["body"] ?? "").trim();
      if (bodyText && !isJsonTemplate(bodyText)) problems.push({ nodeId: node.id, message: "The body must be valid JSON ({{variables}} are allowed inside quotes)." });
      for (const m of (x["save"] as Array<{ path?: string; variable?: string }> | undefined) ?? [])
        if (!String(m.path ?? "").trim() || !/^[a-zA-Z0-9_]+$/.test(String(m.variable ?? ""))) problems.push({ nodeId: node.id, message: "Each saved field needs a response path and a variable name (letters, numbers, _)." });
    }
    if (node.type === "email_team") {
      const users = (x["user_ids"] as string[] | undefined) ?? [];
      const addrs = String(x["addresses"] ?? "").split(/[,\s]+/).filter(Boolean);
      if (!users.length && !addrs.length) problems.push({ nodeId: node.id, message: "Pick teammates or add email addresses." });
      if (users.length + addrs.length > 5) problems.push({ nodeId: node.id, message: "Email at most 5 people from one step." });
      if (addrs.some((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))) problems.push({ nodeId: node.id, message: "One of the email addresses isn't valid." });
      if (!String(x["subject"] ?? "").trim()) problems.push({ nodeId: node.id, message: "Add a subject." });
    }
    if (node.type === "show_products") {
      const items = Number(x["max_items"] ?? 5);
      if (!(Number.isInteger(items) && items >= 1 && items <= MAX_PRODUCT_ITEMS)) problems.push({ nodeId: node.id, message: `Show 1–${MAX_PRODUCT_ITEMS} products.` });
      const budget = String(x["budget"] ?? "").trim();
      if (budget && !budget.includes("{{") && !parseBudget(budget)) problems.push({ nodeId: node.id, message: `"${budget}" isn't a budget we can read — try "Under 25k", "25-50k" or "1L+".` });
      const lo = String(x["min_price"] ?? "").trim();
      const hi = String(x["max_price"] ?? "").trim();
      for (const v of [lo, hi]) if (v && !v.includes("{{") && !(Number(v.replace(/[,₹\s]/g, "")) >= 0)) problems.push({ nodeId: node.id, message: "Prices must be numbers (or a {{variable}})." });
      if (lo && hi && !lo.includes("{{") && !hi.includes("{{") && Number(lo.replace(/[,₹\s]/g, "")) > Number(hi.replace(/[,₹\s]/g, "")))
        problems.push({ nodeId: node.id, message: "The lowest price is above the highest." });
    }
    if (node.type === "send_card") {
      if (!isCardKind(x["kind"])) problems.push({ nodeId: node.id, message: "Pick a card design." });
      else {
        const vars = (x["vars"] as Record<string, unknown> | undefined) ?? {};
        const filled = cardDesign(x["kind"])!.vars.filter((v) => v.key !== "image_url" && String(vars[v.key] ?? "").trim());
        if (!filled.length) problems.push({ nodeId: node.id, message: "Fill in at least one detail on the card." });
        const photo = String(vars["image_url"] ?? "").trim();
        if (photo && !photo.includes("{{") && !/^https:\/\/\S+$/i.test(photo)) problems.push({ nodeId: node.id, message: "The picture needs a full link starting with https://" });
      }
      if (String(x["caption"] ?? "").length > 1024) problems.push({ nodeId: node.id, message: "Keep the words under the card under 1,024 characters." });
    }
    if (node.type === "wait_until") {
      if (x["mode"] === "field" ? !String(x["field"] ?? "").trim() : !String(x["date"] ?? "").trim())
        problems.push({ nodeId: node.id, message: x["mode"] === "field" ? "Pick the variable or contact field holding the date." : "Pick the date to wait until." });
      // A fixed date the run can never reach: runs end after MAX_RUN_AGE_DAYS.
      const raw = String(x["date"] ?? "").trim();
      if (x["mode"] !== "field" && raw && !raw.includes("{{")) {
        const target = parseWaitDate(raw, opts.timezone ?? "Asia/Kolkata");
        if (target && target.getTime() - nowMs > MAX_RUN_AGE_DAYS * 86_400_000)
          problems.push({
            nodeId: node.id,
            message: `This date is more than ${MAX_RUN_AGE_DAYS} days away. A flow run stops after ${MAX_RUN_AGE_DAYS} days, so it would end before this date. Pick a date within ${MAX_RUN_AGE_DAYS} days.`,
          });
      }
    }
    if (node.type === "branch")
      for (const b of (x["branches"] as Branch[] | undefined) ?? [])
        for (const c of b.conditions) if (c.op === "matches" && !safeRegex(String(c.value ?? ""))) problems.push({ nodeId: node.id, message: `"${c.value}" isn't a valid pattern.` });
  }
  // Variables used must be set somewhere (ask nodes or built-ins).
  const defined = new Set(["name", "phone", "last_answer", "today", "now", "payment_link", "payment_status", "payment_id", "order_draft_id", "http_status"]);
  for (const n of graph.nodes) if (["ask", "buttons", "list", "location_request", "set_variable"].includes(n.type) && d(n, "variable")) defined.add(d(n, "variable"));
  for (const n of graph.nodes)
    if (n.type === "http") for (const m of (n.data["save"] as Array<{ variable?: string }> | undefined) ?? []) if (m.variable) defined.add(String(m.variable));
  for (const n of graph.nodes) {
    const text = JSON.stringify(n.data);
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      if (!defined.has(m[1]!)) problems.push({ nodeId: n.id, message: `Variable {{${m[1]}}} is never set.` });
    }
  }
  return problems;
}

/**
 * A picture on a Message or Buttons step: a full https link to a JPEG or PNG
 * (WhatsApp's image formats). A link without a file ending is allowed — the
 * upload and Meta check the file itself. null when fine or empty.
 */
export function imageProblem(url: unknown): string | null {
  const u = String(url ?? "").trim();
  if (!u) return null;
  if (!/^https:\/\/[^\s]+$/i.test(u)) return "The picture needs a full link starting with https://";
  const ext = u.split(/[?#]/)[0]!.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (ext && !["jpg", "jpeg", "png"].includes(ext)) return "WhatsApp pictures must be JPG or PNG.";
  return null;
}

/**
 * A budget a customer picked, as a price range: "Under 25k" → up to 25,000,
 * "25-50k" → 25,000–50,000, "50k-1L" → 50,000–1,00,000, "1L+" → from
 * 1,00,000. Understands k, L/lakh, cr, ₹ and Rs. null when there's no amount.
 */
export function parseBudget(text: unknown): { min: number | null; max: number | null } | null {
  const t = String(text ?? "").toLowerCase().replace(/(\d),(?=\d)/g, "$1").replace(/₹|\brs\.?|\binr\b/g, " ");
  const units: Record<string, number> = { k: 1e3, thousand: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };
  const found = Array.from(t.matchAll(/(\d+(?:\.\d+)?)\s*(k|thousand|lakhs|lakh|lacs|lac|l|crores|crore|cr)?(?![a-z])/g)).map((m) => ({ n: Number(m[1]), unit: m[2] ?? "" }));
  if (!found.length) return null;
  // "25-50k": the first amount takes the unit written after the second.
  for (let i = found.length - 2; i >= 0; i--) if (!found[i]!.unit && found[i + 1]!.unit) found[i]!.unit = found[i + 1]!.unit;
  const values = found.map((f) => Math.round(f.n * (units[f.unit] ?? 1)));
  if (values.length >= 2) return { min: Math.min(values[0]!, values[1]!), max: Math.max(values[0]!, values[1]!) };
  const v = values[0]!;
  if (/\+|above|over|more than|plus|onwards|and up|min(?:imum)?\b|from|starting/.test(t)) return { min: v, max: null };
  return { min: null, max: v };
}

/**
 * What a "Show products" step searches for, with this run's answers filled
 * in: the shelf, and a price range from the budget (fixed or a {{variable}}),
 * where an explicit lowest/highest price wins.
 */
export function productQueryOf(data: Record<string, unknown>, ctx: RunContext): { category: string; minPrice: number | null; maxPrice: number | null; limit: number } {
  const range = parseBudget(interpolate(String(data["budget"] ?? ""), ctx));
  const price = (key: string): number | null => {
    const raw = interpolate(String(data[key] ?? ""), ctx).replace(/[,₹\s]/g, "");
    return raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  const limit = Math.min(Math.max(Math.round(Number(data["max_items"] ?? 5)) || 5, 1), MAX_PRODUCT_ITEMS);
  return {
    category: interpolate(String(data["category"] ?? ""), ctx).trim(),
    minPrice: price("min_price") ?? range?.min ?? null,
    maxPrice: price("max_price") ?? range?.max ?? null,
    limit,
  };
}

function d(n: FlowNode, key: string): string {
  return String(n.data[key] ?? "").trim();
}


/** Regex from user input; null when invalid or too long. Case-insensitive. */
export function safeRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export type BusinessHours = {
  /** 0=Sun..6=Sat → ["09:00","18:00"] or null for closed. */
  days: Record<string, [string, string] | null>;
  holidays: string[];
};

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  days: { "0": null, "1": ["09:00", "18:00"], "2": ["09:00", "18:00"], "3": ["09:00", "18:00"], "4": ["09:00", "18:00"], "5": ["09:00", "18:00"], "6": ["10:00", "14:00"] },
  holidays: [],
};

/** The workspace's timezone when it's one Intl knows, else Asia/Kolkata (never a crash mid-flow). */
export function safeTimezone(timezone: string | null | undefined): string {
  const tz = String(timezone ?? "").trim();
  if (!tz) return "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Kolkata";
  }
}

/** Open or closed right now, by the weekly schedule and holidays, in the workspace's timezone. */
export function isBusinessOpen(bh: BusinessHours | undefined, now: Date, timezone: string): boolean {
  const h = bh ?? DEFAULT_BUSINESS_HOURS;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: safeTimezone(timezone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  if (h.holidays.includes(date)) return false;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const slot = h.days[String(wd)];
  if (!slot) return false;
  const hm = `${get("hour")}:${get("minute")}`;
  return hm >= slot[0] && hm < slot[1];
}

function fmtDate(d: Date, timezone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")}`;
}

/**
 * Set variable / calculate.
 * - value: text with {{variables}}
 * - math: + - * / ( ) over numbers and {{variables}}
 * - join: text join (same as value)
 * - date: "today" | "now" | "today+N" | "{{var}}+N" (days) → dd-mm-yyyy
 */
export function computeVariable(
  spec: { mode?: string; expression?: string },
  ctx: RunContext,
  dryRun = false,
): string | null {
  const expr = String(spec.expression ?? "");
  const mode = spec.mode ?? "value";
  if (mode === "math") {
    const replaced = expr.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k: string) => {
      if (dryRun) return "1";
      const n = Number(String(lookup(k, ctx) ?? "").replace(/[,\s₹]/g, ""));
      return Number.isFinite(n) ? String(n) : "0";
    });
    if (!/^[\d\s.+\-*/()]+$/.test(replaced) || !replaced.trim()) return null;
    const v = evalArith(replaced);
    return v == null || !Number.isFinite(v) ? null : String(Math.round(v * 100) / 100);
  }
  if (mode === "date") {
    const m = expr.trim().match(/^(.*?)(?:\s*([+-])\s*(\d+))?$/);
    const baseRaw = (m?.[1] ?? "today").trim() || "today";
    let base: Date;
    if (baseRaw === "today" || baseRaw === "now") base = ctx.now;
    else {
      const v = interpolate(baseRaw, ctx).trim();
      const dm = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      base = dm ? new Date(`${dm[3]}-${dm[2]!.padStart(2, "0")}-${dm[1]!.padStart(2, "0")}T06:00:00Z`) : new Date(v);
      if (Number.isNaN(base.getTime())) return null;
    }
    const days = m?.[3] ? Number(m[3]) * (m[2] === "-" ? -1 : 1) : 0;
    const out = new Date(base.getTime() + days * 86_400_000);
    if (baseRaw === "now" && !days) {
      const t = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timezone || "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(out);
      return `${fmtDate(out, ctx.timezone)} ${t}`;
    }
    return fmtDate(out, ctx.timezone);
  }
  return interpolate(expr, ctx);
}

/** Tiny + - * / ( ) evaluator — no eval (not allowed on the server runtime). */
export function evalArith(src: string): number | null {
  const tokens = src.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const factor = (): number | null => {
    const t = tokens[i++];
    if (t === "-") { const f = factor(); return f == null ? null : -f; }
    if (t === "(") { const v = expr(); if (tokens[i++] !== ")") return null; return v; }
    if (t != null && /^\d/.test(t)) return Number(t);
    return null;
  };
  const term = (): number | null => {
    let v = factor();
    while (v != null && (peek() === "*" || peek() === "/")) {
      const op = tokens[i++];
      const r = factor();
      if (r == null) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number | null => {
    let v = term();
    while (v != null && (peek() === "+" || peek() === "-")) {
      const op = tokens[i++];
      const r = term();
      if (r == null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const out = expr();
  return i === tokens.length ? out : null;
}


/** JSON body template: valid once every {{variable}} is replaced by a sample. */
export function isJsonTemplate(text: string): boolean {
  try {
    JSON.parse(text.replace(/\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/g, "x"));
    return true;
  } catch {
    return false;
  }
}

/** Read a value from a JSON response by a dotted path: "data.items.0.id". */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".").map((p) => p.trim()).filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * "Wait until": a date written as dd-mm-yyyy or yyyy-mm-dd, optionally with
 * HH:MM (default 10:00), in the workspace's timezone. null when unreadable.
 */
export function parseWaitDate(raw: string, timezone: string): Date | null {
  const t = raw.trim();
  let m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  let y: number, mo: number, da: number, h = 10, mi = 0;
  if (m) { da = +m[1]!; mo = +m[2]!; y = +m[3]!; if (m[4]) { h = +m[4]; mi = +m[5]!; } }
  else {
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    y = +m[1]!; mo = +m[2]!; da = +m[3]!; if (m[4]) { h = +m[4]; mi = +m[5]!; }
  }
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  // Offset of the timezone at that moment.
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
  const asTz = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (asTz - guess));
}
