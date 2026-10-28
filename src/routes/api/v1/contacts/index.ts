import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): GET lists the workspace's contacts (cursor, filter by
 * tag / opt-in / updated_since); POST upserts one by phone (name, attributes,
 * tags, opted_in — consent source "api", never flips an opt-out). Key, flag
 * and rate limits first (runApiRoute); the work is
 * src/lib/public-api-contacts.server.ts. Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/contacts/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { listContacts } = await import("@/lib/public-api-contacts.server");
        return runApiRoute(request, { step: "contacts_list" }, ({ supabase, caller }) =>
          listContacts(supabase, caller, new URL(request.url).searchParams),
        );
      },
      POST: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { upsertOneContact } = await import("@/lib/public-api-contacts.server");
        return runApiRoute(
          request,
          { step: "contacts_upsert", body: { maxBytes: 256 * 1024 } },
          ({ supabase, caller, body }) => upsertOneContact(supabase, caller, body),
        );
      },
    },
  },
});
