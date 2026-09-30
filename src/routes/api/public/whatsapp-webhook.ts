import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/whatsapp-webhook")({
  server: {
    handlers: {
      // Meta verification handshake
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        const expected = process.env["META_WEBHOOK_VERIFY_TOKEN"];

        if (mode === "subscribe" && expected && token === expected) {
          return new Response(challenge, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("Forbidden", { status: 403 });
      },

      POST: async ({ request }) => {
        const { getServiceClient, verifyMetaSignature, acceptWebhook, waitUntilOf } = await import(
          "@/lib/whatsapp-webhook.server"
        );

        const rawBody = await request.text();
        const signatureValid = await verifyMetaSignature(
          rawBody,
          request.headers.get("x-hub-signature-256"),
          process.env["META_APP_SECRET"],
        );

        // Stored, then 200 straight away; processing continues after the
        // response. Catch-up for stale events lives in /api/internal/reprocess-events.
        return acceptWebhook(getServiceClient(), {
          rawBody,
          signatureValid,
          waitUntil: waitUntilOf(request),
        });
      },

    },
  },
});
