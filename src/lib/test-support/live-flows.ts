import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fakeDb, type FakeOp } from "./fake-db";
import { validateGraph, type FlowGraph, type FlowNode } from "../flow-graph";
import { simReply, simStart, simTimeout, type SimState } from "../flow-simulator";

/**
 * Test-only: the "live flows replay". Every published flow graph on the live
 * database (exported read-only into live-flows/graphs.json, one entry per
 * distinct shape; live-flows/manifest.json says which of the 137 published
 * versions share it) is replayed through validateGraph, the editor's
 * simulator and the real flow engine (on an in-memory database), and the
 * result is compared with live-flows/baseline.json — recorded on main before
 * any Batch 10C change. Never used by the app.
 */

const DIR = resolve(import.meta.dirname, "live-flows");

type Manifest = Record<string, { flow: string; key: string; versions: Array<[string, string, boolean, number]> }>;

/** Postgres's own text form of a jsonb value (keys by length, then bytes). */
function jsonbText(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  if (typeof v === "object") {
    const cmp = (a: string, b: string) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b));
    return `{${Object.keys(v as object)
      .sort(cmp)
      .map((k) => `${JSON.stringify(k)}: ${jsonbText((v as Record<string, unknown>)[k])}`)
      .join(", ")}}`;
  }
  return JSON.stringify(v);
}

const uuid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;

export type LiveShape = { shape: string; flow: string; key: string; versions: number; enabledVersions: number; graph: FlowGraph; md5Ok: boolean };

export function liveShapes(): LiveShape[] {
  const graphs = JSON.parse(readFileSync(resolve(DIR, "graphs.json"), "utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf8")) as Manifest;
  return Object.keys(graphs)
    .filter((k) => !k.startsWith("_"))
    .sort()
    .map((shape) => {
      const text = jsonbText(graphs[shape]).replace(/\{U(\d+)\}/g, (_, n: string) => uuid(n));
      const m = manifest[shape]!;
      return {
        shape,
        flow: m.flow,
        key: m.key,
        versions: m.versions.length,
        enabledVersions: m.versions.filter((v) => v[2]).length,
        graph: JSON.parse(text) as FlowGraph,
        md5Ok: createHash("md5").update(text).digest("hex") === shape,
      };
    });
}

export function manifestVersionCount(): number {
  const manifest = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf8")) as Manifest;
  return Object.entries(manifest).filter(([k]) => !k.startsWith("_")).reduce((n, [, m]) => n + m.versions.length, 0);
}

// ------------------------------------------------------------------ scripts

/** One customer input: tap the n-th option of the waiting step, type text, or stay quiet. */
export type Input = { tap: number } | { text: string } | { timeout: true };

/** Typed answers tried at every waiting step: menu words, numbers, pincodes, dates (valid, invalid, odd). */
export const PROBES = ["hello", "1", "2", "9", "110001", "12", "25-12-2026", "31-02-2026", "2026-12-25", "12/13/2026", "tomorrow", "5 Nov", "asha@example.com", "+91 98000 00001"];

function options(node: FlowNode | undefined): Array<{ id: string; title: string }> {
  if (!node) return [];
  return ((node.type === "buttons" ? node.data["buttons"] : node.type === "list" ? node.data["rows"] : []) as Array<{ id: string; title: string }> | undefined) ?? [];
}

/** A fitting answer for the waiting step: its first option, or a valid sample for an Ask. */
function goodAnswer(node: FlowNode | undefined): Input {
  if (options(node).length) return { tap: 0 };
  const samples: Record<string, string> = { number: "12", email: "asha@example.com", phone: "+91 98000 00001", pincode: "110001", date: "25-12-2026", text: "hello" };
  return { text: samples[String(node?.data["validation"] ?? "text")] ?? "hello" };
}

function apply(graph: FlowGraph, s: SimState, input: Input): SimState {
  if ("timeout" in input) return simTimeout(graph, s);
  if ("tap" in input) {
    const o = options(graph.nodes.find((n) => n.id === s.nodeId))[input.tap];
    return simReply(graph, s, o?.title ?? "");
  }
  return simReply(graph, s, input.text);
}

