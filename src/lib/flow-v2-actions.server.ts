import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraph, GraphProblem } from "@/lib/flow-graph";

/**
 * Batch 52: the Flows v2 editor's create and publish, shared by the app
 * (/api/flows/v2) and AiDwar MCP (create_flow_draft / activate_flow). Moved
 * here from that route without changing what they do: the app's answers are
 * word for word the same. The caller has already checked flows_v2.edit and
 * that Flows v2 is on for the workspace.
 */

export type FlowV2Refusal = { ok: false; status: number; error: string };

export type OwnFlowV2 = { id: string; name: string; key: string; config?: Record<string, unknown> | null };

/** A v2 flow of this workspace that isn't deleted (Batch 35), or null. */
export async function ownFlowV2(db: SupabaseClient, org: string, flowId: string): Promise<OwnFlowV2 | null> {
  const { data } = await db.from("flows").select("id, name, key, config").eq("id", flowId).eq("organization_id", org).maybeSingle();
  const f = data as OwnFlowV2 | null;
  const { isFlowDeleted } = await import("@/lib/flow-delete");
  return f && f.key.startsWith("v2:") && !isFlowDeleted(f) ? f : null;
}

/** The newest draft version of a flow, or null. */
export async function draftOfFlowV2(
  db: SupabaseClient,
  org: string,
  flowId: string,
): Promise<{ id: string; graph: unknown; version: number } | null> {
  const { data } = await db.from("flow_versions").select("id, graph, version").eq("flow_id", flowId).eq("organization_id", org).eq("status", "draft").order("version", { ascending: false }).limit(1);
  return ((data ?? []) as Array<{ id: string; graph: unknown; version: number }>)[0] ?? null;
}

/** Header values never stay in the graph JSON (members can read it). */
export async function sealFlowGraph(db: SupabaseClient, org: string, flowId: string, g: unknown) {
  const { sealHttpSecrets } = await import("@/lib/flow-http.server");
  return sealHttpSecrets(db, org, flowId, g as FlowGraph);
}

/** A new flow, switched off, with its graph as draft version 1. */
export async function createFlowV2(
  db: SupabaseClient,
  args: { organizationId: string; userId: string; name: string; graph: unknown; activityDetails?: Record<string, unknown> },
): Promise<{ ok: true; flowId: string } | FlowV2Refusal> {
  const org = args.organizationId;
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  const key = `v2:${crypto.randomUUID()}`;
  const { data: flow, error } = await db
    .from("flows")
    .insert({ organization_id: org, key, name: args.name, is_enabled: false, config: { v2: true } })
    .select("id")
    .single();
  if (error || !flow) return { ok: false, status: 500, error: "Couldn't create the flow." };
  const flowId = (flow as { id: string }).id;
  const sealed = await sealFlowGraph(db, org, flowId, args.graph);
  if (sealed.error) {
    await db.from("flows").delete().eq("id", flowId).eq("organization_id", org);
    return { ok: false, status: 500, error: sealed.error };
  }
  const { error: draftError } = await db.from("flow_versions").insert({ organization_id: org, flow_id: flowId, version: 1, status: "draft", graph: sealed.graph, created_by: args.userId });
  if (draftError) {
    await db.from("flows").delete().eq("id", flowId).eq("organization_id", org);
    return { ok: false, status: 500, error: "Couldn't create the flow." };
  }
  await logServerActivity(db, org, args.userId, "flow_v2_created", { flow_id: flowId, ...(args.activityDetails ?? {}) });
  return { ok: true, flowId };
}

/**
 * Everything that stops a graph from being published: validateGraph with the
 * workspace's timezone (and its WhatsApp shop / cards, only when the graph
 * has such a step), plus every template step's template APPROVED now.
 */
export async function flowV2PublishProblems(db: SupabaseClient, org: string, graph: FlowGraph): Promise<GraphProblem[]> {
  const { validateGraph } = await import("@/lib/flow-graph");
  const { loadSendSettings } = await import("@/lib/flows.server");
  // A WhatsApp shop step needs a connected catalogue; flows without one never look.
  const hasShopStep = graph.nodes.some((n) => n.type === "carousel");
  const whatsappShop = hasShopStep
    ? await (await import("@/lib/whatsapp-catalog.server")).whatsappShopConnected(db, org)
    : undefined;
  // Likewise a Send card step needs cards switched on; flows without one never look.
  const hasCardStep = graph.nodes.some((n) => n.type === "send_card");
  const cards = hasCardStep
    ? await (await import("@/lib/customer-cards.server")).cardsEnabled(db, org).catch(() => false)
    : undefined;
  const problems = validateGraph(graph, {
    timezone: (await loadSendSettings(db, org)).timezone,
    ...(whatsappShop === undefined ? {} : { whatsappShop }),
    ...(cards === undefined ? {} : { cards }),
  });
  // Templates must be APPROVED at publish time.
  const templateIds = graph.nodes.filter((n) => n.type === "template").map((n) => String(n.data["template_id"] ?? "")).filter(Boolean);
  if (templateIds.length) {
    const { data: t } = await db.from("message_templates").select("id, status").eq("organization_id", org).in("id", templateIds);
    const ok = new Set(((t ?? []) as Array<{ id: string; status: string }>).filter((x) => String(x.status).toUpperCase() === "APPROVED").map((x) => x.id));
    for (const n of graph.nodes)
      if (n.type === "template" && n.data["template_id"] && !ok.has(String(n.data["template_id"])))
        problems.push({ nodeId: n.id, message: "This template isn't approved by Meta yet." });
  }
  return problems;
}

/**
 * Publishes the flow's newest draft: sealed, checked, then flow_publish_version
 * (all or nothing: the old version archived, this one published, the flow on).
 */
export async function publishFlowV2(
  db: SupabaseClient,
  args: { organizationId: string; userId: string; flowId: string; activityDetails?: Record<string, unknown> },
): Promise<{ ok: true; version: number } | FlowV2Refusal | { ok: false; status: 422; problems: GraphProblem[] }> {
  const org = args.organizationId;
  const draft = await draftOfFlowV2(db, org, args.flowId);
  if (!draft) return { ok: false, status: 400, error: "There's no draft to publish." };
  // A draft saved before header values were sealed gets sealed now.
  const sealed = await sealFlowGraph(db, org, args.flowId, draft.graph);
  if (sealed.error) return { ok: false, status: 500, error: sealed.error };
  const graph = sealed.graph;
  const problems = await flowV2PublishProblems(db, org, graph);
  if (problems.length) return { ok: false, status: 422, problems };
  // All or nothing: never an archived old version with no new one, or a published flow left off.
  const { publishFlowVersion } = await import("@/lib/flow-publish.server");
  const published = await publishFlowVersion(db, { organizationId: org, flowId: args.flowId, versionId: draft.id, graph, userId: args.userId });
  if (!published.ok) return { ok: false, status: 500, error: published.error };
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(db, org, args.userId, "flow_v2_published", { flow_id: args.flowId, version: draft.version, ...(args.activityDetails ?? {}) });
  return { ok: true, version: draft.version };
}
