import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_RUN_AGE_DAYS,
  MAX_STEPS_PER_RUN,
  computeVariable,
  edgeFrom,
  isBusinessOpen,
  interpolate,
  pickBranch,
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
import { isServiceWindowOpen } from "@/lib/service-window";
import type { ReplyTimer } from "@/lib/reply-timing";

/**
 * Flows v2 engine. Durable: a run's whole state lives in flow_runs; waits are
 * wake_at timestamps picked up by the minute tick. Every send reuses the
 * existing senders and is guarded by an idempotency key (run + node + attempt).
 * Legacy event flows (graph.meta.legacy) are never executed here.
 */

type Run = {
  id: string;
  organization_id: string;
  flow_id: string;
  version_id: string;
  contact_id: string;
  conversation_id: string | null;
  current_node_id: string | null;
  variables: Record<string, unknown>;
  status: string;
  waiting_for: string | null;
  wake_at: string | null;
  steps: number;
  started_at: string;
};

type Inbound = { body: string; replyId: string | null };

/** What the webhook knows about the message a run is answering. */
export type InboundExtras = {
  /** Per-stage timings for webhook_events.timing. */
  timer?: ReplyTimer;
  /**
   * The webhook's 24-hour-window write. The run may be claimed/started while
   * it lands, but nothing is sent before it has.
   */
  ready?: Promise<unknown>;
  /** When the customer's message was sent: it opens the 24-hour window. */
  inboundAt?: string;
  /** The number the message came in on, already resolved by the webhook. */
  connection?: Conn;
  /** The conversation the message came in on, and its number. */
  conversation?: { id: string; whatsappAccountId: string };
};

const RUN_COLUMNS =
  "id, organization_id, flow_id, version_id, contact_id, conversation_id, current_node_id, variables, status, waiting_for, wake_at, steps, started_at";
const DEFAULT_REPLY_TIMEOUT_MIN = 24 * 60;
const MAX_VISITS_PER_ADVANCE = 25;
/** Go-to-flow hand-overs in one chain before the chain is stopped. */
export const MAX_GOTO_HOPS = 10;

/** How many Go-to-flow hand-overs led to this run (0 for a run started any other way). */
async function gotoHops(supabase: SupabaseClient, runId: string): Promise<number> {
  const { data } = await supabase.from("flow_runs").select("trigger").eq("id", runId).maybeSingle();
  const trigger = ((data as { trigger?: Record<string, unknown> } | null)?.trigger ?? {}) as Record<string, unknown>;
  if (trigger["kind"] !== "goto_flow") return 0;
  const hops = Number(trigger["hops"] ?? 1);
  return Number.isFinite(hops) && hops > 0 ? hops : 1;
}

// Flag answers are reused for 30 s so one inbound message doesn't re-read
// the flag tables four times (speed; a switch-off still lands within 30 s).
// A read already in flight is shared too (the webhook warms it as soon as
// it knows the workspace).
const flagMemo = new Map<string, { on: Promise<boolean>; exp: number }>();
export function flowsV2Enabled(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const hit = flagMemo.get(organizationId);
  if (hit && hit.exp > Date.now()) return hit.on;
  // One source of truth for flags: the same resolver the AI tools use (a
  // small module of its own, so a flow reply never loads the AI tools).
  const on = import("@/lib/feature-flags.server")
    .then(({ enabledFlags }) => enabledFlags(supabase, organizationId))
    .then((flags) => flags.has("flows_v2"));
  flagMemo.set(organizationId, { on, exp: Date.now() + 30_000 });
  on.catch(() => flagMemo.delete(organizationId));
  return on;
}

/**
 * Plain log rows (entered/exited/…) collected during one advance and written
 * in a single insert at the end — each row used to cost a round trip. Rows
 * carrying an idempotency key (sends) are always written immediately.
 */
type EventRow = { organization_id: string; run_id: string; node_id: string | null; event: string; detail: Record<string, unknown>; at: string };
const eventBuffers = new Map<string, EventRow[]>();
let lastEventMs = 0;
function eventTime(): string {
  // Strictly increasing so buffered rows keep their order in the run log.
  lastEventMs = Math.max(Date.now(), lastEventMs + 1);
  return new Date(lastEventMs).toISOString();
}
async function flushEvents(supabase: SupabaseClient, runId: string) {
  const rows = eventBuffers.get(runId);
  eventBuffers.delete(runId);
  if (!rows || !rows.length) return;
  const { error } = await supabase.from("flow_run_events").insert(rows);
  if (error) throw new Error(`event_log_failed:${error.code ?? ""}:${error.message}`.slice(0, 280));
}

