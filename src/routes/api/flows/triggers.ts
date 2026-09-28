import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const KINDS = [
  "keyword",
  "first_message",
  "ctwa_ad",
  "store_event",
  "form_submitted",
  "tag_added",
  "campaign_button",
  "no_reply",
  "manual",
] as const;

const Trigger = z.object({
  kind: z.enum(KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  is_enabled: z.boolean().default(true),
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), organization_id: z.string().uuid(), flow_id: z.string().uuid() }),
  z.object({ action: z.literal("add"), organization_id: z.string().uuid(), flow_id: z.string().uuid(), trigger: Trigger }),
  z.object({ action: z.literal("update"), organization_id: z.string().uuid(), trigger_id: z.string().uuid(), trigger: Trigger.partial() }),
  z.object({ action: z.literal("remove"), organization_id: z.string().uuid(), trigger_id: z.string().uuid() }),
  z.object({ action: z.literal("win"), organization_id: z.string().uuid(), trigger_id: z.string().uuid() }),
  z.object({ action: z.literal("start"), organization_id: z.string().uuid(), flow_id: z.string().uuid(), contact_id: z.string().uuid(), conversation_id: z.string().uuid().optional() }),
  z.object({ action: z.literal("node_stats"), organization_id: z.string().uuid(), flow_id: z.string().uuid() }),
  z.object({ action: z.literal("contact_runs"), organization_id: z.string().uuid(), contact_id: z.string().uuid() }),
]);

function cleanConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case "keyword": {
      const keywords = ((config["keywords"] as string[] | undefined) ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
      const priority = Math.min(Math.max(Math.round(Number(config["priority"] ?? 0)) || 0, 0), 1000);
      return { keywords, match: ["exact", "contains", "starts_with"].includes(String(config["match"])) ? config["match"] : "contains", priority };
    }
    case "store_event":
      return { event: String(config["event"] ?? "").trim() };
    case "form_submitted":
      return { form_id: config["form_id"] ? String(config["form_id"]) : null };
    case "tag_added":
      return { tag: String(config["tag"] ?? "").trim() };
    case "campaign_button":
      return {
        campaign_id: config["campaign_id"] ? String(config["campaign_id"]) : null,
        button: config["button"] ? String(config["button"]).trim() : null,
      };
    case "no_reply": {
      const days = Math.min(Math.max(Number(config["days"] ?? 3), 1), 90);
      return { days };
    }
    default:
      return {};
  }
}

function configError(kind: string, config: Record<string, unknown>): string | null {
  if (kind === "keyword" && !((config["keywords"] as string[] | undefined) ?? []).length) return "Add at least one keyword.";
  if (kind === "store_event" && !config["event"]) return "Pick the store event.";
  if (kind === "tag_added" && !config["tag"]) return "Pick the tag.";
  return null;
}

/**
 * Flows v2 triggers: list/add/update/remove per flow, manual start from the
 * inbox, per-node counts for the canvas, per-contact run log for the inbox.
 */
