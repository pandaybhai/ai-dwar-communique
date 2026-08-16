import { createFileRoute } from "@tanstack/react-router";

/**
 * The AI tool broker's HTTP surface.
 *
 * POST { action: "list" } -> the tools this person may use, as JSON Schema
 * POST { action: "invoke", tool, arguments } -> runs one tool
 *
 * organization_id is taken from the authenticated membership, never from the
 * model's arguments.
 */
export const Route = createFileRoute("/api/ai/tools")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { brokerTools, invokeTool } = await import("@/lib/ai-tools.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const action = String(payload["action"] ?? "list");

        if (action === "list") {
          const tools = await brokerTools(auth.supabase, auth.organizationId, auth.userId);
          return Response.json({ tools });
        }

        if (action === "invoke") {
          const tool = String(payload["tool"] ?? "");
          if (!tool) return jsonError("Name the tool to run.");
          const args = (payload["arguments"] ?? {}) as Record<string, unknown>;
          const initiatedBy = payload["initiated_by"] === "ai" ? "ai" : "human";
          const result = await invokeTool(
            {
              supabase: auth.supabase,
              organizationId: auth.organizationId,
              actorUserId: auth.userId,
              initiatedBy,
            },
            tool,
            args,
            { confirmed: payload["confirmed"] === true },
          );
          return Response.json(result, { status: result.ok ? 200 : 400 });
        }

        return jsonError("Unknown action.");
      },
    },
  },
});
