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
        const {
          getServiceClient,
          verifyMetaSignature,
          processWebhookPayload,
          reprocessUnprocessedEvents,
        } = await import("@/lib/whatsapp-webhook.server");

        const rawBody = await request.text();
        const signatureValid = await verifyMetaSignature(
          rawBody,
          request.headers.get("x-hub-signature-256"),
          process.env["META_APP_SECRET"],
        );

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          payload = { _unparsable: rawBody.slice(0, 5000) };
        }

        const supabase = getServiceClient();
        const { data: event } = await supabase
          .from("webhook_events")
          .insert({ provider: "meta", payload, signature_valid: signatureValid })
          .select("id")
          .single();

        // Catch-up: background work is terminated after the response on this
        // host, so anything stale is retried inline here.
        try {
          await reprocessUnprocessedEvents(supabase, { olderThanSeconds: 60 });
        } catch {
          // never block the 200
        }

        // Process synchronously; never process unverified payloads.
        if (signatureValid && event) {
          try {
            await processWebhookPayload(supabase, event.id as string, payload);
          } catch {
            // processWebhookPayload records its own errors
          }
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
