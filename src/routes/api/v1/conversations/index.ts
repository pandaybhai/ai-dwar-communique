import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): the workspace's conversations, oldest change
 * first, filtered by status / assignee / updated_since, a page at a time.
 */
export const Route = createFileRoute("/api/v1/conversations/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runV1Route } = await import("@/lib/public-api-route.server");
        const { listConversations } = await import("@/lib/public-api-inbox.server");
        return runV1Route(request, { step: "conversation_list" }, ({ supabase, caller }) =>
          listConversations(supabase, caller, new URL(request.url).searchParams),
        );
      },
    },
  },
});
