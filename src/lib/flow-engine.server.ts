import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_RUN_AGE_DAYS,
  MAX_STEPS_PER_RUN,
  edgeFrom,
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
  const [{ data: override }, { data: flag }] = await Promise.all([
    supabase
      .from("organization_feature_overrides")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("flag_key", "flows_v2")
      .maybeSingle(),
    supabase.from("feature_flags").select("default_enabled").eq("key", "flows_v2").maybeSingle(),
  ]);
  if (override) return Boolean((override as { enabled: boolean }).enabled);
  return Boolean((flag as { default_enabled?: boolean } | null)?.default_enabled);
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
  // 23505 = this exact send already happened.
  return !error;
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
  await logEvent(supabase, run, start.id, "started", args.trigger ?? {});
  await advance(supabase, run, v.graph, null);
  return { runId: run.id, reason: null };
}

/** An inbound message: if a run is waiting for this contact's reply, it takes it. */
export async function handleInboundForRuns(
  supabase: SupabaseClient,
  args: { organizationId: string; contactId: string; conversationId: string; body: string; replyId: string | null },
): Promise<{ consumed: boolean }> {
  const { data } = await supabase
    .from("flow_runs")
    .select(RUN_COLUMNS)
    .eq("organization_id", args.organizationId)
    .eq("contact_id", args.contactId)
    .eq("status", "waiting")
    .eq("waiting_for", "reply")
    .order("updated_at", { ascending: false })
    .limit(1);
  const run = ((data ?? []) as Run[])[0];
  if (!run) return { consumed: false };
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return { consumed: false };
  const graph = await loadGraph(supabase, run.version_id);
  if (!graph) return { consumed: false };
  if (!run.conversation_id) {
    await supabase.from("flow_runs").update({ conversation_id: args.conversationId }).eq("id", run.id);
    run.conversation_id = args.conversationId;
  }
  await logEvent(supabase, run, run.current_node_id, "reply", { reply_id: args.replyId, length: args.body.length });
  await advance(supabase, run, graph, { body: args.body, replyId: args.replyId });
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
      await fail(supabase, run, error instanceof Error ? error.message : String(error));
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
        wake_at: prev.waiting_for === "reply" ? prev.wake_at ?? null : new Date().toISOString(),
        variables: vars,
      })
      .eq("id", run.id);
  }
  await logEvent(supabase, run, run.current_node_id, args.action, { by: args.userId });
  return { ok: true, error: null };
}

