import { createFileRoute } from "@tanstack/react-router";

/** Super-admin only: campaigns sending now — speed, progress and ETA. */
export const Route = createFileRoute("/api/admin/sending")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");

        const header = request.headers.get("authorization") ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!token) return jsonError("Not authenticated.", 401);

        const supabase = getServiceClient();
        const { data } = await supabase.auth.getUser(token);
        const user = data.user;
        if (!user) return jsonError("Not authenticated.", 401);
        if (!(await isSuperAdmin(supabase, user.id))) {
          return jsonError("Super Admin access required.", 403);
        }

        const { adminSendingNow } = await import("@/lib/admin-sending.server");
        return Response.json(await adminSendingNow(supabase));
      },
    },
  },
});
