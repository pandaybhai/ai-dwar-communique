import { createFileRoute } from "@tanstack/react-router";

/** Public API v1.2 (Batch 38): Add or remove the customer's tags (the inbox's labels). */
export const Route = createFileRoute("/api/v1/conversations/$phone/tags")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { MAX_INBOX_REQUEST_BYTES, changeConversationTags } =
          await import("@/lib/public-api-inbox.server");
        return runApiRoute(
          request,
          { step: "conversation_tags", body: { maxBytes: MAX_INBOX_REQUEST_BYTES } },
          ({ supabase, caller, body }) =>
            changeConversationTags(supabase, caller, String(params.phone ?? ""), body),
        );
      },
    },
  },
});