/**
 * The conversations replayed for one graph: every combination of taps through
 * its menus (up to `cap`), and at each waiting step along the first-option
 * path every probe text and a timeout, then first options to the end.
 */
export function scriptsFor(graph: FlowGraph, cap = 120, maxTurns = 6): Input[][] {
  const out: Input[][] = [];
  const walk = (prefix: Input[], s: SimState) => {
    if (out.length >= cap) return;
    if (s.done || !s.waiting || prefix.length >= maxTurns) {
      out.push(prefix);
      return;
    }
    const opts = options(graph.nodes.find((n) => n.id === s.nodeId));
    if (!opts.length) {
      // An Ask: its probes are covered below.
      out.push(prefix);
      return;
    }
    opts.forEach((_, i) => walk([...prefix, { tap: i }], apply(graph, s, { tap: i })));
  };
  walk([], simStart(graph, "Asha"));
  // Probes along the first-option path.
  let s = simStart(graph, "Asha");
  const path: Input[] = [];
  for (let turn = 0; turn < maxTurns && s.waiting && !s.done; turn++) {
    for (const p of [...PROBES.map((text) => ({ text })), { timeout: true as const }]) {
      const script: Input[] = [...path, p];
      let t = apply(graph, s, p);
      for (let k = 0; k < 3 && t.waiting && !t.done; k++) {
        const next = goodAnswer(graph.nodes.find((n) => n.id === t.nodeId));
        script.push(next);
        t = apply(graph, t, next);
      }
      out.push(script);
    }
    const next = goodAnswer(graph.nodes.find((n) => n.id === s.nodeId));
    path.push(next);
    s = apply(graph, s, next);
  }
  return out;
}

export function label(script: Input[]): string {
  return script.map((i) => ("tap" in i ? `tap#${i.tap}` : "text" in i ? JSON.stringify(i.text) : "timeout")).join(" → ") || "(start only)";
}

// ------------------------------------------------------------------ simulator + validation

export function simTranscript(graph: FlowGraph, script: Input[]) {
  let s = simStart(graph, "Asha");
  for (const i of script) s = apply(graph, s, i);
  return {
    messages: s.messages,
    path: s.path,
    vars: s.ctx.vars,
    tags: s.ctx.tags,
    contact: s.ctx.contact,
    waiting: s.waiting,
    done: s.done,
    node: s.nodeId,
  };
}

export const VALIDATE_OPTS: Record<string, Parameters<typeof validateGraph>[1]> = {
  default: {},
  cards_off_shop_off: { cards: false, whatsappShop: false },
  cards_on_shop_on: { cards: true, whatsappShop: true },
};

// ------------------------------------------------------------------ engine

/**
 * A workspace on an in-memory database that keeps state between messages: the
 * run row, the contact's attributes and tags, the events, and every message the
 * engine hands to the WhatsApp API. Replies go through handleInboundForRuns
 * exactly as the webhook calls it.
 */
