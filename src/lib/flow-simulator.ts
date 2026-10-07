/**
 * Editor simulator: walks a draft graph like the engine does, but locally.
 * Nothing is sent, nothing is saved, nothing is billed.
 */
import {
  MAX_STEPS_PER_RUN,
  edgeFrom,
  interpolate,
  computeVariable,
  isBusinessOpen,
  pickBranch,
  safeTimezone,
  productQueryOf,
  cardOfNode,
  startNode,
  tagOfNode,
  validateAnswer,
  type Branch,
  type FlowGraph,
  type FlowNode,
  type RunContext,
  type ValidationKind,
} from "@/lib/flow-graph";
import type { CardAttachment } from "@/lib/customer-cards";

export type SimMessage =
  | { from: "bot"; kind: "text"; text: string; options?: string[] | undefined; image?: string | undefined; card?: CardAttachment | undefined }
  | { from: "bot"; kind: "note"; text: string }
  | { from: "customer"; kind: "text"; text: string };

export type SimState = {
  nodeId: string | null;
  waiting: boolean;
  done: boolean;
  ctx: RunContext;
  path: string[];
  attempts: Record<string, number>;
  messages: SimMessage[];
};

/**
 * opts.timezone: the workspace's timezone, so Business hours answers Open or
 * Closed as the live flow would (left out: Asia/Kolkata, as before).
 */
export function simStart(graph: FlowGraph, contactName = "Test customer", opts: { timezone?: string | null } = {}): SimState {
  const s: SimState = {
    nodeId: startNode(graph)?.id ?? null,
    waiting: false,
    done: false,
    ctx: { vars: {}, contact: { name: contactName, phone: "919999999999", attributes: {} }, tags: [], now: new Date(), timezone: safeTimezone(opts.timezone) },
    path: [],
    attempts: {},
    messages: [],
  };
  if (!s.nodeId) {
    s.done = true;
    s.messages.push({ from: "bot", kind: "note", text: "Add a Start step first." });
    return s;
  }
  return run(graph, s, null);
}

export function simReply(graph: FlowGraph, state: SimState, text: string): SimState {
  const s: SimState = { ...state, messages: [...state.messages, { from: "customer", kind: "text", text }], path: [...state.path], ctx: { ...state.ctx, vars: { ...state.ctx.vars }, tags: [...state.ctx.tags] }, attempts: { ...state.attempts } };
  if (!s.waiting || s.done) return s;
  return run(graph, s, text);
}

export function simTimeout(graph: FlowGraph, state: SimState): SimState {
  const s: SimState = { ...state, messages: [...state.messages, { from: "bot", kind: "note", text: "…no reply (timeout)" }], path: [...state.path] };
  if (!s.waiting) return s;
  const node = graph.nodes.find((n) => n.id === s.nodeId);
  if (!node) return s;
  s.waiting = false;
  return go(graph, s, node, "timeout") ? run(graph, s, null) : s;
}

function note(s: SimState, text: string) {
  s.messages.push({ from: "bot", kind: "note", text });
}

function go(graph: FlowGraph, s: SimState, node: FlowNode, handle: string): boolean {
  const e = edgeFrom(graph, node.id, handle);
  if (!e) {
    s.done = true;
    note(s, handle === "next" ? "Flow ended." : `Flow ended — "${handle}" isn't connected.`);
    return false;
  }
  s.nodeId = e.target;
  return true;
}

/** The picture on a Message or Buttons step, when it has one. */
function imageOf(node: FlowNode): string | undefined {
  if (node.type !== "text" && node.type !== "buttons") return undefined;
  const url = String(node.data["image_url"] ?? "").trim();
  return url || undefined;
}

function optionsOf(node: FlowNode): Array<{ id: string; title: string }> {
  return ((node.type === "buttons" ? node.data["buttons"] : node.data["rows"]) as Array<{ id: string; title: string }> | undefined) ?? [];
}

