import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): add tags to a contact — { "tags": ["vip", …] }
 * (made in the workspace when new). Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/contacts/$phone/tags")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { changeContactTags } = await import("@/lib/public-api-contacts.server");
        return runApiRoute(
          request,
          { step: "contact_tags_add", body: { maxBytes: 64 * 1024 } },
          ({ supabase, caller, body }) =>
            changeContactTags(
              supabase,
              caller,
              String(params.phone ?? ""),
              "add",
              (body as Record<string, unknown> | null)?.["tags"],
            ),
        );
      },
    },
  },
});