async function logEvent(
  supabase: SupabaseClient,
  run: Pick<Run, "id" | "organization_id">,
  nodeId: string | null,
  event: string,
  detail: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<boolean> {
  const buffer = idempotencyKey ? null : eventBuffers.get(run.id);
  if (buffer) {
    buffer.push({ organization_id: run.organization_id, run_id: run.id, node_id: nodeId, event, detail, at: eventTime() });
    return true;
  }
  const { error } = await supabase.from("flow_run_events").insert({
    organization_id: run.organization_id,
    run_id: run.id,
    node_id: nodeId,
    event,
    detail,
    at: eventTime(),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
  if (!error) return true;
  // 23505 = this exact send already happened → skip it. Any other failure
  // means we can't prove the send is unique, so the run must fail.
  if (error.code === "23505") return false;
  throw new Error(`event_log_failed:${error.code ?? ""}:${error.message}`.slice(0, 280));
}

async function loadGraph(supabase: SupabaseClient, versionId: string): Promise<FlowGraph | null> {
  const { data } = await supabase.from("flow_versions").select("graph").eq("id", versionId).maybeSingle();
  const g = (data as { graph?: FlowGraph } | null)?.graph;
  return g && Array.isArray(g.nodes) ? g : null;
}

type PublishedVersion = { id: string; graph: FlowGraph } | null;

/** The flow's published version. Exported so a trigger can start it while other checks run. */
export function readPublishedVersion(supabase: SupabaseClient, organizationId: string, flowId: string): Promise<PublishedVersion> {
  const read = Promise.resolve(
    supabase
      .from("flow_versions")
      .select("id, graph")
      .eq("flow_id", flowId)
      .eq("organization_id", organizationId)
      .eq("status", "published")
      .maybeSingle(),
  ).then(({ data }) => data as PublishedVersion);
  read.catch(() => {});
  return read;
}

/** Start a run of the flow's published version. Skips when one is already active. */
export async function startRun(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    flowId: string;
    contactId: string;
    conversationId?: string | null;
    trigger?: Record<string, unknown>;
    inbound?: Inbound | null;
    /** Started by a message the customer just sent (keyword, first message…). */
    fromCustomerMessage?: boolean;
    /** readPublishedVersion() already started by the caller (speed). */
    version?: Promise<PublishedVersion>;
    /** See InboundExtras. */
    extras?: InboundExtras;
  },
): Promise<{ runId: string | null; reason: string | null }> {
  const version = args.version ?? readPublishedVersion(supabase, args.organizationId, args.flowId);
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return { runId: null, reason: "flag_off" };
  const v = await version;
  if (!v) return { runId: null, reason: "not_published" };
  if (v.graph.meta?.legacy) return { runId: null, reason: "legacy_flow" };
  const start = startNode(v.graph);
  if (!start) return { runId: null, reason: "no_start" };

  // The run's surroundings (contact, window, number) are read while the run
  // row is written — neither needs the other. Read-only, so a failed insert
  // just drops it.
  const extras = args.extras ?? {};
  const env = loadEnv(
    supabase,
    {
      organization_id: args.organizationId,
      flow_id: args.flowId,
      contact_id: args.contactId,
      conversation_id: args.conversationId ?? null,
      variables: {},
    },
    extras,
  );
  env.catch(() => {});
  const { data: inserted, error } = await supabase
    .from("flow_runs")
    .insert({
      organization_id: args.organizationId,
      flow_id: args.flowId,
      version_id: v.id,
      contact_id: args.contactId,
      conversation_id: args.conversationId ?? null,
      current_node_id: start.id,
      status: "running",
      trigger: args.trigger ?? {},
    })
    .select(RUN_COLUMNS)
    .single();
  if (error || !inserted) return { runId: null, reason: error?.code === "23505" ? "already_running" : "insert_failed" };
  const run = inserted as Run;
  extras.timer?.mark("flow_routed");
  extras.timer?.mark("run_created");
  // Every trigger fire is recorded (trigger, flow, contact, run) for the
  // Triggers panel and stats — written alongside the first step, not before it.
  const triggerId = String(args.trigger?.["trigger_id"] ?? "");
  const fireWrite = /^[0-9a-f-]{36}$/.test(triggerId)
    ? supabase
        .from("flow_trigger_fires")
        .insert({ organization_id: args.organizationId, trigger_id: triggerId, flow_id: args.flowId, kind: String(args.trigger?.["kind"] ?? ""), contact_id: args.contactId, run_id: run.id })
        .then(({ error }) => { if (error) console.error("[flows-v2] trigger fire not recorded", error.message); })
    : null;
  try {
    eventBuffers.set(run.id, []);
    try {
      await logEvent(supabase, run, start.id, "started", args.trigger ?? {});
      await advance(supabase, run, v.graph, null, {
        fromCustomer: Boolean(args.fromCustomerMessage),
        env,
        ...(extras.ready ? { ready: extras.ready } : {}),
        ...(extras.timer ? { timer: extras.timer } : {}),
      });
    } finally {
      await flushEvents(supabase, run.id);
    }
  } catch (error) {
    await failSafe(supabase, run, error);
  }
  if (fireWrite) await fireWrite;
  // The run exists either way, so the trigger counts as consumed.
  return { runId: run.id, reason: null };
}

/** How long a message that arrives while the flow is busy is held for it. */
const HOLD_MS = 12_000;
const DUPLICATE_WINDOW_MS = 20_000;

export type InboundRoute = "take" | "hold" | "release" | "duplicate";

/**
 * Who owns one inbound message, given the contact's run (null = none):
 *  - waiting for this contact's reply → the flow takes it ("take");
 *  - running → held until the run is ready ("hold");
 *  - a held repeat of the tap the run just took (same id within 20 s) → dropped ("duplicate");
 *  - anything else (timer/payment wait, run finished) → normal routing ("release").
 */
export function routeInbound(
  run: Pick<Run, "status" | "waiting_for" | "variables"> | null,
  held: boolean,
  key: string,
  now: number = Date.now(),
): InboundRoute {
  if (!run) return "release";
  if (held) {
    const last = run.variables?.["_last_reply"] as { k?: string; at?: string } | undefined;
    if (last?.k === key && last.at && now - Date.parse(last.at) < DUPLICATE_WINDOW_MS) return "duplicate";
  }
  if (run.status === "waiting" && run.waiting_for === "reply") return "take";
  if (run.status === "running") return "hold";
  return "release";
}

/**
 * An inbound message. It belongs to the flow only when the contact's run is
 * waiting for their reply, or is busy running (held, then handed over when
 * the run is ready). During timer/payment waits — and whenever a held
 * message can't be taken — it goes to normal routing (automations, then
 * the AI); a message is never silently dropped, except a repeat of the tap
 * the run just took.
 */
export async function handleInboundForRuns(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    whatsappAccountId?: string | null;
    body: string;
    replyId: string | null;
    /** The contact's run as read by peekInboundRun while earlier steps ran (speed). */
    firstLook?: Promise<Run | null | undefined>;
    /** The number the message came in on, already resolved by the webhook. */
    connection?: Conn;
  } & InboundExtras,
): Promise<{ consumed: boolean; runActive?: boolean }> {
  const deadline = Date.now() + HOLD_MS;
  if (args.connection && args.whatsappAccountId) primeConnection(args.organizationId, args.whatsappAccountId, args.connection);
  let firstLook = args.firstLook;
  const key = (args.replyId ?? args.body.trim().toLowerCase()).slice(0, 200);
  let heldFor: Run | null = null;
  let flagChecked = false;
  // runActive: the contact's run is still going (timer/payment wait, or busy),
  // so normal routing must not let a keyword start another flow.
  const release = async (run: Pick<Run, "id" | "organization_id" | "current_node_id">, detail: Record<string, unknown>, runActive: boolean) => {
    await logEvent(supabase, run, run.current_node_id, "reply_released", { ...detail, held: Boolean(heldFor), length: args.body.length }).catch(() => false);
    return { consumed: false, runActive };
  };
  for (;;) {
    // The first look may already be in hand; undefined means it failed → read again.
    const looked = firstLook ? await firstLook : undefined;
    firstLook = undefined;
    let run: Run | null = looked !== undefined ? looked : await activeRunFor(supabase, args);
    let active = true;
    if (!run) {
      if (!heldFor) return { consumed: false };
      // The run we were holding for is no longer active: re-read it only to
      // spot a duplicate tap; anything else goes to normal routing.
      const { data: last }: { data: unknown } = await supabase.from("flow_runs").select(RUN_COLUMNS).eq("id", heldFor.id).maybeSingle();
      run = (last as Run | null) ?? heldFor;
      active = false;
    }
    if (!flagChecked) {
      if (!(await flowsV2Enabled(supabase, args.organizationId))) return { consumed: false };
      flagChecked = true;
    }

    let route = routeInbound(run, Boolean(heldFor), key);
    if (!active && route !== "duplicate") route = "release";
    if (route === "duplicate") {
      await logEvent(supabase, run, run.current_node_id, "reply_dropped", { reason: "duplicate_tap" }).catch(() => false);
      return { consumed: true };
    }
    if (route === "release") return release(run, { status: run.status, waiting_for: run.waiting_for }, active);

    if (route === "take") {
      const conversationId = run.conversation_id ?? args.conversationId;
      // Graph, claim and the run's surroundings are independent reads/writes:
      // one round trip instead of three. The env read is discarded if the
      // claim is lost.
      const env = loadEnv(supabase, { ...run, conversation_id: conversationId }, args);
      env.catch(() => {});
      const [graph, { data: claimed }] = await Promise.all([
        loadGraph(supabase, run.version_id),
        // Claim: only one of (this reply, another reply, a timeout tick) may advance the run.
        supabase
          .from("flow_runs")
          .update({ status: "running", claimed_at: new Date().toISOString(), conversation_id: conversationId })
          .eq("id", run.id)
          .eq("status", "waiting")
          .eq("waiting_for", "reply")
          .select("id"),
      ]);
      const won = Boolean(claimed && claimed.length > 0);
      if (won) args.timer?.mark("flow_routed");
      if (!graph) {
        // Put a claimed run back exactly as it was waiting, then release.
        if (won) {
          await supabase
            .from("flow_runs")
            .update({ status: "waiting", claimed_at: null })
            .eq("id", run.id)
            .eq("status", "running");
        }
        return release(run, { reason: "no_graph" }, true);
      }
      if (won) {
        run.conversation_id = conversationId;
        run.variables = { ...(run.variables ?? {}), _last_reply: { k: key, at: new Date().toISOString() } };
        // The reply row is buffered with the rest of this advance (one insert
        // after the send, not a round trip before it).
        eventBuffers.set(run.id, []);
        try {
          try {
            await logEvent(supabase, run, run.current_node_id, "reply", { reply_id: args.replyId, length: args.body.length, held: Boolean(heldFor) });
            // advance() reasons about the state the run was waiting in.
            await advance(supabase, run, graph, { body: args.body, replyId: args.replyId }, {
              env,
              ...(args.ready ? { ready: args.ready } : {}),
              ...(args.timer ? { timer: args.timer } : {}),
            });
          } finally {
            await flushEvents(supabase, run.id);
          }
        } catch (error) {
          await failSafe(supabase, run, error);
        }
        return { consumed: true };
      }
      // Lost the claim — the run is busy again; hold and retry.
    }

    if (!heldFor) {
      heldFor = run;
      await logEvent(supabase, run, run.current_node_id, "reply_held", { reply_id: args.replyId, length: args.body.length }).catch(() => false);
    }
    if (Date.now() > deadline) return release(run, { reason: "flow_busy" }, true);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * The contact's run, read while the webhook is still busy with the steps
 * before the flow's turn (opt-out, cash-on-delivery). Read-only: the flow
 * decides nothing until handleInboundForRuns takes it. Also warms the flag.
 * Resolves undefined on any failure, so the engine reads again itself.
 */
export function peekInboundRun(
  supabase: SupabaseClient,
  args: { organizationId: string; contactId: string; conversationId: string; whatsappAccountId?: string | null },
): Promise<Run | null | undefined> {
  return Promise.all([activeRunFor(supabase, args), flowsV2Enabled(supabase, args.organizationId).catch(() => false)])
    .then(([run]) => run)
    .catch(() => undefined);
}

/** The contact's running/waiting run on this conversation (or unbound on this number). */
async function activeRunFor(
  supabase: SupabaseClient,
  args: { organizationId: string; contactId: string; conversationId: string; whatsappAccountId?: string | null },
): Promise<Run | null> {
  const { data } = await supabase
    .from("flow_runs")
    .select(`${RUN_COLUMNS}, updated_at`)
    .eq("organization_id", args.organizationId)
    .eq("contact_id", args.contactId)
    .in("status", ["running", "waiting"])
    .or(`conversation_id.eq.${args.conversationId},conversation_id.is.null`)
    .order("updated_at", { ascending: false })
    .limit(5);
  // A run stuck "running" for over 2 minutes crashed mid-step; it must not
  // swallow the customer's messages.
  const staleBefore = Date.now() - 120_000;
  let candidates = ((data ?? []) as Array<Run & { updated_at?: string }>).filter(
    (r) => r.status !== "running" || !r.updated_at || Date.parse(r.updated_at) > staleBefore,
  ) as Run[];
  const unbound = candidates.filter((r) => !r.conversation_id);
  if (unbound.length && args.whatsappAccountId) {
    const { data: flows } = await supabase
      .from("flows")
      .select("id, whatsapp_account_id")
      .in("id", unbound.map((r) => r.flow_id));
    const onOtherNumber = new Set(
      ((flows ?? []) as Array<{ id: string; whatsapp_account_id: string | null }>)
        .filter((f) => f.whatsapp_account_id && f.whatsapp_account_id !== args.whatsappAccountId)
        .map((f) => f.id),
    );
    candidates = candidates.filter((r) => r.conversation_id || !onOtherNumber.has(r.flow_id));
  }
  // Prefer a run waiting for a reply, then this conversation's run.
  return (
    candidates.find((r) => r.status === "waiting" && r.waiting_for === "reply" && r.conversation_id === args.conversationId) ??
    candidates.find((r) => r.status === "waiting" && r.waiting_for === "reply") ??
    candidates.find((r) => r.conversation_id === args.conversationId) ??
    candidates[0] ??
    null
  );
}

/** Minute tick: due waits and reply timeouts, plus the 14-day age limit. */
export async function tickRuns(supabase: SupabaseClient): Promise<{ processed: number; expired: number }> {
  const cutoff = new Date(Date.now() - MAX_RUN_AGE_DAYS * 86_400_000).toISOString();
  const { data: old } = await supabase
    .from("flow_runs")
    .update({ status: "expired", ended_at: new Date().toISOString(), wake_at: null })
    .in("status", ["running", "waiting", "paused"])
    .lt("started_at", cutoff)
    .select("id");
  // The claim moves each run to "running" (20261009_batch3_safety.sql), so a
  // reply arriving now can't take the same run; the run is advanced from the
  // wait it was claimed in.
  const { data: claimed } = await supabase.rpc("claim_flow_runs", { p_limit: 50 });
  const runs = (claimed ?? []) as Run[];
  for (const run of runs) {
    run.status = "waiting";
    try {
      const graph = await loadGraph(supabase, run.version_id);
      if (!graph || !(await flowsV2Enabled(supabase, run.organization_id))) {
        await supabase.from("flow_runs").update({ status: "waiting", claimed_at: null, wake_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", run.id);
        continue;
      }
      await advance(supabase, run, graph, null, { woke: true });
    } catch (error) {
      await failSafe(supabase, run, error);
    }
  }
  return { processed: runs.length, expired: (old ?? []).length };
}

export async function controlRun(
  supabase: SupabaseClient,
  args: { organizationId: string; runId: string; action: "pause" | "stop" | "resume"; userId: string | null },
): Promise<{ ok: boolean; error: string | null }> {
  const { data } = await supabase
    .from("flow_runs")
    .select(RUN_COLUMNS)
    .eq("id", args.runId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  const run = data as Run | null;
  if (!run) return { ok: false, error: "That flow run no longer exists." };
  if (args.action === "stop") {
    await supabase.from("flow_runs").update({ status: "cancelled", wake_at: null, ended_at: new Date().toISOString() }).eq("id", run.id);
  } else if (args.action === "pause") {
    if (!["running", "waiting"].includes(run.status)) return { ok: false, error: "This run isn't active." };
    await supabase
      .from("flow_runs")
      .update({ status: "paused", variables: { ...run.variables, _paused: { waiting_for: run.waiting_for, wake_at: run.wake_at } }, wake_at: null })
      .eq("id", run.id);
  } else {
    if (run.status !== "paused") return { ok: false, error: "This run isn't paused." };
    const prev = (run.variables["_paused"] ?? {}) as { waiting_for?: string | null; wake_at?: string | null };
    const vars = { ...run.variables };
    delete vars["_paused"];
    await supabase
      .from("flow_runs")
      .update({
        status: "waiting",
        waiting_for: prev.waiting_for ?? "timer",
        // Reply waits keep their deadline; timer waits never wake earlier than planned.
        wake_at:
          prev.waiting_for === "reply"
            ? prev.wake_at ?? null
            : new Date(Math.max(prev.wake_at ? new Date(prev.wake_at).getTime() : 0, Date.now())).toISOString(),
        variables: vars,
      })
      .eq("id", run.id);
  }
  await logEvent(supabase, run, run.current_node_id, args.action, { by: args.userId });
  return { ok: true, error: null };
}

async function failSafe(supabase: SupabaseClient, run: Run, error: unknown) {
  try {
    await fail(supabase, run, error instanceof Error ? error.message : String(error));
  } catch (e) {
    console.error("[flows-v2] could not mark run failed", run.id, e instanceof Error ? e.message : String(e));
  }
}

async function fail(supabase: SupabaseClient, run: Run, message: string) {
  await supabase
    .from("flow_runs")
    .update({ status: "failed", last_error: message.slice(0, 300), wake_at: null, claimed_at: null, ended_at: new Date().toISOString() })
    .eq("id", run.id);
  await logEvent(supabase, run, run.current_node_id, "failed", { error: message.slice(0, 300) }).catch(() => false);
}

type Env = {
  ctx: RunContext;
  to: string;
  optedOut: boolean;
  /** Explicit opt-in on file — required before any MARKETING template. */
  optedIn: boolean;
  windowOpen: boolean;
  conn: { phoneNumberId: string; accessToken: string; accountId: string; wabaId: string } | null;
  settings: import("@/lib/flows.server").SendSettings;
  /** Set for a run answering a webhook message; records the send timings. */
  timer?: ReplyTimer;
};

// The number's token is reused for 60 s within this server (speed); it is
// never written anywhere and never leaves the server.
type Conn = Awaited<ReturnType<typeof import("@/lib/whatsapp-numbers.server").getWhatsAppConnection>>["connection"];
const connMemo = new Map<string, { c: Conn; exp: number }>();
/** The webhook already resolved this number's connection; reuse it instead of reading it again. */
function primeConnection(organizationId: string, accountId: string, connection: Conn) {
  if (connection) connMemo.set(`${organizationId}:${accountId}`, { c: connection, exp: Date.now() + 60_000 });
}
async function connectionFor(supabase: SupabaseClient, organizationId: string, accountId: string | null): Promise<Conn> {
  const k = `${organizationId}:${accountId ?? ""}`;
  const hit = connMemo.get(k);
  if (hit && hit.exp > Date.now()) return hit.c;
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(supabase, organizationId, accountId);
  if (connection) connMemo.set(k, { c: connection, exp: Date.now() + 60_000 });
  return connection;
}

// Quiet hours and the timezone are reused for 30 s within this server, like
// the flags (speed: two reads less beside the claim; a change lands within 30 s).
type SendSettings = import("@/lib/flows.server").SendSettings;
const settingsMemo = new Map<string, { s: Promise<SendSettings>; exp: number }>();
async function sendSettingsFor(supabase: SupabaseClient, organizationId: string): Promise<SendSettings> {
  const hit = settingsMemo.get(organizationId);
  if (hit && hit.exp > Date.now()) return hit.s;
  const { loadSendSettings } = await import("@/lib/flows.server");
  const s = loadSendSettings(supabase, organizationId);
  settingsMemo.set(organizationId, { s, exp: Date.now() + 30_000 });
  s.catch(() => settingsMemo.delete(organizationId));
  return s;
}

async function loadEnv(
  supabase: SupabaseClient,
  run: Pick<Run, "organization_id" | "flow_id" | "contact_id" | "conversation_id" | "variables">,
  /** What the webhook already knows about the message this run answers. */
  extras: InboundExtras = {},
): Promise<Env> {
  const known = extras.connection;
  // The customer's message being answered opens the window, even if a
  // conversation read would predate its write.
  const inboundAt = extras.inboundAt;
  const inboundOpen = inboundAt ? isServiceWindowOpen({ last_customer_message_at: inboundAt }) : false;
  // The conversation the message came in on: its number is known and the
  // message just opened its window, so it isn't read again.
  const knownConversation =
    inboundOpen && extras.conversation && extras.conversation.id === run.conversation_id
      ? { last_customer_message_at: inboundAt, whatsapp_account_id: extras.conversation.whatsappAccountId }
      : null;
  // The flow's own number is only needed when the run has no conversation to
  // take it from; a Worker has six connections, so it isn't read otherwise.
  const flowNumber = () =>
    Promise.resolve(supabase.from("flows").select("whatsapp_account_id").eq("id", run.flow_id).maybeSingle()).then(
      ({ data }) => (data as { whatsapp_account_id?: string | null } | null)?.whatsapp_account_id ?? null,
    );
  const [{ data: contact, error: contactError }, { data: conversation }, settings] = await Promise.all([
    // Tags come embedded with the contact: one request, not two.
    supabase.from("contacts").select("name, phone, wa_id, attributes, opt_in_status, contact_tags(tags(name))").eq("id", run.contact_id).maybeSingle(),
    knownConversation
      ? Promise.resolve({ data: knownConversation })
      : run.conversation_id
      ? supabase.from("conversations").select("last_customer_message_at, whatsapp_account_id").eq("id", run.conversation_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sendSettingsFor(supabase, run.organization_id),
  ]);
  // Without the contact we can't know opt-out or attributes — fail, never guess.
  if (contactError || !contact) throw new Error(contactError ? `contact_read_failed:${contactError.message}` : "contact_missing");
  const c = contact as unknown as {
    name: string | null;
    phone: string;
    wa_id: string | null;
    attributes: Record<string, unknown> | null;
    opt_in_status: string | null;
    contact_tags?: Array<{ tags: { name: string } | null }> | null;
  };
  const conv = conversation as { last_customer_message_at?: string | null; whatsapp_account_id?: string | null } | null;
  const accountId = conv?.whatsapp_account_id ?? (await flowNumber());
  const connection =
    known && accountId && known.accountId === accountId && known.organizationId === run.organization_id
      ? known
      : await connectionFor(supabase, run.organization_id, accountId);
  return {
    ctx: {
      vars: run.variables ?? {},
      contact: { name: c.name, phone: c.phone, attributes: c.attributes ?? {} },
      tags: (c.contact_tags ?? []).map((t) => t.tags?.name ?? "").filter(Boolean),
      now: new Date(),
      timezone: settings.timezone,
    },
    to: (c.wa_id ?? c.phone).replace(/\D/g, ""),
    optedOut: String(c.opt_in_status ?? "").toLowerCase() === "opted_out",
    optedIn: String(c.opt_in_status ?? "").toLowerCase() === "opted_in",
    windowOpen: isServiceWindowOpen(conv) || inboundOpen,
    conn: connection
      ? { phoneNumberId: connection.phoneNumberId, accessToken: connection.accessToken, accountId: connection.accountId, wabaId: connection.wabaId }
      : null,
    settings,
  };
}

/**
 * Walk the graph from the run's current node until it waits, ends or fails.
 * `inbound` is the customer's reply when the run was waiting for one.
 */
type AdvanceOpts = {
  woke?: boolean;
  paid?: boolean;
  fromCustomer?: boolean;
  /** The run's surroundings, already being read alongside the claim/insert. */
  env?: Promise<Env>;
  /** Awaited before anything is sent (the webhook's window write). */
  ready?: Promise<unknown>;
  timer?: ReplyTimer;
};

async function advance(
  supabase: SupabaseClient,
  run: Run,
  graph: FlowGraph,
  inbound: Inbound | null,
  opts: AdvanceOpts = {},
): Promise<void> {
  const own = !eventBuffers.has(run.id);
  if (own) eventBuffers.set(run.id, []);
  try {
    await advanceInner(supabase, run, graph, inbound, opts);
  } finally {
    if (own) await flushEvents(supabase, run.id);
  }
}

async function advanceInner(
  supabase: SupabaseClient,
  run: Run,
  graph: FlowGraph,
  inbound: Inbound | null,
  opts: AdvanceOpts,
): Promise<void> {
  const env = opts.env ? await opts.env : await loadEnv(supabase, run);
  // Nothing below sends before the webhook's window write has landed.
  if (opts.ready) await opts.ready;
  if (opts.timer) {
    env.timer = opts.timer;
    opts.timer.mark("flow_env");
  }
  // Variables always come from the run itself (a read started earlier may
  // predate the reply just recorded on it).
  env.ctx.vars = run.variables ?? {};
  const vars = env.ctx.vars;
  const visits = new Map<string, number>();
  let nodeId = run.current_node_id;
  let steps = run.steps;
  let reply = inbound;
  let woke = Boolean(opts.woke);
  // This whole advance answers a message the customer just sent, so quiet
  // hours don't apply to any node it reaches.
  const fromInbound = Boolean(inbound) || Boolean(opts.fromCustomer);

  const save = async (patch: Record<string, unknown>) => {
    await supabase
      .from("flow_runs")
      .update({ current_node_id: nodeId, variables: vars, steps, claimed_at: null, ...patch })
      .eq("id", run.id);
  };
  const finish = async (status: "done" | "failed" | "cancelled" | "expired", event: string, detail: Record<string, unknown> = {}) => {
    await save({ status, wake_at: null, waiting_for: null, ended_at: new Date().toISOString(), ...(status === "failed" ? { last_error: String(detail["error"] ?? event) } : {}) });
    await logEvent(supabase, run, nodeId, event, detail);
    if (status === "done" && graph.meta?.on_finish) await runOnFinish(supabase, run, graph.meta.on_finish, { ...env.ctx, vars });
  };
  const waitFor = async (kind: "reply" | "timer" | "payment", minutes: number) => {
    await save({ status: "waiting", waiting_for: kind, wake_at: new Date(Date.now() + minutes * 60_000).toISOString() });
  };
  /** Move along an output; false when the output isn't connected (run ends). */
  const follow = async (node: FlowNode, handle: string): Promise<boolean> => {
    const edge = edgeFrom(graph, node.id, handle);
    await logEvent(supabase, run, node.id, "exited", { handle });
    if (!edge) {
      await finish("done", "ended", { reason: `no_path:${handle}` });
      return false;
    }
    nodeId = edge.target;
    return true;
  };
  const attemptOf = (id: string) => Number((vars["_attempts"] as Record<string, number> | undefined)?.[id] ?? 0);
  const bumpAttempt = (id: string) => {
    const a = { ...((vars["_attempts"] as Record<string, number> | undefined) ?? {}) };
    a[id] = (a[id] ?? 0) + 1;
    vars["_attempts"] = a;
  };

  if (env.optedOut) {
    await finish("cancelled", "opted_out");
    return;
  }

  for (;;) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      await finish("failed", "failed", { error: "missing_node" });
      return;
    }
    steps += 1;
    if (steps > MAX_STEPS_PER_RUN) {
      await finish("failed", "failed", { error: "step_limit" });
      return;
    }
    const seen = (visits.get(node.id) ?? 0) + 1;
    visits.set(node.id, seen);
    if (seen > MAX_VISITS_PER_ADVANCE) {
      await finish("failed", "failed", { error: "loop_detected" });
      return;
    }
    const d = node.data;
    if (node.type !== "start") env.timer?.mark("first_node");
    const waitingHere = run.status === "waiting" && run.current_node_id === node.id && seen === 1;
    const awaitingReply = waitingHere && run.waiting_for === "reply";
    const payWaiting = waitingHere && run.waiting_for === "payment";
    if (!waitingHere) await logEvent(supabase, run, node.id, "entered", { type: node.type });

    const needsWindow = ["text", "buttons", "list", "ask", "form", "cta_url", "location_request", "location_send", "contact_card", "carousel", "payment", "show_products"].includes(node.type);
    // A Send card step needs the window too, but handles a closed one itself (its failed path).
    const sendsMessage = needsWindow || node.type === "template" || node.type === "send_card";

    // Quiet hours hold proactive sends (not replies to a message just received).
    if (sendsMessage && !awaitingReply && !payWaiting && !fromInbound && !woke && env.settings.quietHoursEnabled) {
      const { applyQuietHours } = await import("@/lib/flows.server");
      const at = applyQuietHours(new Date(), env.settings, "transactional");
      if (at.getTime() > Date.now() + 60_000) {
        await save({ status: "waiting", waiting_for: "timer", wake_at: at.toISOString() });
        await logEvent(supabase, run, node.id, "quiet_hours", { until: at.toISOString() });
        // Re-enter this node on wake.
        run.status = "running";
        return;
      }
    }
    if (needsWindow && !awaitingReply && !payWaiting && !env.windowOpen) {
      await logEvent(supabase, run, node.id, "window_closed");
      if (!(await follow(node, "window_closed"))) return;
      continue;
    }
    if (sendsMessage && !awaitingReply && !payWaiting && !env.conn) {
      await finish("failed", "failed", { error: "no_connected_number" });
      return;
    }

    // ---- nodes that wait for the customer ----
    if (sendsMessage && !awaitingReply && !payWaiting && Number(d["typing_seconds"] ?? 0) > 0) {
      // Typing delay: a short, human pause before the message (capped at 5 s).
      await new Promise((r) => setTimeout(r, Math.min(Number(d["typing_seconds"]), 5) * 1000));
    }

    if (node.type === "buttons" || node.type === "list" || node.type === "ask" || node.type === "location_request") {
      const timeoutMin = Number(d["timeout_minutes"] ?? DEFAULT_REPLY_TIMEOUT_MIN);
      const nudgeMin = Number(d["nudge_minutes"] ?? 0);
      const nudgeText = String(d["nudge_text"] ?? "").trim();
      const nudged = () => Boolean((vars["_nudged"] as Record<string, boolean> | undefined)?.[node.id]);
      if (!awaitingReply) {
        bumpAttempt(node.id);
        if (vars["_nudged"]) vars["_nudged"] = { ...(vars["_nudged"] as Record<string, boolean>), [node.id]: false };
        const ok = await sendPrompt(supabase, run, env, node, `${run.id}:${node.id}:${attemptOf(node.id)}`);
        if (!ok.ok) {
          await finish("failed", "failed", { error: ok.error ?? "send_failed" });
          return;
        }
        await waitFor("reply", nudgeMin > 0 && nudgeText && nudgeMin < timeoutMin ? nudgeMin : timeoutMin);
        return;
      }
      // Quiet customer: one reminder, then wait out the rest before the timeout path.
      if (woke && !reply && nudgeMin > 0 && nudgeText && nudgeMin < timeoutMin && !nudged()) {
        vars["_nudged"] = { ...((vars["_nudged"] as Record<string, boolean> | undefined) ?? {}), [node.id]: true };
        if (env.windowOpen && env.conn && (await logEvent(supabase, run, node.id, "nudge", {}, `${run.id}:${node.id}:nudge:${attemptOf(node.id)}`))) {
          const { sendServiceText } = await import("@/lib/service-text.server");
          await sendServiceText(supabase, {
            organizationId: run.organization_id,
            phoneNumberId: env.conn.phoneNumberId,
            accessToken: env.conn.accessToken,
            conversationId: run.conversation_id!,
            to: env.to,
            body: interpolate(nudgeText, { ...env.ctx, vars }),
            windowOpen: env.windowOpen,
            metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id },
          });
        }
        await waitFor("reply", timeoutMin - nudgeMin);
        return;
      }
      // Timer woke us: the reply never came.
      if (woke && !reply) {
        await logEvent(supabase, run, node.id, "timeout");
        woke = false;
        run.status = "running";
        if (!(await follow(node, "timeout"))) return;
        continue;
      }
      if (!reply) return;
      const answer = matchReply(node, reply);
      reply = null;
      run.status = "running";
      if (answer.ok) {
        vars["last_answer"] = answer.value;
        const variable = String(d["variable"] ?? "").trim();
        if (variable) vars[variable] = answer.value;
        if (!(await follow(node, answer.handle))) return;
        continue;
      }
      // Unexpected reply.
      const retries = Number(d["retries"] ?? 2);
      const mode = String(d["on_unexpected"] ?? "repeat");
      if (mode === "team") {
        await markNeedsYou(supabase, run, "Customer replied something the flow didn't expect.");
        await finish("done", "handed_to_team");
        return;
      }
      if (mode === "path") {
        if (!(await follow(node, "invalid"))) return;
        continue;
      }
      if (attemptOf(node.id) > retries) {
        if (!(await follow(node, "invalid"))) return;
        continue;
      }
      if (!env.conn) {
        await finish("failed", "failed", { error: "no_connected_number" });
        return;
      }
      bumpAttempt(node.id);
      const retryText = String(d["retry_text"] ?? "").trim();
      const ok = await sendPrompt(supabase, run, env, node, `${run.id}:${node.id}:${attemptOf(node.id)}`, retryText || null);
      if (!ok.ok) {
        await finish("failed", "failed", { error: ok.error ?? "send_failed" });
        return;
      }
      await waitFor("reply", timeoutMin);
      return;
    }

    switch (node.type) {
      case "start":
        break;
      case "end":
        await finish("done", "ended");
        return;
      case "wait": {
        if (waitingHere && woke && run.waiting_for === "timer") {
          woke = false;
          run.status = "running";
          break;
        }
        const minutes = Math.max(Number(d["minutes"] ?? 0), 0);
        if (minutes > 0) {
          await waitFor("timer", minutes);
          return;
        }
        break;
      }
      case "text": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const { sendServiceText, sendServiceImage } = await import("@/lib/service-text.server");
          const message = {
            organizationId: run.organization_id,
            phoneNumberId: env.conn!.phoneNumberId,
            accessToken: env.conn!.accessToken,
            conversationId: run.conversation_id!,
            to: env.to,
            windowOpen: env.windowOpen,
            ...(env.timer ? { timer: env.timer } : {}),
            metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id },
          };
          const body = interpolate(String(d["text"] ?? ""), env.ctx);
          // With a picture, the message goes out as that picture with the words as its caption.
          const imageUrl = String(d["image_url"] ?? "").trim();
          const res = imageUrl
            ? await sendServiceImage(supabase, { ...message, imageUrl, caption: body })
            : await sendServiceText(supabase, { ...message, body });
          if (!res.ok) {
            await finish("failed", "failed", { error: res.error ?? "send_failed" });
            return;
          }
        }
        break;
      }
      case "template": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const res = await sendTemplate(supabase, run, env, String(d["template_id"] ?? ""), (d["variables"] as string[] | undefined) ?? []);
          if (res.error) {
            await finish("failed", "failed", { error: res.error });
            return;
          }
          // Opted out since the run started: stop, exactly as at run start.
          if (res.skipped === "opted_out") {
            await finish("cancelled", "opted_out");
            return;
          }
          // Marketing without opt-in is never sent; the flow carries on.
          if (res.skipped) await logEvent(supabase, run, node.id, "template_skipped", { reason: res.skipped });
        }
        break;
      }
      case "form": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const { sendFormMessage } = await import("@/lib/wa-forms.server");
          const res = await sendFormMessage(supabase, {
            organizationId: run.organization_id,
            conversationId: run.conversation_id!,
            formId: String(d["form_id"] ?? ""),
            source: "flow",
          });
          if (!res.ok) {
            await finish("failed", "failed", { error: res.error ?? "send_failed" });
            return;
          }
        }
        break;
      }
      case "branch": {
        const handle = pickBranch((d["branches"] as Branch[] | undefined) ?? [], { ...env.ctx, vars, businessHours: graph.meta?.business_hours });
        if (!(await follow(node, handle))) return;
        continue;
      }
      case "tag": {
        // A plain name goes exactly as before; {{variables}} are filled in, and
        // a tag that comes out empty is skipped (noted, never an error).
        const tag = tagOfNode(d, { ...env.ctx, vars });
        if (String(d["tag"] ?? "").includes("{{") && !tag) await logEvent(supabase, run, node.id, "tag_skipped", { reason: "empty_after_variables" });
        else await applyTag(supabase, run, tag, d["action"] === "remove" ? "remove" : "add");
        break;
      }
      case "set_field": {
        const field = String(d["field"] ?? "").trim();
        if (field) {
          const value = interpolate(String(d["value"] ?? ""), { ...env.ctx, vars });
          if (field === "name") await supabase.from("contacts").update({ name: value }).eq("id", run.contact_id);
          else {
            // Merge one key in the database — never rewrite from a snapshot.
            const { error } = await supabase.rpc("flow_merge_contact_attribute", {
              p_contact_id: run.contact_id,
              p_organization_id: run.organization_id,
              p_key: field,
              p_value: value,
            });
            if (error) throw new Error(`set_field_failed:${error.message}`);
          }
          env.ctx.contact.attributes[field] = value;
        }
        break;
      }
      case "assign":
        if (run.conversation_id) {
          const userId = d["mode"] === "round_robin" ? await pickRoundRobin(supabase, run.organization_id) : String(d["user_id"] ?? "").trim();
          await supabase
            .from("conversations")
            .update(userId ? { assigned_to: userId } : { needs_human: true, needs_human_reason: "flow_assign", needs_human_at: new Date().toISOString() })
            .eq("id", run.conversation_id);
          // Batch 16: a hand-off to the team (no one picked) alerts the staff.
          // Fire-and-forget: the alert never holds or changes the run.
          if (!userId) {
            const conversationId = run.conversation_id;
            void import("@/lib/handoff-alerts.server")
              .then(({ sendHandoffAlert }) => sendHandoffAlert(supabase, { organizationId: run.organization_id, conversationId, reason: "flow_assign" }))
              .catch(() => {});
          }
        }
        break;
      case "needs_you":
        await markNeedsYou(supabase, run, String(d["note"] ?? "A flow asked for a person."));
        break;
      case "cta_url":
      case "location_send":
      case "contact_card": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const { sendServiceRich } = await import("@/lib/service-text.server");
          const c = { ...env.ctx, vars };
          const res = await sendServiceRich(supabase, {
            organizationId: run.organization_id,
            phoneNumberId: env.conn!.phoneNumberId,
            accessToken: env.conn!.accessToken,
            conversationId: run.conversation_id!,
            to: env.to,
            kind: node.type === "cta_url" ? "cta_url" : node.type === "location_send" ? "location" : "contact",
            body: interpolate(String(d["text"] ?? ""), c),
            buttonText: interpolate(String(d["button_text"] ?? "Open"), c),
            url: interpolate(String(d["url"] ?? ""), c),
            latitude: Number(d["latitude"]),
            longitude: Number(d["longitude"]),
            name: interpolate(String(d["name"] ?? ""), c),
            address: interpolate(String(d["address"] ?? ""), c),
            phone: String(d["phone"] ?? ""),
            ...(env.timer ? { timer: env.timer } : {}),
          });
          if (!res.ok) {
            await finish("failed", "failed", { error: res.error ?? "send_failed" });
            return;
          }
        }
        break;
      }
      case "carousel": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const ids = ((d["retailer_ids"] as string[] | undefined) ?? []).slice(0, 10);
          const titles = (d["titles"] as Record<string, string> | undefined) ?? {};
          const { sendCatalogProducts } = await import("@/lib/whatsapp-catalog.server");
          const res = await sendCatalogProducts(supabase, {
            organizationId: run.organization_id,
            conversationId: run.conversation_id!,
            phoneNumberId: env.conn!.phoneNumberId,
            accessToken: env.conn!.accessToken,
            to: env.to,
            items: ids.map((id) => ({ retailerId: id, title: titles[id] ?? id, category: null, inCatalog: true })),
          });
          if (res.error || res.sent === 0) {
            await finish("failed", "failed", { error: res.error ?? "catalogue_not_ready" });
            return;
          }
        }
        break;
      }
      case "show_products": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        // Already sent on an earlier pass: carry on as if products were found.
        let handle = "found";
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const { showProducts } = await import("@/lib/flow-products.server");
          const res = await showProducts(supabase, {
            organizationId: run.organization_id,
            contactId: run.contact_id,
            conversationId: run.conversation_id!,
            to: env.to,
            phoneNumberId: env.conn!.phoneNumberId,
            accessToken: env.conn!.accessToken,
            windowOpen: env.windowOpen,
            ...(env.timer ? { timer: env.timer } : {}),
            metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id },
            query: productQueryOf(d, { ...env.ctx, vars }),
          });
          if (!res.ok) {
            await finish("failed", "failed", { error: res.error ?? "send_failed" });
            return;
          }
          handle = res.found ? "found" : "none";
          await logEvent(supabase, run, node.id, "products_shown", { found: res.found, shown: res.shown });
        }
        if (!(await follow(node, handle))) return;
        continue;
      }
      case "send_card": {
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        // Already sent on an earlier pass: carry on as if it went.
        let handle = "next";
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const c = { ...env.ctx, vars };
          const card = cardOfNode(d, c);
          const fallback = interpolate(String(d["fallback_text"] ?? ""), c);
          let res: { card: boolean; fallback: boolean; reason?: string };
          if (!env.windowOpen) res = { card: false, fallback: false, reason: "window_closed" };
          else if (!card) res = { card: false, fallback: false, reason: "no_design" };
          else {
            // Cards off for the workspace: never a card, only the plain fallback.
            const cards = await import("@/lib/customer-cards.server");
            const cardsOn = await cards.cardsEnabled(supabase, run.organization_id).catch(() => false);
            res = await cards.sendCardOrFallback(supabase, {
              organizationId: run.organization_id,
              contactId: run.contact_id,
              conversationId: run.conversation_id!,
              phone: env.to,
              sender: { phoneNumberId: env.conn!.phoneNumberId, accessToken: env.conn!.accessToken },
              kind: card.kind,
              vars: card.vars,
              caption: interpolate(String(d["caption"] ?? ""), c),
              fallback,
              cardsOn,
              windowOpen: env.windowOpen,
              metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id },
            });
          }
          await logEvent(supabase, run, node.id, res.card ? "card_sent" : "card_failed", res.card ? {} : { reason: res.reason ?? null, fallback_sent: res.fallback });
          // A card that didn't go takes the failed path when it's connected; otherwise the flow carries on.
          if (!res.card && edgeFrom(graph, node.id, "failed")) handle = "failed";
        }
        if (!(await follow(node, handle))) return;
        continue;
      }
      case "set_variable": {
        const name = String(d["variable"] ?? "").trim();
        if (name) {
          const v = computeVariable({ mode: String(d["mode"] ?? "value"), expression: String(d["expression"] ?? "") }, { ...env.ctx, vars });
          vars[name] = v ?? "";
        }
        break;
      }
      case "business_hours": {
        const open = isBusinessOpen(graph.meta?.business_hours, new Date(), env.ctx.timezone);
        if (!(await follow(node, open ? "open" : "closed"))) return;
        continue;
      }
      case "ab_split": {
        const pa = Math.min(Math.max(Number(d["percent_a"] ?? 50), 0), 100);
        const side = Math.random() * 100 < pa ? "a" : "b";
        vars[`_ab_${node.id}`] = side;
        if (!(await follow(node, side))) return;
        continue;
      }
      case "goto_flow": {
        // Flows that hand over to each other in a circle stop after
        // MAX_GOTO_HOPS hand-overs instead of running for ever.
        const hops = await gotoHops(supabase, run.id);
        if (hops >= MAX_GOTO_HOPS) {
          await finish("failed", "failed", { error: "goto_limit", hops, flow_id: d["flow_id"] });
          return;
        }
        await logEvent(supabase, run, node.id, "exited", { handle: "goto" });
        await finish("done", "ended", { reason: "goto_flow", flow_id: d["flow_id"] });
        await startRun(supabase, {
          organizationId: run.organization_id,
          flowId: String(d["flow_id"] ?? ""),
          contactId: run.contact_id,
          conversationId: run.conversation_id,
          trigger: { kind: "goto_flow", from_run: run.id, hops: hops + 1 },
        });
        return;
      }
      case "internal_note":
        await logEvent(supabase, run, node.id, "note", { text: interpolate(String(d["text"] ?? ""), { ...env.ctx, vars }).slice(0, 500) });
        break;
      case "close_chat":
        if (run.conversation_id) await supabase.from("conversations").update({ status: "closed" }).eq("id", run.conversation_id).eq("organization_id", run.organization_id);
        await finish("done", "ended", { reason: "closed_chat" });
        return;
      case "opt": {
        const out = d["action"] === "out";
        await supabase.from("contacts").update({ opt_in_status: out ? "opted_out" : "opted_in", updated_at: new Date().toISOString() }).eq("id", run.contact_id).eq("organization_id", run.organization_id);
        if (out) {
          await finish("cancelled", "opted_out", { by: "flow" });
          return;
        }
        break;
      }
      case "segment":
        await applyTag(supabase, run, `Segment: ${String(d["segment_name"] ?? "").trim()}`, d["action"] === "remove" ? "remove" : "add");
        break;
      case "note":
        break;
      case "sheets_append": {
        const { appendSheetRow } = await import("@/lib/flow-connections.server");
        const values = ((d["columns"] as string[] | undefined) ?? []).map((c) => interpolate(String(c ?? ""), { ...env.ctx, vars }));
        const res = await appendSheetRow(supabase, run.organization_id, { sheet: String(d["sheet"] ?? ""), tab: String(d["tab"] ?? ""), values });
        await logEvent(supabase, run, node.id, res.ok ? "sheet_row_added" : "sheet_failed", res.ok ? {} : { error: res.error });
        if (!res.ok) {
          if (!(await follow(node, edgeFrom(graph, node.id, "failed") ? "failed" : "next"))) return;
          continue;
        }
        break;
      }
      case "payment": {
        if (payWaiting) {
          if (opts.paid) {
            opts.paid = false;
            vars["payment_status"] = "paid";
            run.status = "running";
            await logEvent(supabase, run, node.id, "paid");
            if (!(await follow(node, "paid"))) return;
            continue;
          }
          if (woke) {
            woke = false;
            vars["payment_status"] = "not_paid";
            run.status = "running";
            await logEvent(supabase, run, node.id, "not_paid");
            if (!(await follow(node, "not_paid"))) return;
            continue;
          }
          return;
        }
        bumpAttempt(node.id);
        const key = `${run.id}:${node.id}:${attemptOf(node.id)}`;
        const hours = Math.min(Math.max(Number(d["wait_hours"] ?? 24), 1), 24 * 13);
        if (await logEvent(supabase, run, node.id, "send", {}, key)) {
          const amount = Number(interpolate(String(d["amount"] ?? ""), { ...env.ctx, vars }).replace(/[^\d.]/g, ""));
          const { createPaymentLink } = await import("@/lib/flow-connections.server");
          const link = await createPaymentLink(supabase, run.organization_id, {
            amountRupees: amount,
            description: interpolate(String(d["description"] ?? "Payment"), { ...env.ctx, vars }),
            name: env.ctx.contact.name,
            phone: env.to,
            expireHours: hours,
            runId: run.id,
            nodeId: node.id,
          });
          if ("error" in link) {
            await finish("failed", "failed", { error: link.error });
            return;
          }
          vars["payment_link"] = link.url;
          const { sendServiceText } = await import("@/lib/service-text.server");
          const res = await sendServiceText(supabase, {
            organizationId: run.organization_id,
            phoneNumberId: env.conn!.phoneNumberId,
            accessToken: env.conn!.accessToken,
            conversationId: run.conversation_id!,
            to: env.to,
            body: `${interpolate(String(d["text"] ?? "Here's your payment link:"), { ...env.ctx, vars })}\n${link.url}`,
            windowOpen: env.windowOpen,
            metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id },
          });
          if (!res.ok) {
            await finish("failed", "failed", { error: res.error ?? "send_failed" });
            return;
          }
        }
        await waitFor("payment", hours * 60);
        return;
      }
      case "http": {
        const { runHttpRequest, loadHttpSecrets } = await import("@/lib/flow-http.server");
        const res = await runHttpRequest(await loadHttpSecrets(supabase, run.organization_id, d), { ...env.ctx, vars });
        Object.assign(vars, res.saved);
        vars["http_status"] = res.status == null ? "" : String(res.status);
        await logEvent(supabase, run, node.id, res.ok ? "http_ok" : "http_failed", { status: res.status, error: res.error, saved: Object.keys(res.saved) });
        if (!(await follow(node, res.ok ? "success" : "failed"))) return;
        continue;
      }
      case "email_team": {
        const c = { ...env.ctx, vars };
        const { recipients: addresses, dropped } = await emailTeamRecipients(supabase, run.organization_id, d);
        const { sendEmail } = await import("@/lib/email.server");
        const subject = interpolate(String(d["subject"] ?? "From your chat flow"), c).slice(0, 200);
        const bodyText = interpolate(String(d["body"] ?? ""), c).slice(0, 5000);
        let sent = 0;
        let lastError: string | null = null;
        for (const to of addresses) {
          const r = await sendEmail({ to, subject, body: bodyText });
          if (r.ok) sent += 1;
          else lastError = r.error ?? "email_failed";
        }
        // Recipients are counted, never listed, in the run log.
        await logEvent(supabase, run, node.id, sent ? "email_sent" : "email_failed", { recipients: addresses.length, sent, dropped, error: lastError ?? (addresses.length ? null : "no_allowed_recipients") });
        if (!sent) {
          if (!(await follow(node, edgeFrom(graph, node.id, "failed") ? "failed" : "next"))) return;
          continue;
        }
        break;
      }
      case "wait_until": {
        if (waitingHere && woke && run.waiting_for === "timer") {
          woke = false;
          run.status = "running";
          break;
        }
        const { parseWaitDate } = await import("@/lib/flow-graph");
        const c = { ...env.ctx, vars };
        const raw = d["mode"] === "field" ? interpolate(`{{${String(d["field"] ?? "").trim()}}}`, c) : interpolate(String(d["date"] ?? ""), c);
        const target = parseWaitDate(raw, env.ctx.timezone);
        if (!target) {
          await logEvent(supabase, run, node.id, "wait_until_skipped", { reason: "unreadable_date" });
          break;
        }
        const minutes = Math.ceil((target.getTime() - Date.now()) / 60_000);
        if (minutes <= 0) {
          await logEvent(supabase, run, node.id, "wait_until_skipped", { reason: "date_passed" });
          break;
        }
        await logEvent(supabase, run, node.id, "wait_until", { until: target.toISOString() });
        await waitFor("timer", minutes);
        return;
      }
      case "order_draft": {
        const c = { ...env.ctx, vars };
        const totalRaw = interpolate(String(d["total"] ?? ""), c).replace(/[^\d.]/g, "");
        const { data: draft, error } = await supabase
          .from("flow_order_drafts")
          .insert({
            organization_id: run.organization_id,
            flow_id: run.flow_id,
            run_id: run.id,
            contact_id: run.contact_id,
            conversation_id: run.conversation_id,
            items: interpolate(String(d["items"] ?? ""), c).slice(0, 2000),
            total: totalRaw && Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null,
            notes: interpolate(String(d["notes"] ?? ""), c).slice(0, 2000),
          })
          .select("id")
          .single();
        if (error || !draft) throw new Error(`order_draft_failed:${error?.message ?? ""}`);
        vars["order_draft_id"] = (draft as { id: string }).id;
        await logEvent(supabase, run, node.id, "order_draft_created", { id: (draft as { id: string }).id });
        if (d["needs_you"] !== false) await markNeedsYou(supabase, run, "New order draft from a chat flow — please confirm it.");
        break;
      }
      default:
        await finish("failed", "failed", { error: `unknown_node:${node.type}` });
        return;
    }
    if (!(await follow(node, "next"))) return;
  }
}

