import { createFileRoute } from "@tanstack/react-router";

/** Public API v1.2 (Batch 38): Assign the customer's conversation to a team member (email or user id), or unassign it with null. */
export const Route = createFileRoute("/api/v1/conversations/$phone/assign")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { MAX_INBOX_REQUEST_BYTES, assignConversation } =
          await import("@/lib/public-api-inbox.server");
        return runV1Route(
          request,
          { step: "conversation_assign", body: { maxBytes: MAX_INBOX_REQUEST_BYTES } },
          ({ supabase, caller, body }) =>
            assignConversation(supabase, caller, String(params.phone ?? ""), body),
        );
      },
    },
  },
});
