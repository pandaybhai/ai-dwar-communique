import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): remove one tag from a contact (the tag itself stays
 * in the workspace). Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/contacts/$phone/tags/$tag")({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { changeContactTags } = await import("@/lib/public-api-contacts.server");
        return runApiRoute(request, { step: "contact_tags_remove" }, ({ supabase, caller }) =>
          changeContactTags(supabase, caller, String(params.phone ?? ""), "remove", [
            decodeURIComponent(String(params.tag ?? "")),
          ]),
        );
      },
    },
  },
});
