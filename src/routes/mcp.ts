import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 52: AiDwar MCP — https://aidwar.in/mcp. Streamable HTTP, stateless;
 * an AI app signs in through AiDwar's Supabase OAuth server (see
 * /.well-known/oauth-protected-resource/mcp) and acts as that merchant.
 */
const handle = async ({ request }: { request: Request }) => {
  const { handleMcpRequest, liveMcpDeps } = await import("@/lib/mcp-server.server");
  return handleMcpRequest(request, await liveMcpDeps());
};

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: { GET: handle, POST: handle, DELETE: handle, OPTIONS: handle },
  },
});
