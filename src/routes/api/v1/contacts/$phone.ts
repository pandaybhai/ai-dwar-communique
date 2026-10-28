import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): one contact by phone (URL-encode the "+", or leave
 * it out). Another workspace's contact is a 404. Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/contacts/$phone")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { getContact } = await import("@/lib/public-api-contacts.server");
        return runApiRoute(request, { step: "contact_get" }, ({ supabase, caller }) =>
          getContact(supabase, caller, String(params.phone ?? "")),
        );
      },
    },
  },
});
