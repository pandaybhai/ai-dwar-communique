import { createFileRoute } from "@tanstack/react-router";

/**
 * Super-admin only (Batch 53): how many people stay on Classic and on Aiden
 * Workspace (their saved choice), the design.switched events of the last N
 * days, and how many workspaces are unlocked. Read with the service role.
 */
async function superAdmin(request: Request) {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError("Not authenticated.", 401);
  // Batch 52: an AI app's OAuth token works only through /mcp.
  const refusedClient = (await import("@/lib/mcp-auth.server")).refuseOAuthClientToken(token);
  if (refusedClient) return refusedClient;
  const supabase = getServiceClient();
  const { data: userData } = await supabase.auth.getUser(token);
  const user = userData.user;
  if (!user) return jsonError("Not authenticated.", 401);
  if (!(await isSuperAdmin(supabase, user.id))) return jsonError("Super Admin access required.", 403);
  return { supabase, userId: user.id };
}

export const Route = createFileRoute("/api/admin/design")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await superAdmin(request);
        if (auth instanceof Response) return auth;
        const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 1), 90);
        const { designCounts } = await import("@/lib/aiden-workspace.server");
        return Response.json(await designCounts(auth.supabase, days));
      },
    },
  },
});
