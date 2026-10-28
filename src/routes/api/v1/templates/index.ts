import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): the workspace's templates on the number the API
 * sends from — name, language, category, status, components, rejection
 * reason, and what a send must fill (listTemplates,
 * src/lib/public-api-templates.server.ts). Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/templates/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { listTemplates } = await import("@/lib/public-api-templates.server");
        return runApiRoute(request, { step: "templates_list" }, ({ supabase, caller }) =>
          listTemplates(supabase, caller, new URL(request.url).searchParams),
        );
      },
    },
  },
});