export function engineWorld(org: string, graph: FlowGraph) {
  const runs = new Map<string, Record<string, unknown>>();
  const contact = { name: "Asha", phone: "+919800000001", wa_id: "919800000001", attributes: {} as Record<string, unknown>, opt_in_status: "unknown" };
  const tags = new Map<string, string>(); // id → name
  const contactTags = new Set<string>();
  const events: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  let seq = 0;
  const account = { id: `acc-${org}`, organization_id: org, waba_id: "waba", phone_number_id: "pn", display_phone_number: "911111111111", status: "active", is_default: true };
  const eqOf = (op: FakeOp, col: string) => op.filters.find(([f, a]) => f === "eq" && a[0] === col)?.[1][1];
  const reply = (op: FakeOp): { data: unknown; error: null } | undefined => {
    const t = op.table;
    if (t === "flow_versions") return { data: { id: "ver-1", graph }, error: null };
    if (t === "organizations") return { data: { name: "Replay shop", branding: {}, timezone: "Asia/Kolkata", plan_status: "active" }, error: null };
    if (t === "whatsapp_accounts") return { data: op.filters.some(([f]) => f === "limit") ? [account] : account, error: null };
    if (t === "whatsapp_credentials") return { data: { access_token: "tok" }, error: null };
    if (t === "conversations" && op.kind === "select")
      return { data: { id: "cv1", contact_id: "c1", last_customer_message_at: new Date().toISOString(), whatsapp_account_id: account.id }, error: null };
    if (t === "contacts" && op.kind === "select")
      return { data: { ...contact, attributes: { ...contact.attributes }, contact_tags: [...contactTags].map((id) => ({ tags: { name: tags.get(id) } })) }, error: null };
    if (t === "contacts" && op.kind === "update") {
      Object.assign(contact, op.payload as object);
      writes.push(`contact:${JSON.stringify(op.payload)}`);
      return { data: null, error: null };
    }
    if (t === "tags" && op.kind === "select") {
      const want = String(op.filters.find(([f]) => f === "ilike")?.[1][1] ?? "").replace(/\\(.)/g, "$1").toLowerCase();
      const hit = [...tags].find(([, n]) => n.toLowerCase() === want);
      return { data: hit ? [{ id: hit[0] }] : [], error: null };
    }
    if (t === "tags" && op.kind === "insert") {
      const id = `tag-${tags.size + 1}`;
      tags.set(id, String((op.payload as { name: string }).name));
      return { data: { id }, error: null };
    }
    if (t === "contact_tags" && op.kind === "upsert") {
      const id = String((op.payload as { tag_id: string }).tag_id);
      contactTags.add(id);
      writes.push(`tag+:${tags.get(id)}`);
      return { data: null, error: null };
    }
    if (t === "contact_tags" && op.kind === "delete") {
      const id = String(eqOf(op, "tag_id"));
      contactTags.delete(id);
      writes.push(`tag-:${tags.get(id)}`);
      return { data: null, error: null };
    }
    if (t === "flow_runs" && op.kind === "insert") {
      const id = `run-${org}-${++seq}`;
      const row = { id, ...(op.payload as object), variables: {}, waiting_for: null, wake_at: null, steps: 0, started_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      runs.set(id, row);
      return { data: structuredClone(row), error: null };
    }
    if (t === "flow_runs" && op.kind === "update") {
      const id = eqOf(op, "id");
      const matched = [...runs.values()].filter(
        (r) => (id === undefined || r["id"] === id) && op.filters.every(([f, a]) => f !== "eq" || a[0] === "id" || r[String(a[0])] === a[1]),
      );
      for (const r of matched) Object.assign(r, structuredClone(op.payload as object), { updated_at: new Date().toISOString() });
      return { data: matched.map((r) => ({ id: r["id"] })), error: null };
    }
    if (t === "flow_runs" && op.kind === "select") {
      if (op.filters.some(([f]) => f === "in")) return { data: structuredClone([...runs.values()].filter((r) => ["running", "waiting"].includes(String(r["status"])))), error: null };
      const row = runs.get(String(eqOf(op, "id")));
      return { data: row ? structuredClone(row) : null, error: null };
    }
    if (t === "flow_run_events" && op.kind === "insert") {
      for (const e of (Array.isArray(op.payload) ? op.payload : [op.payload]) as Array<{ event: string; node_id?: string | null; detail?: Record<string, unknown> }>)
        events.push(`${e.node_id ?? "-"}:${e.event}${e.detail && Object.keys(e.detail).length ? ` ${stableDetail(e.detail)}` : ""}`);
      return { data: null, error: null };
    }
    if (t === "messages" && op.kind === "insert") return { data: { id: `m-${++seq}` }, error: null };
    if (t === "conversations" && op.kind === "update") {
      writes.push(`conversation:${JSON.stringify(op.payload, (k, v) => (k.endsWith("_at") ? "<time>" : v))}`);
      return { data: null, error: null };
    }
    return undefined;
  };
  const db = fakeDb(reply, (call) => {
    if (call.name === "flow_merge_contact_attribute") {
      contact.attributes[String(call.args["p_key"])] = call.args["p_value"];
      writes.push(`attr:${String(call.args["p_key"])}=${JSON.stringify(call.args["p_value"])}`);
    }
    return { data: null, error: null };
  });
  const fetchStub = async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (String(url).includes("graph.facebook.com") && !body["status"]) sends.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${sends.length}` }] }), { status: 200 });
  };
  const waitingNode = () => {
    const r = [...runs.values()].find((x) => x["status"] === "waiting");
    return r ? graph.nodes.find((n) => n.id === r["current_node_id"]) : undefined;
  };
  return { ...db, runs, contact, contactTags, tags, events, sends, writes, fetchStub, waitingNode, org };
}

function stableDetail(d: Record<string, unknown>): string {
  return JSON.stringify(d, (k, v) => (k === "at" || k.endsWith("_at") || k === "ms" ? "<time>" : v));
}

/** What the engine did for one conversation, in a form that compares across code versions. */
export async function engineTranscript(
  engine: typeof import("../flow-engine.server"),
  graph: FlowGraph,
  script: Input[],
  org: string,
) {
  const w = engineWorld(org, graph);
  const realFetch = globalThis.fetch;
  globalThis.fetch = w.fetchStub as typeof fetch;
  const turns: Array<{ input: string; consumed?: boolean; sends: Array<Record<string, unknown>> }> = [];
  try {
    const started = await engine.startRun(w.supabase, { organizationId: org, flowId: "flow-1", contactId: "c1", conversationId: "cv1", trigger: { kind: "keyword" }, fromCustomerMessage: true });
    turns.push({ input: `start (${started.reason ?? "ok"})`, sends: w.sends.splice(0) });
    for (const i of script) {
      if ("timeout" in i) {
        turns.push({ input: "timeout (engine: minute tick, not replayed)", sends: [] });
        break;
      }
      const node = w.waitingNode();
      const o = "tap" in i ? options(node)[i.tap] : undefined;
      const res = await engine.handleInboundForRuns(w.supabase, {
        organizationId: org,
        contactId: "c1",
        conversationId: "cv1",
        whatsappAccountId: `acc-${org}`,
        body: "tap" in i ? o?.title ?? "" : i.text,
        replyId: "tap" in i && node && o ? `${node.id}:${o.id}` : null,
      });
      turns.push({ input: "tap" in i ? `tap ${o?.title ?? "?"}` : `text ${JSON.stringify(i.text)}`, consumed: res.consumed, sends: w.sends.splice(0) });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  const run = [...w.runs.values()].at(-1) ?? {};
  const vars = { ...((run["variables"] as Record<string, unknown> | undefined) ?? {}) };
  delete vars["_last_reply"];
  return {
    turns,
    run: { status: run["status"] ?? null, waiting_for: run["waiting_for"] ?? null, node: run["current_node_id"] ?? null, steps: run["steps"] ?? null, last_error: run["last_error"] ?? null, vars },
    contact: { name: w.contact.name, attributes: w.contact.attributes, tags: [...w.contactTags].map((id) => w.tags.get(id)) },
    events: w.events,
    writes: w.writes,
  };
}

// ------------------------------------------------------------------ baseline

export const BASELINE = resolve(DIR, "baseline.json");

export function readBaseline(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** One line per replayed conversation, so a change shows up as a one-line diff. */
export function writeBaseline(data: Record<string, unknown>): void {
  const lines: string[] = ["{"];
  const top = Object.entries(data);
  top.forEach(([k, v], i) => {
    const end = i === top.length - 1 ? "" : ",";
    if (!v || typeof v !== "object") return void lines.push(` ${JSON.stringify(k)}: ${JSON.stringify(v)}${end}`);
    lines.push(` ${JSON.stringify(k)}: {`);
    const parts = Object.entries(v as Record<string, unknown>);
    parts.forEach(([pk, pv], j) => {
      const pend = j === parts.length - 1 ? "" : ",";
      if ((pk === "sim" || pk === "engine") && pv && typeof pv === "object") {
        const rows = Object.entries(pv as Record<string, unknown>);
        lines.push(`  ${JSON.stringify(pk)}: {`);
        rows.forEach(([rk, rv], r) => lines.push(`   ${JSON.stringify(rk)}: ${JSON.stringify(rv)}${r === rows.length - 1 ? "" : ","}`));
        lines.push(`  }${pend}`);
      } else lines.push(`  ${JSON.stringify(pk)}: ${JSON.stringify(pv)}${pend}`);
    });
    lines.push(` }${end}`);
  });
  lines.push("}");
  writeFileSync(BASELINE, `${lines.join("\n")}\n`);
}
