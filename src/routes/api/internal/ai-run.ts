import { createFileRoute } from "@tanstack/react-router";

/**
 * The one endpoint that runs the AI employee.
 *
 * Callers are either a signed-in person (bearer token, must hold ai.use) or
 * the platform itself (x-cron-secret). The workspace is taken from the
 * caller's membership or, for platform calls, validated against the body —
 * never trusted blindly.
 *
 * Actions:
 *   suggest_reply | summarise | auto_tag  -> inbox helpers
 *   playground                            -> a test answer, sends nothing
 *   compare                               -> two configurations over N questions
 */
export const Route = createFileRoute("/api/internal/ai-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const action = String(payload["action"] ?? "");
        const cronSecret = process.env["CRON_SECRET"];
        const providedSecret =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        const isPlatform = Boolean(cronSecret) && providedSecret === cronSecret;

        let supabase;
        let organizationId: string;
        let actorUserId: string | null = null;
        let actingRole: string | null = null;

        if (isPlatform) {
          supabase = getServiceClient();
          organizationId = String(payload["organization_id"] ?? "");
          if (!organizationId) return jsonError("organization_id is required.");
        } else {
          const auth = await requireOrgMember(
            request,
            (payload["organization_id"] as string) ?? null,
          );
          if (isResponse(auth)) return auth;
          const denied = await requirePermission(auth, "ai.use", "use the AI employee");
          if (denied) return denied;
          supabase = auth.supabase;
          organizationId = auth.organizationId;
          actorUserId = auth.userId;
          actingRole = auth.role;
        }

        const common = { organizationId, actorUserId, actingRole };
        const tasks = await import("@/lib/ai-tasks.server");

        try {
          if (action === "suggest_reply" || action === "summarise" || action === "auto_tag") {
            const conversationId = String(payload["conversation_id"] ?? "");
            if (!conversationId) return jsonError("Which conversation?");
            if (action === "suggest_reply") {
              const run = await tasks.suggestReply(supabase, common, conversationId);
              return Response.json({ run });
            }
            if (action === "summarise") {
              const run = await tasks.summariseConversation(supabase, common, conversationId);
              return Response.json({ run });
            }
            const { run, tags } = await tasks.autoTag(supabase, common, conversationId);
            return Response.json({ run, tags });
          }

          if (action === "playground") {
            const question = String(payload["question"] ?? "").trim();
            if (!question) return jsonError("Ask something first.");
            const run = await tasks.playgroundAnswer(
              supabase,
              common,
              question,
              (payload["brain"] as { provider: string; model_id: string } | null) ?? null,
              (payload["instructions"] as string | null) ?? null,
            );
            return Response.json({ run });
          }

          if (action === "compare") {
            const { runComparison } = await import("@/lib/ai-comparison.server");
            const result = await runComparison(supabase, common, {
              questions: Array.isArray(payload["questions"])
                ? (payload["questions"] as unknown[]).map(String)
                : [],
              configA: payload["config_a"] as Record<string, unknown>,
              configB: payload["config_b"] as Record<string, unknown>,
            });
            return Response.json(result);
          }

          return jsonError("Unknown action.");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "The AI couldn't complete that.";
          console.error("[ai-run] failed", action, message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
