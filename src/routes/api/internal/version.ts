import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/** Which build is actually serving this request. */
export const Route = createFileRoute("/api/internal/version")({
  server: {
    handlers: {
      GET: async () => Response.json(buildInfo()),
    },
  },
});