function run(graph: FlowGraph, s: SimState, reply: string | null): SimState {
  let pending = reply;
  for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
    const node = graph.nodes.find((n) => n.id === s.nodeId);
    if (!node) {
      s.done = true;
      note(s, "Flow stopped: a step is missing.");
      return s;
    }
    const d = node.data;
    const ctx = s.ctx;
    if (!s.waiting) s.path.push(node.id);

    if (node.type === "buttons" || node.type === "list" || node.type === "ask" || node.type === "location_request") {
      if (!s.waiting) {
        s.attempts[node.id] = (s.attempts[node.id] ?? 0) + 1;
        s.messages.push({ from: "bot", kind: "text", text: interpolate(String(d["text"] ?? ""), ctx) + (node.type === "location_request" ? "\n[📍 Send location]" : ""), options: node.type === "ask" || node.type === "location_request" ? undefined : optionsOf(node).map((o) => o.title), image: imageOf(node) });
        if (Number(d["nudge_minutes"] ?? 0) > 0 && String(d["nudge_text"] ?? "").trim()) note(s, `If quiet for ${d["nudge_minutes"]} min: "${String(d["nudge_text"])}"`);
        s.waiting = true;
        return s;
      }
      if (pending == null) return s;
      const typed = pending.trim();
      pending = null;
      let value: string | null = null;
      let handle = "next";
      if (node.type === "location_request") value = typed || null;
      else if (node.type === "ask") value = validateAnswer(d["validation"] as ValidationKind | undefined, typed);
      else {
        const opts = optionsOf(node);
        const hit = opts.find((o) => o.title.trim().toLowerCase() === typed.toLowerCase()) ?? (/^\d+$/.test(typed) ? opts[Number(typed) - 1] : undefined);
        if (hit) {
          value = hit.title;
          handle = hit.id;
        }
      }
      s.waiting = false;
      if (value != null) {
        ctx.vars["last_answer"] = value;
        const v = String(d["variable"] ?? "").trim();
        if (v) ctx.vars[v] = value;
        if (!go(graph, s, node, handle)) return s;
        continue;
      }
      const mode = String(d["on_unexpected"] ?? "repeat");
      if (mode === "team") {
        note(s, "Handed to your team.");
        s.done = true;
        return s;
      }
      if (mode === "path" || (s.attempts[node.id] ?? 0) > Number(d["retries"] ?? 2)) {
        if (!go(graph, s, node, "invalid")) return s;
        continue;
      }
      s.attempts[node.id] = (s.attempts[node.id] ?? 0) + 1;
      const retry = String(d["retry_text"] ?? "").trim();
      s.messages.push({ from: "bot", kind: "text", text: interpolate(retry || String(d["text"] ?? ""), ctx), options: node.type === "ask" ? undefined : optionsOf(node).map((o) => o.title) });
      s.waiting = true;
      return s;
    }

    switch (node.type) {
      case "start":
        break;
      case "end":
        s.done = true;
        note(s, "Flow ended.");
        return s;
      case "text":
        s.messages.push({ from: "bot", kind: "text", text: interpolate(String(d["text"] ?? ""), ctx), image: imageOf(node) });
        break;
      case "show_products": {
        const q = productQueryOf(d, ctx);
        const money = (n: number) => `₹${new Intl.NumberFormat("en-IN").format(n)}`;
        const range = q.minPrice !== null && q.maxPrice !== null ? ` ${money(q.minPrice)}–${money(q.maxPrice)}` : q.maxPrice !== null ? ` under ${money(q.maxPrice)}` : q.minPrice !== null ? ` from ${money(q.minPrice)}` : "";
        const extra = [
          q.keyword ? `with "${q.keyword}" in the name or description` : "",
          q.sort === "spread" ? "spread across the budget" : q.sort === "newest" ? "newest first" : "",
          q.photosFirst ? "products with a photo first" : "",
        ].filter(Boolean).join(", ");
        note(s, `Shows up to ${q.limit} ${q.category || "products"}${range}${extra ? ` (${extra})` : ""} from your catalogue, each with its picture, price and link (searched live — test chat assumes some match).`);
        if (!go(graph, s, node, "found")) return s;
        continue;
      }
      case "send_card": {
        const card = cardOfNode(d, ctx);
        if (!card) {
          note(s, "Send card: pick a design first.");
          if (!go(graph, s, node, edgeFrom(graph, node.id, "failed") ? "failed" : "next")) return s;
          continue;
        }
        s.messages.push({ from: "bot", kind: "text", text: interpolate(String(d["caption"] ?? ""), ctx), card });
        const fallback = interpolate(String(d["fallback_text"] ?? ""), ctx).trim();
        note(s, `The card is drawn with your logo and colours when it's sent${fallback ? `; if it can't be drawn, this goes instead: "${fallback}"` : " (test chat assumes it can be drawn)"}.`);
        break;
      }
      case "template":
        note(s, `Sends template "${String(d["template_name"] ?? "template")}"`);
        break;
      case "form":
        note(s, `Sends form "${String(d["form_name"] ?? "form")}"`);
        break;
      case "wait":
        note(s, `Waits ${Number(d["minutes"] ?? 0)} min (skipped in test)`);
        break;
      case "branch": {
        const h = pickBranch((d["branches"] as Branch[] | undefined) ?? [], { ...ctx, businessHours: graph.meta?.business_hours });
        const br = ((d["branches"] as Branch[] | undefined) ?? []).find((b) => b.id === h);
        note(s, `Branch → ${br?.label || (h === "else" ? "Else" : h)}`);
        if (!go(graph, s, node, h)) return s;
        continue;
      }
      case "tag": {
        const t = tagOfNode(d, ctx).trim();
        if (String(d["tag"] ?? "").includes("{{") && !t) {
          note(s, "Skips the tag — its {{variables}} came out empty.");
          break;
        }
        if (d["action"] === "remove") ctx.tags = ctx.tags.filter((x) => x.toLowerCase() !== t.toLowerCase());
        else if (t && !ctx.tags.includes(t)) ctx.tags.push(t);
        note(s, `${d["action"] === "remove" ? "Removes" : "Adds"} tag "${t}"`);
        break;
      }
      case "set_field": {
        const f = String(d["field"] ?? "");
        const v = interpolate(String(d["value"] ?? ""), ctx);
        if (f === "name") ctx.contact.name = v;
        else if (f) ctx.contact.attributes[f] = v;
        note(s, `Sets ${f} = ${v}`);
        break;
      }
      case "assign":
        if (d["mode"] === "aiden") {
          note(s, "Hands the chat to Aiden — the flow ends and Aiden answers the customer's next messages.");
          s.done = true;
          return s;
        }
        note(s, "Assigns the chat to your team");
        break;
      case "needs_you":
        note(s, "Marks the chat as Needs you");
        break;
      case "cta_url":
        s.messages.push({ from: "bot", kind: "text", text: `${interpolate(String(d["text"] ?? ""), ctx)}\n[🔗 ${String(d["button_text"] ?? "Open")}]` });
        break;
      case "location_send":
        s.messages.push({ from: "bot", kind: "text", text: `📍 ${String(d["name"] || d["address"] || `${d["latitude"]}, ${d["longitude"]}`)}` });
        break;
      case "contact_card":
        s.messages.push({ from: "bot", kind: "text", text: `👤 ${String(d["name"] ?? "")} · ${String(d["phone"] ?? "")}` });
        break;
      case "carousel":
        note(s, `Sends ${((d["retailer_ids"] as string[]) ?? []).length} product card(s)`);
        break;
      case "set_variable": {
        const v = String(d["variable"] ?? "").trim();
        const val = computeVariable({ mode: String(d["mode"] ?? "value"), expression: String(d["expression"] ?? "") }, ctx) ?? "";
        if (v) ctx.vars[v] = val;
        note(s, `${v} = ${val}`);
        break;
      }
      case "business_hours": {
        const open = isBusinessOpen(graph.meta?.business_hours, new Date(), ctx.timezone);
        note(s, `Business hours → ${open ? "Open" : "Closed"}`);
        if (!go(graph, s, node, open ? "open" : "closed")) return s;
        continue;
      }
      case "ab_split": {
        const side = Math.random() * 100 < Number(d["percent_a"] ?? 50) ? "a" : "b";
        note(s, `A/B split → ${side.toUpperCase()}`);
        if (!go(graph, s, node, side)) return s;
        continue;
      }
      case "goto_flow":
        note(s, `Continues in flow "${String(d["flow_name"] ?? "another flow")}"`);
        s.done = true;
        return s;
      case "internal_note":
        note(s, `Internal note: ${interpolate(String(d["text"] ?? ""), ctx)}`);
        break;
      case "close_chat":
        note(s, "Closes the chat.");
        s.done = true;
        return s;
      case "opt":
        note(s, d["action"] === "out" ? "Opts the customer out." : "Opts the customer in.");
        if (d["action"] === "out") { s.done = true; return s; }
        break;
      case "segment":
        note(s, `${d["action"] === "remove" ? "Removes from" : "Adds to"} segment "${String(d["segment_name"] ?? "")}"`);
        break;
      case "note":
        break;
      case "sheets_append":
        note(s, `Adds a row to Google Sheets: ${((d["columns"] as string[]) ?? []).map((c) => interpolate(String(c), ctx)).join(" | ")}`);
        break;
      case "payment": {
        s.messages.push({ from: "bot", kind: "text", text: `${interpolate(String(d["text"] ?? "Here's your payment link:"), ctx)}\nhttps://rzp.io/test-link (not created in test chat)` });
        note(s, "Test chat assumes the customer paid.");
        if (!go(graph, s, node, "paid")) return s;
        continue;
      }
      case "http": {
        note(s, `Calls ${String(d["method"] ?? "GET")} ${String(d["url"] ?? "")} (not called in test chat — assumes success)`);
        for (const m of (d["save"] as Array<{ variable?: string }> | undefined) ?? []) if (m.variable) ctx.vars[m.variable] = `(${m.variable})`;
        if (!go(graph, s, node, "success")) return s;
        continue;
      }
      case "email_team":
        note(s, `Emails your team: "${interpolate(String(d["subject"] ?? ""), ctx)}" (not sent in test chat)`);
        break;
      case "wait_until":
        note(s, `Waits until ${d["mode"] === "field" ? `{{${String(d["field"] ?? "")}}}` : String(d["date"] ?? "")} (skipped in test)`);
        break;
      case "order_draft":
        ctx.vars["order_draft_id"] = "(draft)";
        note(s, `Creates an order draft: ${interpolate(String(d["items"] ?? ""), ctx)} (not saved in test chat)`);
        break;
      default:
        note(s, `Step "${node.type}" isn't supported yet.`);
    }
    if (!go(graph, s, node, "next")) return s;
  }
  s.done = true;
  note(s, "Stopped: too many steps (loop?).");
  return s;
}
