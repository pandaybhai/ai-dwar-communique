import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): a message's file — what it is and a download link
 * that works for 5 minutes with the same API key (mediaLink,
 * src/lib/public-api-media-links.server.ts). Only the key's own workspace.
 * Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/media/$messageId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { runApiRoute, bearerKeyHash } = await import("@/lib/public-api.server");
        const { mediaLink } = await import("@/lib/public-api-media-links.server");
        return runApiRoute(request, { step: "media_link" }, ({ supabase, caller }) =>
          mediaLink(
            supabase,
            caller,
            bearerKeyHash(request),
            String(params.messageId ?? "").trim(),
          ),
        );
      },
    },
  },
});
