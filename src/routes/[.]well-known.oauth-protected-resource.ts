import { createFileRoute } from "@tanstack/react-router";

/** Batch 52: RFC 9728 metadata for AiDwar MCP (also at …/oauth-protected-resource/mcp). */
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
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
