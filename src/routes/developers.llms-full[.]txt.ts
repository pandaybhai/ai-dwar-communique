import { createFileRoute } from "@tanstack/react-router";

/**
 * The docs for AI coding tools (Batch 38 item 9, llmstxt.org): every docs page as Markdown, in one file,
 * generated from the same content as /developers.
 */
export const Route = createFileRoute("/developers/llms-full.txt")({
  server: {
    handlers: {
      GET: async () => {
        const { llmsFullTxt } = await import("@/lib/developer-portal");
        return new Response(llmsFullTxt(), {
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
