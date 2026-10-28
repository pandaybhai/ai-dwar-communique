import { createFileRoute } from "@tanstack/react-router";

/**
 * The API's OpenAPI 3.1 description (Batch 38 item 8), generated from the
 * same description as the docs and the Postman collection
 * (openApiDocument, src/lib/public-api-openapi.ts). Public; no key in it.
 */
export const Route = createFileRoute("/developers/openapi.json")({
  server: {
    handlers: {
      GET: async () => {
        const { openApiDocument } = await import("@/lib/public-api-openapi");
        return new Response(JSON.stringify(openApiDocument(), null, 2), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