function matchReply(node: FlowNode, reply: Inbound): { ok: true; value: string; handle: string } | { ok: false } {
  const d = node.data;
  if (node.type === "location_request") {
    const v = reply.body.trim();
    return v ? { ok: true, value: v, handle: "next" } : { ok: false };
  }
  if (node.type === "ask") {
    const v = validateAnswer(d["validation"] as ValidationKind | undefined, reply.body);
    return v == null ? { ok: false } : { ok: true, value: v, handle: "next" };
  }
  const options = ((node.type === "buttons" ? d["buttons"] : d["rows"]) as Array<{ id: string; title: string }> | undefined) ?? [];
  const byId = reply.replyId ? options.find((o) => `${node.id}:${o.id}` === reply.replyId || o.id === reply.replyId) : null;
  const typed = reply.body.trim().toLowerCase();
  const hit = byId ?? options.find((o) => o.title.trim().toLowerCase() === typed) ?? (/^\d+$/.test(typed) ? options[Number(typed) - 1] : undefined);
  return hit ? { ok: true, value: hit.title, handle: hit.id } : { ok: false };
}

async function sendPrompt(
  supabase: SupabaseClient,
  run: Run,
  env: Env,
  node: FlowNode,
  key: string,
  override: string | null = null,
): Promise<{ ok: boolean; error: string | null }> {
  if (!(await logEvent(supabase, run, node.id, "send", {}, key))) return { ok: true, error: null };
  const d = node.data;
  const text = interpolate(override ?? String(d["text"] ?? ""), env.ctx);
  const svc = await import("@/lib/service-text.server");
  const base = {
    organizationId: run.organization_id,
    phoneNumberId: env.conn!.phoneNumberId,
    accessToken: env.conn!.accessToken,
    conversationId: run.conversation_id!,
    to: env.to,
    body: text,
    windowOpen: env.windowOpen,
    ...(env.timer ? { timer: env.timer } : {}),
  };
  if (node.type === "location_request") {
    const r = await svc.sendServiceRich(supabase, { ...base, kind: "location_request" });
    return { ok: r.ok, error: r.error };
  }
  if (node.type === "buttons") {
    const buttons = ((d["buttons"] as Array<{ id: string; title: string }> | undefined) ?? []).map((b) => ({
      id: `${node.id}:${b.id}`,
      title: interpolate(b.title, env.ctx).slice(0, 20),
    }));
    const imageUrl = String(d["image_url"] ?? "").trim();
    const r = await svc.sendServiceButtons(supabase, { ...base, buttons, ...(imageUrl ? { imageUrl } : {}) });
    return { ok: r.ok, error: r.error };
  }
  if (node.type === "list") {
    const rows = ((d["rows"] as Array<{ id: string; title: string; description?: string }> | undefined) ?? []).map((r) => ({
      id: `${node.id}:${r.id}`,
      title: interpolate(r.title, env.ctx),
      ...(r.description ? { description: r.description } : {}),
    }));
    const r = await svc.sendServiceList(supabase, { ...base, buttonText: String(d["button_text"] ?? "Choose"), rows });
    return { ok: r.ok, error: r.error };
  }
  const r = await svc.sendServiceText(supabase, { ...base, metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id } });
  return { ok: r.ok, error: r.error };
}

