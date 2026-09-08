import { createFileRoute } from "@tanstack/react-router";

/** Read-only numbers for the workspace Home page. Any member may read them. */
export const Route = createFileRoute("/api/home/summary")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;

        try {
          const { getHomeSummary } = await import("@/lib/home.server");
          return Response.json(await getHomeSummary(auth.supabase, auth.organizationId));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Couldn't load your overview.";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
