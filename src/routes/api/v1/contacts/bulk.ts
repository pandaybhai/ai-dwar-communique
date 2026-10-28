import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): upsert up to 1,000 contacts in one call, with a
 * result per row (upsertContactsBulk, src/lib/public-api-contacts.server.ts).
 * Never flips an opt-out. Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/contacts/bulk")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { upsertContactsBulk } = await import("@/lib/public-api-contacts.server");
        return runApiRoute(
          request,
          { step: "contacts_bulk", body: { maxBytes: 5 * 1024 * 1024 } },
          ({ supabase, caller, body }) => upsertContactsBulk(supabase, caller, body),
        );
      },
    },
  },
});
