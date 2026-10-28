import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): a free-form message inside the customer's 24-hour
 * window — text, a file, reply buttons or a list. Outside the window: 409
 * window_closed (send a template). The key, the public_api flag and the rate
 * limits are checked before the body is read (runApiRoute); the send itself
 * is sendSessionViaApi (src/lib/public-api-session.server.ts). Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/messages/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { MAX_REQUEST_BYTES } = await import("@/lib/public-api-send.server");
        const { sendSessionViaApi } = await import("@/lib/public-api-session.server");
        return runApiRoute(
          request,
          { step: "session_send", body: { maxBytes: MAX_REQUEST_BYTES } },
          ({ supabase, caller, body }) =>
            sendSessionViaApi(supabase, caller, body, {
              idempotencyHeader: request.headers.get("idempotency-key"),
            }),
        );
      },
    },
  },
});
