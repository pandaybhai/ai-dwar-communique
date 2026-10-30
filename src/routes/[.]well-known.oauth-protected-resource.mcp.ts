import { createFileRoute } from "@tanstack/react-router";

/** Batch 52: RFC 9728 metadata at the path form for /mcp (clients try this first). */
export const Route = createFileRoute("/.well-known/oauth-protected-resource/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { metadataResponse } = await import("@/lib/mcp-auth.server");
        return metadataResponse(new URL(request.url).origin);
      },
      OPTIONS: async () => {
        const { CORS_HEADERS } = await import("@/lib/mcp-auth.server");
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      },
    },
  },
});