/** A MARKETING template may only go to a contact who opted in (same rule as campaigns). */
export function marketingAllowed(category: string | null | undefined, optedIn: boolean): boolean {
  return String(category ?? "").toUpperCase() !== "MARKETING" || optedIn;
}

export async function sendTemplate(
  supabase: SupabaseClient,
  run: Run,
  env: Env,
  templateId: string,
  variableSources: string[],
): Promise<{ error: string | null; skipped?: string }> {
  const { data: template } = await supabase
    .from("message_templates")
    .select("name, language, category, status, components")
    .eq("id", templateId)
    .eq("organization_id", run.organization_id)
    .maybeSingle();
  const t = template as { name: string; language: string | null; category: string | null; status: string; components: unknown } | null;
  if (!t) return { error: "template_missing" };
  if (String(t.status).toUpperCase() !== "APPROVED") return { error: "template_not_approved" };
  if (!marketingAllowed(t.category, env.optedIn)) return { error: null, skipped: "not_opted_in" };
  // Re-read at send time: the customer may have opted out since the run loaded.
  const { contactOptedOut } = await import("@/lib/opt-out.server");
  const optOut = await contactOptedOut(supabase, run.organization_id, {
    contactId: run.contact_id,
    phone: env.ctx.contact.phone,
  });
  if (optOut.error) return { error: "opt_out_check_failed" };
  if (optOut.optedOut) return { error: null, skipped: "opted_out" };
  const { loadSenderContext, sendCampaignTemplate } = await import("@/lib/campaigns.server");
  const { extractVariables, templateBodyText } = await import("@/lib/templates");
  const sender = await loadSenderContext(supabase, run.organization_id, env.conn?.accountId ?? null);
  if (!sender) return { error: "no_connected_number" };
  const order = extractVariables(templateBodyText((t.components ?? []) as never));
  const variables: Record<string, string> = {};
  order.forEach((n, i) => {
    variables[String(n)] = interpolate(variableSources[i] ?? (i === 0 ? "{{name}}" : ""), env.ctx) || "-";
  });
  const outcome = await sendCampaignTemplate(
    supabase,
    run.organization_id,
    sender,
    { contactId: run.contact_id, phone: env.ctx.contact.phone, variables },
    { name: t.name, language: t.language || "en_US", variableOrder: order, components: (t.components ?? []) as never },
    { campaignId: null, category: String(t.category ?? "utility").toLowerCase(), flowId: run.flow_id },
  );
  return { error: outcome.error };
}

