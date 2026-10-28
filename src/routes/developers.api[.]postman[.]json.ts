import { createFileRoute } from "@tanstack/react-router";

/**
 * The Public API's Postman collection (Batch 37), generated from the same
 * description as /developers/api (postmanCollection,
 * src/lib/public-api-spec.ts), so the two never drift. Public; no key in it.
 */
export const Route = createFileRoute("/developers/api.postman.json")({
  server: {
    handlers: {
      GET: async () => {
        const { postmanCollection } = await import("@/lib/public-api-spec");
        return new Response(JSON.stringify(postmanCollection(), null, 2), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition":
              'attachment; filename="aidwar-public-api.postman_collection.json"',
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