export const Route = createFileRoute("/api/flows/triggers")({
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
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const db = getServiceClient();
        const org = auth.organizationId;
        const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
        if (!(await flowsV2Enabled(db, org))) return jsonError("Flows v2 isn't switched on for this workspace.", 403);

        // Reads any member can do; writes need flows_v2.edit.
        if (body.action === "node_stats") {
          const { data: published } = await db
            .from("flow_versions")
            .select("id")
            .eq("flow_id", body.flow_id)
            .eq("organization_id", org)
            .eq("status", "published")
            .maybeSingle();
          const versionId = (published as { id: string } | null)?.id;
          if (!versionId) return Response.json({ ok: true, stats: {} });
          const { data: runs } = await db.from("flow_runs").select("id").eq("version_id", versionId).limit(5000);
          const runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id);
          if (!runIds.length) return Response.json({ ok: true, stats: {} });
          const { data: events } = await db
            .from("flow_run_events")
            .select("node_id, event")
            .in("run_id", runIds)
            .in("event", ["entered", "exited", "failed", "ended"])
            .limit(50000);
          const stats: Record<string, { entered: number; exited: number; dropped: number }> = {};
          for (const e of (events ?? []) as Array<{ node_id: string | null; event: string }>) {
            if (!e.node_id) continue;
            const s = (stats[e.node_id] ??= { entered: 0, exited: 0, dropped: 0 });
            if (e.event === "entered") s.entered += 1;
            else if (e.event === "exited") s.exited += 1;
            else s.dropped += 1;
          }
          return Response.json({ ok: true, stats });
        }

        if (body.action === "contact_runs") {
          const { data: runs } = await db
            .from("flow_runs")
            .select("id, flow_id, status, current_node_id, started_at, ended_at, trigger, flows(name)")
            .eq("organization_id", org)
            .eq("contact_id", body.contact_id)
            .order("started_at", { ascending: false })
            .limit(20);
          const rows = (runs ?? []) as unknown as Array<{ id: string; flow_id: string; status: string; current_node_id: string | null; started_at: string; ended_at: string | null; trigger: Record<string, unknown>; flows: { name: string } | null }>;
          const runIds = rows.map((r) => r.id);
          const { data: events } = runIds.length
            ? await db.from("flow_run_events").select("run_id, node_id, event, detail, at").in("run_id", runIds).order("at", { ascending: true }).limit(500)
            : { data: [] };
          const byRun = new Map<string, Array<Record<string, unknown>>>();
          for (const e of (events ?? []) as Array<Record<string, unknown> & { run_id: string }>) {
            const list = byRun.get(e.run_id) ?? [];
            list.push(e);
            byRun.set(e.run_id, list);
          }
          return Response.json({
            ok: true,
            runs: rows.map((r) => ({ ...r, flow_name: r.flows?.name ?? "Flow", events: byRun.get(r.id) ?? [] })),
          });
        }

        const denied = await requirePermission(auth, "flows_v2.edit", "edit flows");
        if (denied) return denied;

        if (body.action === "list") {
          const { data } = await db
            .from("flow_triggers")
            .select("id, flow_id, kind, config, is_enabled, created_at")
            .eq("organization_id", org)
            .eq("flow_id", body.flow_id)
            .order("created_at", { ascending: true });
          const mine = (data ?? []) as Array<{ id: string; kind: string; config: Record<string, unknown>; is_enabled: boolean }>;
          // Fires per trigger (recorded by the engine on every start).
          const fires: Record<string, { count: number; last: string | null }> = {};
          if (mine.length) {
            const { data: fireRows } = await db
              .from("flow_trigger_fires")
              .select("trigger_id, fired_at")
              .eq("organization_id", org)
              .in("trigger_id", mine.map((t) => t.id))
              .order("fired_at", { ascending: false })
              .limit(5000);
            for (const f of (fireRows ?? []) as Array<{ trigger_id: string; fired_at: string }>) {
              const e = (fires[f.trigger_id] ??= { count: 0, last: f.fired_at });
              e.count += 1;
            }
          }
          // Keywords shared with other live (published) flows.
          const norm = (k: string) => k.trim().toLowerCase().replace(/\s+/g, " ");
          const conflicts: Array<{ trigger_id: string; keyword: string; other_flow_id: string; other_flow_name: string; other_trigger_id: string; this_wins: boolean }> = [];
          const myKeyword = mine.filter((t) => t.kind === "keyword" && t.is_enabled);
          if (myKeyword.length) {
            const [{ data: others }, { data: live }] = await Promise.all([
              db.from("flow_triggers").select("id, flow_id, config, flows(name)").eq("organization_id", org).eq("kind", "keyword").eq("is_enabled", true).neq("flow_id", body.flow_id),
              db.from("flow_versions").select("flow_id").eq("organization_id", org).eq("status", "published"),
            ]);
            const liveIds = new Set(((live ?? []) as Array<{ flow_id: string }>).map((v) => v.flow_id));
            for (const t of myKeyword) {
              const kws = new Set(((t.config["keywords"] as string[] | undefined) ?? []).map(norm));
              const pr = Number(t.config["priority"] ?? 0);
              for (const o of (others ?? []) as unknown as Array<{ id: string; flow_id: string; config: Record<string, unknown>; flows: { name: string } | null }>) {
                if (!liveIds.has(o.flow_id)) continue;
                const shared = ((o.config["keywords"] as string[] | undefined) ?? []).map(norm).find((k) => kws.has(k));
                if (!shared) continue;
                conflicts.push({ trigger_id: t.id, keyword: shared, other_flow_id: o.flow_id, other_flow_name: o.flows?.name ?? "Another flow", other_trigger_id: o.id, this_wins: pr > Number(o.config["priority"] ?? 0) });
              }
            }
          }
          return Response.json({ ok: true, triggers: mine, fires, conflicts });
        }

        if (body.action === "add") {
          const config = cleanConfig(body.trigger.kind, body.trigger.config);
          const err = configError(body.trigger.kind, config);
          if (err) return jsonError(err);
          const { data, error } = await db
            .from("flow_triggers")
            .insert({ organization_id: org, flow_id: body.flow_id, kind: body.trigger.kind, config, is_enabled: body.trigger.is_enabled, created_by: auth.userId })
            .select("id")
            .single();
          if (error || !data) return jsonError("Couldn't save the trigger.", 500);
          await logServerActivity(db, org, auth.userId, "flow_v2_trigger_added", { flow_id: body.flow_id, kind: body.trigger.kind });
          return Response.json({ ok: true, id: (data as { id: string }).id });
        }

        if (body.action === "update") {
          const patch: Record<string, unknown> = {};
          if (body.trigger.kind) patch["kind"] = body.trigger.kind;
          if (body.trigger.config) patch["config"] = cleanConfig(body.trigger.kind ?? "", body.trigger.config);
          if (body.trigger.is_enabled !== undefined) patch["is_enabled"] = body.trigger.is_enabled;
          await db.from("flow_triggers").update(patch).eq("id", body.trigger_id).eq("organization_id", org);
          return Response.json({ ok: true });
        }

        if (body.action === "win") {
          // This keyword trigger beats every other keyword trigger in the workspace.
          const [{ data: t }, { data: all }] = await Promise.all([
            db.from("flow_triggers").select("id, flow_id, config").eq("id", body.trigger_id).eq("organization_id", org).eq("kind", "keyword").maybeSingle(),
            db.from("flow_triggers").select("id, config").eq("organization_id", org).eq("kind", "keyword"),
          ]);
          const row = t as { id: string; flow_id: string; config: Record<string, unknown> } | null;
          if (!row) return jsonError("Trigger not found.", 404);
          const top = Math.max(0, ...((all ?? []) as Array<{ id: string; config: Record<string, unknown> }>).filter((x) => x.id !== row.id).map((x) => Number(x.config["priority"] ?? 0)));
          await db.from("flow_triggers").update({ config: { ...row.config, priority: Math.min(top + 1, 1000) } }).eq("id", row.id).eq("organization_id", org);
          await logServerActivity(db, org, auth.userId, "flow_v2_keyword_priority_set", { flow_id: row.flow_id });
          return Response.json({ ok: true });
        }

        if (body.action === "remove") {
          await db.from("flow_triggers").delete().eq("id", body.trigger_id).eq("organization_id", org);
          return Response.json({ ok: true });
        }

        // start: manual trigger from the inbox.
        const { data: trig } = await db
          .from("flow_triggers")
          .select("id")
          .eq("organization_id", org)
          .eq("flow_id", body.flow_id)
          .eq("kind", "manual")
          .eq("is_enabled", true)
          .limit(1);
        const manual = ((trig ?? []) as Array<{ id: string }>)[0];
        if (!manual) return jsonError("This flow doesn't allow manual starts — add a “Manual from inbox” trigger first.");
        const { startRun } = await import("@/lib/flow-engine.server");
        const { runId, reason } = await startRun(db, {
          organizationId: org,
          flowId: body.flow_id,
          contactId: body.contact_id,
          conversationId: body.conversation_id ?? null,
          trigger: { kind: "manual", trigger_id: manual.id, by: auth.userId },
        });
        if (!runId) {
          const why =
            reason === "already_running"
              ? "This contact is already in this flow."
              : reason === "not_published"
                ? "Publish the flow first."
                : "Couldn't start the flow.";
          return jsonError(why, 409);
        }
        await logServerActivity(db, org, auth.userId, "flow_v2_manual_start", { flow_id: body.flow_id, contact_id: body.contact_id });
        return Response.json({ ok: true, run_id: runId });
      },
    },
  },
});
