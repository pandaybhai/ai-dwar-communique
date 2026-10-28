import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): the bytes of a message's file, for a link from
 * GET /api/v1/media/{message_id} that hasn't expired, with the API key it was
 * made for (mediaDownload, src/lib/public-api-media-links.server.ts).
 */
export const Route = createFileRoute("/api/v1/media/$messageId/download")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { runApiRoute, bearerKeyHash } = await import("@/lib/public-api.server");
        const { mediaDownload } = await import("@/lib/public-api-media-links.server");
        return runApiRoute(request, { step: "media_download" }, ({ supabase, caller }) =>
          mediaDownload(
            supabase,
            caller,
            bearerKeyHash(request),
            String(params.messageId ?? "").trim(),
            new URL(request.url).searchParams,
          ),
        );
      },
    },
  },
});
