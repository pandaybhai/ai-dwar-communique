import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 53: the AI assistants page (/app/ai-assistants).
 * GET  ?organization_id=&app=&member= -> apps, what the AI did, usage, switch state (mcp.use).
 * POST { organization_id, action: "set_access", enabled } -> the workspace's
 *      AiDwar MCP On/Off (settings.manage), audit-logged.
 */
export const Route = createFileRoute("/api/ai-assistants")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const { resolveEffectivePermissions } = await import("@/lib/permissions.server");
        const { mcpUseAllowed } = await import("@/lib/mcp-access.server");
        const perms = await resolveEffectivePermissions(auth.supabase, auth.organizationId, auth.userId);
        if (!(await mcpUseAllowed(auth.supabase, perms.keys)))
          return jsonError("You don't have permission to use AI assistants in this workspace.", 403);
        const { assistantsOverview } = await import("@/lib/mcp-workspace.server");
        const overview = await assistantsOverview(
          auth.supabase,
          { organizationId: auth.organizationId, userId: auth.userId, role: auth.role, permissions: new Set(perms.keys) },
          { app: url.searchParams.get("app"), member: url.searchParams.get("member") },
        );
        return Response.json(overview);
      },
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } = await import("@/lib/whatsapp-api.server");
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        if (payload["action"] !== "set_access") return jsonError("Unknown action.");
        if (typeof payload["enabled"] !== "boolean") return jsonError("Say on or off.");
        const denied = await requirePermission(auth, "settings.manage", "switch AI assistants on or off");
        if (denied) return denied;
        const { setMcpAccess } = await import("@/lib/mcp-workspace.server");
        const result = await setMcpAccess(auth.supabase, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          enabled: payload["enabled"],
        });
        if (!result.ok) return jsonError(result.error, result.status);
        return Response.json(result);
      },
    },
  },
});
