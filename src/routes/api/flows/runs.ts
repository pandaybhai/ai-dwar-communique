import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  organization_id: z.string().uuid(),
  run_id: z.string().uuid(),
  action: z.enum(["pause", "stop", "resume"]),
});

/** Pause / Stop / Resume a Flows v2 run from the inbox. */
export const Route = createFileRoute("/api/flows/runs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, requirePermission } = await import(
          "@/lib/whatsapp-api.server"
        );
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(await request.json());
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, parsed.organization_id);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "inbox.reply", "control flows");
        if (denied) return denied;
        const { flowsV2Enabled, controlRun } = await import("@/lib/flow-engine.server");
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const service = getServiceClient();
        if (!(await flowsV2Enabled(service, auth.organizationId)))
          return jsonError("Flows v2 isn't switched on for this workspace.", 403);
        const result = await controlRun(service, {
          organizationId: auth.organizationId,
          runId: parsed.run_id,
          action: parsed.action,
          userId: auth.userId,
        });
        if (!result.ok) return jsonError(result.error ?? "Couldn't change the run.");
        await auth.supabase.from("activity_log").insert({
          organization_id: auth.organizationId,
          user_id: auth.userId,
          action: `flow_run_${parsed.action}`,
          details: { run_id: parsed.run_id },
        });
        return Response.json({ ok: true });
      },
    },
  },
});
