import { createFileRoute } from "@tanstack/react-router";

/**
 * Public Embedded Signup configuration. The Meta app id and the Embedded
 * Signup configuration id are both public values (they ship in the browser
 * SDK call); the app secret never leaves the server.
 */
export const Route = createFileRoute("/api/whatsapp/es-config")({
  server: {
    handlers: {
      GET: async () => {
        const appId = process.env["META_APP_ID"] ?? "";
        const configId = process.env["META_ES_CONFIG_ID"] ?? "";
        return Response.json(
          {
            app_id: appId,
            config_id: configId,
            graph_version: "v25.0",
            available: Boolean(appId && configId),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