/** Most people one "Email the team" step may email. */
export const MAX_EMAIL_RECIPIENTS = 5;

/**
 * Who an "Email the team" step may email: only people who are members of this
 * workspace — picked teammates, or typed addresses that belong to a member.
 * Anything else is dropped (counted in the run log, never listed). At most 5.
 */
export async function emailTeamRecipients(
  supabase: SupabaseClient,
  organizationId: string,
  d: Record<string, unknown>,
): Promise<{ recipients: string[]; dropped: number }> {
  const userIds = ((d["user_ids"] as string[] | undefined) ?? []).filter(Boolean);
  const typed = [...new Set(String(d["addresses"] ?? "").split(/[,\s]+/).map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@")))];
  const { data: members } = await supabase.from("organization_members").select("user_id").eq("organization_id", organizationId);
  const memberIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  const { data: profs } = memberIds.length ? await supabase.from("profiles").select("id, email").in("id", memberIds) : { data: [] };
  const emailOf = new Map(((profs ?? []) as Array<{ id: string; email: string | null }>).filter((p) => p.email).map((p) => [p.id, p.email!.toLowerCase()]));
  const memberEmails = new Set(emailOf.values());
  const out = new Set<string>();
  let dropped = 0;
  for (const id of userIds) {
    const e = emailOf.get(id);
    if (e) out.add(e);
    else dropped += 1;
  }
  for (const a of typed) {
    if (memberEmails.has(a)) out.add(a);
    else dropped += 1;
  }
  const all = [...out];
  return { recipients: all.slice(0, MAX_EMAIL_RECIPIENTS), dropped: dropped + Math.max(0, all.length - MAX_EMAIL_RECIPIENTS) };
}

async function applyTag(supabase: SupabaseClient, run: Run, name: string, action: "add" | "remove") {
  const tagName = name.trim();
  if (!tagName) return;
  // Exact name, case-insensitive: escape LIKE wildcards so "50%" or "a_b"
  // never match other tags.
  const exact = tagName.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const { data: tagRows } = await supabase
    .from("tags")
    .select("id")
    .eq("organization_id", run.organization_id)
    .ilike("name", exact)
    .limit(1);
  let tag = ((tagRows ?? []) as Array<{ id: string }>)[0] ?? null;
  if (!tag && action === "add") {
    const { data: created } = await supabase
      .from("tags")
      .insert({ organization_id: run.organization_id, name: tagName })
      .select("id")
      .single();
    tag = created;
  }
  const tagId = (tag as { id: string } | null)?.id;
  if (!tagId) return;
  if (action === "add") {
    await supabase
      .from("contact_tags")
      .upsert({ organization_id: run.organization_id, contact_id: run.contact_id, tag_id: tagId }, { onConflict: "contact_id,tag_id", ignoreDuplicates: true });
    // "Tag added" triggers — the one-active-run-per-flow guard stops loops.
    try {
      const { dispatchTagAdded } = await import("@/lib/flow-triggers.server");
      await dispatchTagAdded(supabase, { organizationId: run.organization_id, contactId: run.contact_id, tag: tagName });
    } catch {
      // a trigger problem must never break the running flow
    }
  } else {
    await supabase.from("contact_tags").delete().eq("contact_id", run.contact_id).eq("tag_id", tagId);
  }
}

async function markNeedsYou(supabase: SupabaseClient, run: Run, note: string) {
  if (!run.conversation_id) return;
  await supabase
    .from("conversations")
    .update({ needs_human: true, needs_human_reason: "flow", needs_human_question: note.slice(0, 300), needs_human_at: new Date().toISOString() })
    .eq("id", run.conversation_id);
}

/** Next teammate in turn: whoever has the fewest open chats assigned right now. */
async function pickRoundRobin(supabase: SupabaseClient, organizationId: string): Promise<string> {
  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .in("role", ["owner", "admin", "agent", "marketer"])
    .order("user_id");
  const ids = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (!ids.length) return "";
  const { data: open } = await supabase
    .from("conversations")
    .select("assigned_to")
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .in("assigned_to", ids);
  const load = new Map(ids.map((id) => [id, 0]));
  for (const r of (open ?? []) as Array<{ assigned_to: string }>) load.set(r.assigned_to, (load.get(r.assigned_to) ?? 0) + 1);
  return [...load.entries()].sort((a, b) => a[1] - b[1])[0]![0];
}

async function runOnFinish(
  supabase: SupabaseClient,
  run: Run,
  onFinish: NonNullable<FlowGraph["meta"]>["on_finish"],
  ctx: RunContext,
) {
  if (!onFinish) return;
  if (onFinish.tag?.trim()) await applyTag(supabase, run, onFinish.tag, "add");
  if (onFinish.needs_you?.trim()) await markNeedsYou(supabase, run, interpolate(onFinish.needs_you, ctx));
  if (onFinish.close_chat && run.conversation_id)
    await supabase.from("conversations").update({ status: "closed" }).eq("id", run.conversation_id).eq("organization_id", run.organization_id);
}

/** The merchant's Razorpay says the flow's payment link was paid. */
export async function resumePaidRun(
  supabase: SupabaseClient,
  args: { organizationId: string; runId: string; nodeId: string; paymentLinkId: string },
): Promise<boolean> {
  const { data } = await supabase
    .from("flow_runs")
    .select(RUN_COLUMNS)
    .eq("id", args.runId)
    .eq("organization_id", args.organizationId)
    .eq("status", "waiting")
    .eq("waiting_for", "payment")
    .eq("current_node_id", args.nodeId)
    .maybeSingle();
  const run = data as Run | null;
  if (!run) return false;
  if (!(await logEvent(supabase, run, args.nodeId, "payment_webhook", { link: args.paymentLinkId }, `${run.id}:${args.nodeId}:paid`))) return false;
  const graph = await loadGraph(supabase, run.version_id);
  if (!graph) return false;
  run.variables = { ...run.variables, payment_id: args.paymentLinkId };
  await advance(supabase, run, graph, null, { paid: true });
  return true;
}

/** STOP / opt-out anywhere: every active run for the contact ends. */
export async function cancelRunsForContact(supabase: SupabaseClient, organizationId: string, contactId: string) {
  await supabase
    .from("flow_runs")
    .update({ status: "cancelled", wake_at: null, ended_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["running", "waiting", "paused"]);
}
