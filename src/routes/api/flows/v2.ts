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
  z.object({ action: z.literal("editor_context"), organization_id: z.string().uuid(), flow_id: z.string().uuid() }),
  z.object({ action: z.literal("set_number"), organization_id: z.string().uuid(), flow_id: z.string().uuid(), whatsapp_account_id: z.string().uuid().nullable() }),
  z.object({ action: z.literal("test_http"), organization_id: z.string().uuid(), data: z.record(z.string(), z.unknown()) }),
]);

/**
 * Flows v2 editor writes: create, save draft, publish, unpublish, restore.
 * Edit = flows_v2.edit (owners always have it). Org comes from the verified membership.
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
        const denied = await requirePermission(auth, "flows_v2.edit", "edit flows");
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

        if (body.action === "test_http") {
          // One real request with sample values, same guards as the live step.
          // Saved header values are filled in server-side, only for the address they were saved for.
          const { runHttpRequest, loadHttpSecrets } = await import("@/lib/flow-http.server");
          const res = await runHttpRequest(await loadHttpSecrets(db, org, body.data), {
            vars: { last_answer: "test answer" },
            contact: { name: "Test Customer", phone: "919999999999", attributes: {} },
            tags: [],
            now: new Date(),
            timezone: "Asia/Kolkata",
          });
          await logServerActivity(db, org, auth.userId, "flow_v2_http_tested", { ok: res.ok, status: res.status });
          return Response.json({ ok: true, result: res });
        }

        const ownFlow = async (flowId: string) => {
          const { data } = await db.from("flows").select("id, name, key").eq("id", flowId).eq("organization_id", org).maybeSingle();
          const f = data as { id: string; name: string; key: string } | null;
          return f && f.key.startsWith("v2:") ? f : null;
        };
        if (body.action === "editor_context" || body.action === "set_number") {
          const flow = await ownFlow(body.flow_id);
          if (!flow) return jsonError("Flow not found.", 404);
          const [{ data: numbers }, { data: platform }] = await Promise.all([
            db.from("whatsapp_accounts").select("id, display_phone_number, verified_name").eq("organization_id", org),
            db.from("platform_settings").select("onboarding_whatsapp_account_id").maybeSingle(),
          ]);
          const onboardingId = (platform as { onboarding_whatsapp_account_id?: string | null } | null)?.onboarding_whatsapp_account_id ?? null;
          const nums = ((numbers ?? []) as Array<{ id: string; display_phone_number: string | null; verified_name: string | null }>).map((n) => ({
            id: n.id,
            label: [n.verified_name, n.display_phone_number].filter(Boolean).join(" · ") || "Number",
            onboarding: n.id === onboardingId,
          }));
          if (body.action === "set_number") {
            if (body.whatsapp_account_id && !nums.some((n) => n.id === body.whatsapp_account_id)) return jsonError("That number isn't in this workspace.");
            await db.from("flows").update({ whatsapp_account_id: body.whatsapp_account_id }).eq("id", flow.id).eq("organization_id", org);
            await logServerActivity(db, org, auth.userId, "flow_v2_number_set", { flow_id: flow.id, pinned: Boolean(body.whatsapp_account_id) });
            return Response.json({ ok: true });
          }
          const { whatsappShopConnected } = await import("@/lib/whatsapp-catalog.server");
          const [{ data: cur }, { data: mem }, shopConnected] = await Promise.all([
            db.from("flows").select("whatsapp_account_id").eq("id", flow.id).maybeSingle(),
            db.from("organization_members").select("user_id").eq("organization_id", org),
            whatsappShopConnected(db, org),
          ]);
          const ids = ((mem ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
          const { data: profs } = ids.length ? await db.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
          return Response.json({
            ok: true,
            numbers: nums,
            whatsapp_account_id: (cur as { whatsapp_account_id?: string | null } | null)?.whatsapp_account_id ?? null,
            whatsapp_shop_connected: shopConnected,
            members: ((profs ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((p) => ({ id: p.id, name: p.full_name || p.email || "Teammate" })),
          });
        }

        // Header values never stay in the graph JSON (members can read it).
        const seal = async (flowId: string, g: unknown) => {
          const { sealHttpSecrets } = await import("@/lib/flow-http.server");
          return sealHttpSecrets(db, org, flowId, g as import("@/lib/flow-graph").FlowGraph);
        };
        const nextVersion = async (flowId: string) => {
          const { data } = await db.from("flow_versions").select("version").eq("flow_id", flowId).order("version", { ascending: false }).limit(1);
          return Number(((data ?? []) as Array<{ version: number }>)[0]?.version ?? 0) + 1;
        };
        const draftOf = async (flowId: string) => {
          const { data } = await db.from("flow_versions").select("id, graph, version").eq("flow_id", flowId).eq("organization_id", org).eq("status", "draft").order("version", { ascending: false }).limit(1);
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
          const sealed = await seal(flowId, body.graph);
          if (sealed.error) {
            await db.from("flows").delete().eq("id", flowId).eq("organization_id", org);
            return jsonError(sealed.error, 500);
          }
          const { error: draftError } = await db.from("flow_versions").insert({ organization_id: org, flow_id: flowId, version: 1, status: "draft", graph: sealed.graph, created_by: auth.userId });
          if (draftError) {
            await db.from("flows").delete().eq("id", flowId).eq("organization_id", org);
            return jsonError("Couldn't create the flow.", 500);
          }
          await logServerActivity(db, org, auth.userId, "flow_v2_created", { flow_id: flowId });
          return Response.json({ ok: true, flow_id: flowId });
        }

        const flow = await ownFlow(body.flow_id);
        if (!flow) return jsonError("That flow doesn't exist.", 404);

        if (body.action === "save_draft") {
          const sealed = await seal(flow.id, body.graph);
          if (sealed.error) return jsonError(sealed.error, 500);
          const draft = await draftOf(flow.id);
          // A write that didn't land is said out loud — the editor keeps the changes and shows why.
          const { error: saveError } = draft
            ? await db.from("flow_versions").update({ graph: sealed.graph }).eq("id", draft.id)
            : await db.from("flow_versions").insert({
                organization_id: org, flow_id: flow.id, version: await nextVersion(flow.id), status: "draft", graph: sealed.graph, created_by: auth.userId,
              });
          if (saveError) {
            console.error("[flows-v2] draft not saved", saveError.message);
            return jsonError("Your changes weren't saved — please try again.", 500);
          }
          if (body.name && body.name !== flow.name) {
            const { error: nameError } = await db.from("flows").update({ name: body.name }).eq("id", flow.id);
            if (nameError) return jsonError("Your steps were saved, but the new name wasn't — please try again.", 500);
          }
          return Response.json({ ok: true, graph: sealed.graph });
        }

        if (body.action === "publish") {
          const draft = await draftOf(flow.id);
          if (!draft) return jsonError("There's no draft to publish.");
          // A draft saved before header values were sealed gets sealed now.
          const sealed = await seal(flow.id, draft.graph);
          if (sealed.error) return jsonError(sealed.error, 500);
          const graph = sealed.graph;
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
          if (problems.length) return Response.json({ ok: false, problems }, { status: 422 });
          // All or nothing: never an archived old version with no new one, or a published flow left off.
          const { publishFlowVersion } = await import("@/lib/flow-publish.server");
          const published = await publishFlowVersion(db, { organizationId: org, flowId: flow.id, versionId: draft.id, graph, userId: auth.userId });
          if (!published.ok) return jsonError(published.error, 500);
          await logServerActivity(db, org, auth.userId, "flow_v2_published", { flow_id: flow.id, version: draft.version });
          return Response.json({ ok: true, version: draft.version });
        }

        if (body.action === "unpublish") {
          const { data: pub } = await db.from("flow_versions").select("id, graph").eq("flow_id", flow.id).eq("organization_id", org).eq("status", "published").maybeSingle();
          if (!pub) return jsonError("This flow isn't published.");
          const draft = await draftOf(flow.id);
          // Switch the flow off first: if that fails nothing has changed.
          const { error: offError } = await db.from("flows").update({ is_enabled: false }).eq("id", flow.id);
          if (offError) return jsonError("We couldn't unpublish this flow — nothing was changed. Please try again.", 500);
          const { error: verError } = draft
            ? await db.from("flow_versions").update({ status: "archived" }).eq("id", pub.id)
            : await db.from("flow_versions").update({ status: "draft", published_at: null }).eq("id", pub.id);
          if (verError) {
            await db.from("flows").update({ is_enabled: true }).eq("id", flow.id);
            return jsonError("We couldn't unpublish this flow — nothing was changed. Please try again.", 500);
          }
          await logServerActivity(db, org, auth.userId, "flow_v2_unpublished", { flow_id: flow.id });
          return Response.json({ ok: true });
        }

        // restore: copy an old version into the draft
        const { data: old } = await db.from("flow_versions").select("graph, version").eq("id", body.version_id).eq("flow_id", flow.id).eq("organization_id", org).maybeSingle();
        if (!old) return jsonError("That version doesn't exist.", 404);
        const draft = await draftOf(flow.id);
        const restored = await seal(flow.id, (old as { graph: unknown }).graph);
        if (restored.error) return jsonError(restored.error, 500);
        const g = restored.graph;
        const { error: restoreError } = draft
          ? await db.from("flow_versions").update({ graph: g }).eq("id", draft.id)
          : await db.from("flow_versions").insert({ organization_id: org, flow_id: flow.id, version: await nextVersion(flow.id), status: "draft", graph: g, created_by: auth.userId });
        if (restoreError) return jsonError("That version couldn't be restored — please try again.", 500);
        await logServerActivity(db, org, auth.userId, "flow_v2_restored", { flow_id: flow.id, from_version: (old as { version: number }).version });
        return Response.json({ ok: true });
      },
    },
  },
});