async function fail(supabase: SupabaseClient, run: Run, message: string) {
  await supabase
    .from("flow_runs")
    .update({ status: "failed", last_error: message.slice(0, 300), wake_at: null, claimed_at: null, ended_at: new Date().toISOString() })
    .eq("id", run.id);
  await logEvent(supabase, run, run.current_node_id, "failed", { error: message.slice(0, 300) });
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
  const [{ data: contact }, { data: tagRows }, { data: conversation }, { data: flow }, settings] = await Promise.all([
    supabase.from("contacts").select("name, phone, wa_id, attributes, opt_in_status").eq("id", run.contact_id).maybeSingle(),
    supabase.from("contact_tags").select("tags(name)").eq("contact_id", run.contact_id),
    run.conversation_id
      ? supabase.from("conversations").select("last_customer_message_at, whatsapp_account_id").eq("id", run.conversation_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("flows").select("whatsapp_account_id").eq("id", run.flow_id).maybeSingle(),
    loadSendSettings(supabase, run.organization_id),
  ]);
  const c = (contact ?? { name: null, phone: "", wa_id: null, attributes: {}, opt_in_status: null }) as {
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
      tags: ((tagRows ?? []) as Array<{ tags: { name: string } | null }>).map((t) => t.tags?.name ?? "").filter(Boolean),
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
  opts: { woke?: boolean } = {},
): Promise<void> {
  const env = await loadEnv(supabase, run);
  const vars = env.ctx.vars;
  const visits = new Map<string, number>();
  let nodeId = run.current_node_id;
  let steps = run.steps;
  let reply = inbound;
  let woke = Boolean(opts.woke);

  const save = async (patch: Record<string, unknown>) => {
    await supabase
      .from("flow_runs")
      .update({ current_node_id: nodeId, variables: vars, steps, claimed_at: null, ...patch })
      .eq("id", run.id);
  };
  const finish = async (status: "done" | "failed" | "cancelled" | "expired", event: string, detail: Record<string, unknown> = {}) => {
    await save({ status, wake_at: null, waiting_for: null, ended_at: new Date().toISOString(), ...(status === "failed" ? { last_error: String(detail["error"] ?? event) } : {}) });
    await logEvent(supabase, run, nodeId, event, detail);
  };
  const waitFor = async (kind: "reply" | "timer", minutes: number) => {
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
    if (!waitingHere) await logEvent(supabase, run, node.id, "entered", { type: node.type });

    const needsWindow = ["text", "buttons", "list", "ask", "form"].includes(node.type);
    const sendsMessage = needsWindow || node.type === "template";

    // Quiet hours hold proactive sends (not replies to a message just received).
    if (sendsMessage && !awaitingReply && !reply && !woke && env.settings.quietHoursEnabled) {
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
    if (needsWindow && !awaitingReply && !env.windowOpen) {
      await logEvent(supabase, run, node.id, "window_closed");
      if (!(await follow(node, "window_closed"))) return;
      continue;
    }
    if (sendsMessage && !awaitingReply && !env.conn) {
      await finish("failed", "failed", { error: "no_connected_number" });
      return;
    }

    // ---- nodes that wait for the customer ----
    if (node.type === "buttons" || node.type === "list" || node.type === "ask") {
      if (!awaitingReply) {
        bumpAttempt(node.id);
        const ok = await sendPrompt(supabase, run, env, node, `${run.id}:${node.id}:${attemptOf(node.id)}`);
        if (!ok.ok) {
          await finish("failed", "failed", { error: ok.error ?? "send_failed" });
          return;
        }
        await waitFor("reply", Number(d["timeout_minutes"] ?? DEFAULT_REPLY_TIMEOUT_MIN));
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
      bumpAttempt(node.id);
      const retryText = String(d["retry_text"] ?? "").trim();
      const ok = await sendPrompt(supabase, run, env, node, `${run.id}:${node.id}:${attemptOf(node.id)}`, retryText || null);
      if (!ok.ok) {
        await finish("failed", "failed", { error: ok.error ?? "send_failed" });
        return;
      }
      await waitFor("reply", Number(d["timeout_minutes"] ?? DEFAULT_REPLY_TIMEOUT_MIN));
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
          else
            await supabase
              .from("contacts")
              .update({ attributes: { ...env.ctx.contact.attributes, [field]: value } })
              .eq("id", run.contact_id);
          env.ctx.contact.attributes[field] = value;
        }
        break;
      }
      case "assign":
        if (run.conversation_id) {
          const userId = String(d["user_id"] ?? "").trim();
          await supabase
            .from("conversations")
            .update(userId ? { assigned_to: userId } : { needs_human: true, needs_human_reason: "flow_assign", needs_human_at: new Date().toISOString() })
            .eq("id", run.conversation_id);
        }
        break;
      case "needs_you":
        await markNeedsYou(supabase, run, String(d["note"] ?? "A flow asked for a person."));
        break;
      default:
        await finish("failed", "failed", { error: `unknown_node:${node.type}` });
        return;
    }
    if (!(await follow(node, "next"))) return;
  }
}

function matchReply(node: FlowNode, reply: Inbound): { ok: true; value: string; handle: string } | { ok: false } {
  const d = node.data;
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
  let { data: tag } = await supabase
    .from("tags")
    .select("id")
    .eq("organization_id", run.organization_id)
    .ilike("name", tagName)
    .maybeSingle();
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
