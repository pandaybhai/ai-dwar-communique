import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_RUN_AGE_DAYS,
  MAX_STEPS_PER_RUN,
  computeVariable,
  edgeFrom,
  isBusinessOpen,
  interpolate,
  pickBranch,
  startNode,
  validateAnswer,
  type Branch,
  type FlowGraph,
  type FlowNode,
  type RunContext,
  type ValidationKind,
} from "@/lib/flow-graph";
import { isServiceWindowOpen } from "@/lib/service-window";

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

const RUN_COLUMNS =
  "id, organization_id, flow_id, version_id, contact_id, conversation_id, current_node_id, variables, status, waiting_for, wake_at, steps, started_at";
const DEFAULT_REPLY_TIMEOUT_MIN = 24 * 60;
const MAX_VISITS_PER_ADVANCE = 25;

export async function flowsV2Enabled(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  // One source of truth for flags: the same resolver the AI tools use.
  const { enabledFlags } = await import("@/lib/ai-tools.server");
  return (await enabledFlags(supabase, organizationId)).has("flows_v2");
}

async function logEvent(
  supabase: SupabaseClient,
  run: Pick<Run, "id" | "organization_id">,
  nodeId: string | null,
  event: string,
  detail: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<boolean> {
  const { error } = await supabase.from("flow_run_events").insert({
    organization_id: run.organization_id,
    run_id: run.id,
    node_id: nodeId,
    event,
    detail,
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
  },
): Promise<{ runId: string | null; reason: string | null }> {
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return { runId: null, reason: "flag_off" };
  const { data: version } = await supabase
    .from("flow_versions")
    .select("id, graph")
    .eq("flow_id", args.flowId)
    .eq("organization_id", args.organizationId)
    .eq("status", "published")
    .maybeSingle();
  const v = version as { id: string; graph: FlowGraph } | null;
  if (!v) return { runId: null, reason: "not_published" };
  if (v.graph.meta?.legacy) return { runId: null, reason: "legacy_flow" };
  const start = startNode(v.graph);
  if (!start) return { runId: null, reason: "no_start" };

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
  try {
    await logEvent(supabase, run, start.id, "started", args.trigger ?? {});
    await advance(supabase, run, v.graph, null, { fromCustomer: Boolean(args.fromCustomerMessage) });
  } catch (error) {
    await failSafe(supabase, run, error);
  }
  // The run exists either way, so the trigger counts as consumed.
  return { runId: run.id, reason: null };
}

/** An inbound message: if a run is waiting for this contact's reply, it takes it. */
export async function handleInboundForRuns(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    whatsappAccountId?: string | null;
    body: string;
    replyId: string | null;
  },
): Promise<{ consumed: boolean }> {
  // Match on this conversation (a run started without one, e.g. from a tag
  // trigger, is matched by contact + the flow's number instead).
  const { data } = await supabase
    .from("flow_runs")
    .select(RUN_COLUMNS)
    .eq("organization_id", args.organizationId)
    .eq("contact_id", args.contactId)
    .eq("status", "waiting")
    .eq("waiting_for", "reply")
    .or(`conversation_id.eq.${args.conversationId},conversation_id.is.null`)
    .order("updated_at", { ascending: false })
    .limit(5);
  let candidates = (data ?? []) as Run[];
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
  const run = candidates.find((r) => r.conversation_id === args.conversationId) ?? candidates[0];
  if (!run) return { consumed: false };
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return { consumed: false };
  const graph = await loadGraph(supabase, run.version_id);
  if (!graph) return { consumed: false };
  // Claim: only one of (this reply, a timeout tick) may advance the run.
  const { data: claimed } = await supabase
    .from("flow_runs")
    .update({ status: "running", claimed_at: new Date().toISOString(), conversation_id: run.conversation_id ?? args.conversationId })
    .eq("id", run.id)
    .eq("status", "waiting")
    .eq("waiting_for", "reply")
    .select("id");
  if (!claimed || claimed.length === 0) {
    // Someone else (the tick) has it right now — the flow still owns the chat.
    return { consumed: true };
  }
  run.conversation_id = run.conversation_id ?? args.conversationId;
  try {
    await logEvent(supabase, run, run.current_node_id, "reply", { reply_id: args.replyId, length: args.body.length });
    // advance() reasons about the state the run was waiting in.
    await advance(supabase, run, graph, { body: args.body, replyId: args.replyId });
  } catch (error) {
    await failSafe(supabase, run, error);
  }
  return { consumed: true };
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
  const { data: claimed } = await supabase.rpc("claim_flow_runs", { p_limit: 50 });
  const runs = (claimed ?? []) as Run[];
  for (const run of runs) {
    try {
      const graph = await loadGraph(supabase, run.version_id);
      if (!graph || !(await flowsV2Enabled(supabase, run.organization_id))) {
        await supabase.from("flow_runs").update({ claimed_at: null, wake_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", run.id);
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
  windowOpen: boolean;
  conn: { phoneNumberId: string; accessToken: string; accountId: string; wabaId: string } | null;
  settings: import("@/lib/flows.server").SendSettings;
};

async function loadEnv(supabase: SupabaseClient, run: Run): Promise<Env> {
  const { loadSendSettings } = await import("@/lib/flows.server");
  const [{ data: contact, error: contactError }, { data: tagRows }, { data: conversation }, { data: flow }, settings] = await Promise.all([
    supabase.from("contacts").select("name, phone, wa_id, attributes, opt_in_status").eq("id", run.contact_id).maybeSingle(),
    supabase.from("contact_tags").select("tags(name)").eq("contact_id", run.contact_id),
    run.conversation_id
      ? supabase.from("conversations").select("last_customer_message_at, whatsapp_account_id").eq("id", run.conversation_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("flows").select("whatsapp_account_id").eq("id", run.flow_id).maybeSingle(),
    loadSendSettings(supabase, run.organization_id),
  ]);
  // Without the contact we can't know opt-out or attributes — fail, never guess.
  if (contactError || !contact) throw new Error(contactError ? `contact_read_failed:${contactError.message}` : "contact_missing");
  const c = contact as {
    name: string | null;
    phone: string;
    wa_id: string | null;
    attributes: Record<string, unknown> | null;
    opt_in_status: string | null;
  };
  const conv = conversation as { last_customer_message_at?: string | null; whatsapp_account_id?: string | null } | null;
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(
    supabase,
    run.organization_id,
    conv?.whatsapp_account_id ?? (flow as { whatsapp_account_id?: string | null } | null)?.whatsapp_account_id ?? null,
  );
  return {
    ctx: {
      vars: run.variables ?? {},
      contact: { name: c.name, phone: c.phone, attributes: c.attributes ?? {} },
      tags: ((tagRows ?? []) as unknown as Array<{ tags: { name: string } | null }>).map((t) => t.tags?.name ?? "").filter(Boolean),
      now: new Date(),
      timezone: settings.timezone,
    },
    to: (c.wa_id ?? c.phone).replace(/\D/g, ""),
    optedOut: String(c.opt_in_status ?? "").toLowerCase() === "opted_out",
    windowOpen: isServiceWindowOpen(conv),
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
async function advance(
  supabase: SupabaseClient,
  run: Run,
  graph: FlowGraph,
  inbound: Inbound | null,
  opts: { woke?: boolean; paid?: boolean; fromCustomer?: boolean } = {},
): Promise<void> {
  const env = await loadEnv(supabase, run);
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
    const waitingHere = run.status === "waiting" && run.current_node_id === node.id && seen === 1;
    const awaitingReply = waitingHere && run.waiting_for === "reply";
    const payWaiting = waitingHere && run.waiting_for === "payment";
    if (!waitingHere) await logEvent(supabase, run, node.id, "entered", { type: node.type });

    const needsWindow = ["text", "buttons", "list", "ask", "form", "cta_url", "location_request", "location_send", "contact_card", "carousel", "payment"].includes(node.type);
    const sendsMessage = needsWindow || node.type === "template";

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
          const { sendServiceText } = await import("@/lib/service-text.server");
          const res = await sendServiceText(supabase, {
            organizationId: run.organization_id,
            phoneNumberId: env.conn!.phoneNumberId,
            accessToken: env.conn!.accessToken,
            conversationId: run.conversation_id!,
            to: env.to,
            body: interpolate(String(d["text"] ?? ""), env.ctx),
            metadata: { kind: "flow_v2", run_id: run.id, node_id: node.id },
          });
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
        const handle = pickBranch((d["branches"] as Branch[] | undefined) ?? [], { ...env.ctx, vars });
        if (!(await follow(node, handle))) return;
        continue;
      }
      case "tag":
        await applyTag(supabase, run, String(d["tag"] ?? ""), d["action"] === "remove" ? "remove" : "add");
        break;
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
        await logEvent(supabase, run, node.id, "exited", { handle: "goto" });
        await finish("done", "ended", { reason: "goto_flow", flow_id: d["flow_id"] });
        await startRun(supabase, {
          organizationId: run.organization_id,
          flowId: String(d["flow_id"] ?? ""),
          contactId: run.contact_id,
          conversationId: run.conversation_id,
          trigger: { kind: "goto_flow", from_run: run.id },
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
    const r = await svc.sendServiceButtons(supabase, { ...base, buttons });
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

async function sendTemplate(
  supabase: SupabaseClient,
  run: Run,
  env: Env,
  templateId: string,
  variableSources: string[],
): Promise<{ error: string | null }> {
  const { data: template } = await supabase
    .from("message_templates")
    .select("name, language, category, status, components")
    .eq("id", templateId)
    .eq("organization_id", run.organization_id)
    .maybeSingle();
  const t = template as { name: string; language: string | null; category: string | null; status: string; components: unknown } | null;
  if (!t) return { error: "template_missing" };
  if (String(t.status).toUpperCase() !== "APPROVED") return { error: "template_not_approved" };
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
