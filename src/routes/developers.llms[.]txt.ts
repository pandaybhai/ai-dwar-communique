import { createFileRoute } from "@tanstack/react-router";

/**
 * The docs for AI coding tools (Batch 38 item 9, llmstxt.org): what the docs hold, a link per page,
 * generated from the same content as /developers.
 */
export const Route = createFileRoute("/developers/llms.txt")({
  server: {
    handlers: {
      GET: async () => {
        const { llmsTxt } = await import("@/lib/developer-portal");
        return new Response(llmsTxt(), {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
