import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): one template by name, every language (or ?language=).
 * Another workspace's template is a 404. Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/templates/$name")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { getTemplate } = await import("@/lib/public-api-templates.server");
        return runApiRoute(request, { step: "template_get" }, ({ supabase, caller }) =>
          getTemplate(
            supabase,
            caller,
            decodeURIComponent(String(params.name ?? "")),
            new URL(request.url).searchParams,
          ),
        );
      },
    },
  },
});
