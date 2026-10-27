import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 34): the status of a message the API sent —
 * queued / sent / delivered / read / failed, with its times. Only the key's
 * own workspace (another workspace's id is a 404). Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/messages/$messageId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { authenticateApiKey, takeRateLimit } = await import("@/lib/public-api.server");
        const { apiMessageStatus } = await import("@/lib/public-api-messages.server");
        const supabase = getServiceClient();
        const caller = await authenticateApiKey(supabase, request);
        if (caller instanceof Response) return caller;
        const limited = await takeRateLimit(supabase, caller);
        if (limited) return limited;
        const answer = await apiMessageStatus(
          supabase,
          caller,
          String(params.messageId ?? "").trim(),
        );
        return Response.json(answer.body, { status: answer.status });
      },
    },
  },
});
