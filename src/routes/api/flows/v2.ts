import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Graph = z.object({
  nodes: z.array(z.object({ id: z.string(), type: z.string(), position: z.any().optional(), data: z.record(z.string(), z.unknown()) })).max(200),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional() })).max(1000),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), organization_id: z.string().uuid(), name: z.string().min(1).max(80), graph: Graph }),
  z.object({ action: z.literal("save_draft"), organization_id: z.string().uuid(), flow_id: z.string().uuid(), graph: Graph, name: z.string().min(1).max(80).optional() }),
  z.object({ action: z.literal("publish"), organization_id: z.string().uuid(), flow_id: z.string().uuid() }),
  z.object({ action: z.literal("unpublish"), organization_id: z.string().uuid(), flow_id: z.string().uuid() }),
  z.object({ action: z.literal("generate"), organization_id: z.string().uuid(), description: z.string().min(10).max(1500) }),
  z.object({ action: z.literal("restore"), organization_id: z.string().uuid(), flow_id: z.string().uuid(), version_id: z.string().uuid() }),
]);

/**
 * Flows v2 editor writes: create, save draft, publish, unpublish, restore.
 * Edit = ai.configure (owners always have it). Org comes from the verified membership.
 */
export const Route = createFileRoute("/api/flows/v2")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, requirePermission, logServerActivity } = await import(
          "@/lib/whatsapp-api.server"
        );
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, body.organization_id);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "ai.configure", "edit flows");
        if (denied) return denied;
        const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const db = getServiceClient();
        const org = auth.organizationId;
        if (!(await flowsV2Enabled(db, org))) return jsonError("Flows v2 isn't switched on for this workspace.", 403);
        const { validateGraph } = await import("@/lib/flow-graph");

        if (body.action === "generate") {
          const { generateFlowDraft } = await import("@/lib/flow-generate.server");
          const out = await generateFlowDraft(db, { organizationId: org, userId: auth.userId, description: body.description });
          if (!out.graph) return jsonError(out.error ?? "I couldn't draft that flow — try describing it in a bit more detail.", out.status ?? 422);
          await logServerActivity(db, org, auth.userId, "flow_v2_generated", { nodes: out.graph.nodes.length });
          return Response.json({ ok: true, graph: out.graph });
        }

        const ownFlow = async (flowId: string) => {
          const { data } = await db.from("flows").select("id, name, key").eq("id", flowId).eq("organization_id", org).maybeSingle();
          const f = data as { id: string; name: string; key: string } | null;
          return f && f.key.startsWith("v2:") ? f : null;
        };
        const nextVersion = async (flowId: string) => {
          const { data } = await db.from("flow_versions").select("version").eq("flow_id", flowId).order("version", { ascending: false }).limit(1);
          return Number(((data ?? []) as Array<{ version: number }>)[0]?.version ?? 0) + 1;
        };
        const draftOf = async (flowId: string) => {
          const { data } = await db.from("flow_versions").select("id, graph, version").eq("flow_id", flowId).eq("status", "draft").order("version", { ascending: false }).limit(1);
          return ((data ?? []) as Array<{ id: string; graph: unknown; version: number }>)[0] ?? null;
        };

        if (body.action === "create") {
          const key = `v2:${crypto.randomUUID()}`;
          const { data: flow, error } = await db
            .from("flows")
            .insert({ organization_id: org, key, name: body.name, is_enabled: false, config: { v2: true } })
            .select("id")
            .single();
          if (error || !flow) return jsonError("Couldn't create the flow.", 500);
          const flowId = (flow as { id: string }).id;
          await db.from("flow_versions").insert({ organization_id: org, flow_id: flowId, version: 1, status: "draft", graph: body.graph, created_by: auth.userId });
          await logServerActivity(db, org, auth.userId, "flow_v2_created", { flow_id: flowId });
          return Response.json({ ok: true, flow_id: flowId });
        }

        const flow = await ownFlow(body.flow_id);
        if (!flow) return jsonError("That flow doesn't exist.", 404);

        if (body.action === "save_draft") {
          const draft = await draftOf(flow.id);
          if (draft) await db.from("flow_versions").update({ graph: body.graph }).eq("id", draft.id);
          else
            await db.from("flow_versions").insert({
              organization_id: org, flow_id: flow.id, version: await nextVersion(flow.id), status: "draft", graph: body.graph, created_by: auth.userId,
            });
          if (body.name && body.name !== flow.name) await db.from("flows").update({ name: body.name }).eq("id", flow.id);
          return Response.json({ ok: true });
        }

        if (body.action === "publish") {
          const draft = await draftOf(flow.id);
          if (!draft) return jsonError("There's no draft to publish.");
          const graph = draft.graph as import("@/lib/flow-graph").FlowGraph;
          const problems = validateGraph(graph);
          // Templates must be APPROVED at publish time.
          const templateIds = graph.nodes.filter((n) => n.type === "template").map((n) => String(n.data["template_id"] ?? "")).filter(Boolean);
          if (templateIds.length) {
            const { data: t } = await db.from("message_templates").select("id, status").eq("organization_id", org).in("id", templateIds);
            const ok = new Set(((t ?? []) as Array<{ id: string; status: string }>).filter((x) => String(x.status).toUpperCase() === "APPROVED").map((x) => x.id));
            for (const n of graph.nodes)
              if (n.type === "template" && n.data["template_id"] && !ok.has(String(n.data["template_id"])))
                problems.push({ nodeId: n.id, message: "This template isn't approved by Meta yet." });
          }
          if (problems.length) return Response.json({ ok: false, problems }, { status: 422 });
          await db.from("flow_versions").update({ status: "archived" }).eq("flow_id", flow.id).eq("status", "published");
          await db.from("flow_versions").update({ status: "published", published_at: new Date().toISOString(), published_by: auth.userId }).eq("id", draft.id);
          await db.from("flows").update({ is_enabled: true }).eq("id", flow.id);
          await logServerActivity(db, org, auth.userId, "flow_v2_published", { flow_id: flow.id, version: draft.version });
          return Response.json({ ok: true, version: draft.version });
        }

        if (body.action === "unpublish") {
          const { data: pub } = await db.from("flow_versions").select("id, graph").eq("flow_id", flow.id).eq("status", "published").maybeSingle();
          if (!pub) return jsonError("This flow isn't published.");
          const draft = await draftOf(flow.id);
          if (draft) await db.from("flow_versions").update({ status: "archived" }).eq("id", pub.id);
          else await db.from("flow_versions").update({ status: "draft", published_at: null }).eq("id", pub.id);
          await db.from("flows").update({ is_enabled: false }).eq("id", flow.id);
          await logServerActivity(db, org, auth.userId, "flow_v2_unpublished", { flow_id: flow.id });
          return Response.json({ ok: true });
        }

        // restore: copy an old version into the draft
        const { data: old } = await db.from("flow_versions").select("graph, version").eq("id", body.version_id).eq("flow_id", flow.id).maybeSingle();
        if (!old) return jsonError("That version doesn't exist.", 404);
        const draft = await draftOf(flow.id);
        const g = (old as { graph: unknown }).graph;
        if (draft) await db.from("flow_versions").update({ graph: g }).eq("id", draft.id);
        else await db.from("flow_versions").insert({ organization_id: org, flow_id: flow.id, version: await nextVersion(flow.id), status: "draft", graph: g, created_by: auth.userId });
        await logServerActivity(db, org, auth.userId, "flow_v2_restored", { flow_id: flow.id, from_version: (old as { version: number }).version });
        return Response.json({ ok: true });
      },
    },
  },
});
