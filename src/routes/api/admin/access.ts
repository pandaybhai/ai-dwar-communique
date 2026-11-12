import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 76: the signed-in person's own admin role ("super_admin" | "sales"),
 * and whether they belong to any workspace — so /admin can show a sales
 * member Leads & Demos only, and log-in can take a sales-only person straight
 * there. Answers about the caller only; 403 for anyone without a role.
 */
export const Route = createFileRoute("/api/admin/access")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireAdminRole, hasWorkspace } = await import("@/lib/admin-access.server");
        const auth = await requireAdminRole(request, ["super_admin", "sales"]);
        if (auth instanceof Response) return auth;
        return Response.json({
          role: auth.role,
          has_workspace: await hasWorkspace(auth.supabase, auth.userId),
        });
      },
    },
  },
});
