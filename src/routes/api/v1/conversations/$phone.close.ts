import { createFileRoute } from "@tanstack/react-router";

/** Public API v1.2 (Batch 38): Close the customer's conversation, as the inbox's Close button. */
export const Route = createFileRoute("/api/v1/conversations/$phone/close")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { setConversationStatus } = await import("@/lib/public-api-inbox.server");
        return runV1Route(request, { step: "conversation_close" }, ({ supabase, caller }) =>
          setConversationStatus(supabase, caller, String(params.phone ?? ""), "closed"),
        );
      },
    },
  },
});
