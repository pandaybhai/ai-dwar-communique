import { createFileRoute } from "@tanstack/react-router";

/** Public API v1.2 (Batch 38): Reopen the customer's conversation, as the inbox's Reopen button. */
export const Route = createFileRoute("/api/v1/conversations/$phone/reopen")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { setConversationStatus } = await import("@/lib/public-api-inbox.server");
        return runApiRoute(request, { step: "conversation_reopen" }, ({ supabase, caller }) =>
          setConversationStatus(supabase, caller, String(params.phone ?? ""), "open"),
        );
      },
    },
  },
});
