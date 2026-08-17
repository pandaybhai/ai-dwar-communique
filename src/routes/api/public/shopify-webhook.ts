import { createFileRoute } from "@tanstack/react-router";

/**
 * Shopify webhook receiver.
 *
 * Same discipline as the Meta webhook: verify the signature, record the raw
 * event, answer 200 fast. Shopify retries hard, so the event id is the
 * idempotency key — a repeat delivery must never double-apply.
 */
export const Route = createFileRoute("/api/public/shopify-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { shopifyCredentials, verifyWebhookHmac, normalizeShopDomain, getServiceClient } =
          await import("@/lib/shopify.server");

        const creds = shopifyCredentials();
        if (!creds) return new Response("Not configured", { status: 503 });

        const rawBody = await request.text();
        const signature = request.headers.get("x-shopify-hmac-sha256");

        // Nothing is trusted, parsed or stored before the HMAC verifies.
        if (!(await verifyWebhookHmac(rawBody, signature, creds.apiSecret))) {
          return new Response("Invalid signature", { status: 401 });
        }

        const topic = request.headers.get("x-shopify-topic") ?? "";
        const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain"));
        const eventId =
          request.headers.get("x-shopify-event-id") ??
          request.headers.get("x-shopify-webhook-id") ??
          `${topic}:${shopDomain}:${Date.now()}`;

        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const service = getServiceClient();

        // Insert-first idempotency: the unique event id makes a retry a no-op.
        const { data: inserted, error } = await service
          .from("webhook_events")
          .insert({
            provider: "shopify",
            external_event_id: eventId,
            signature_valid: true,
            payload: { topic, shop_domain: shopDomain, body: payload },
          })
          .select("id")
          .maybeSingle();

        if (error) {
          // Duplicate delivery of an event we already have — acknowledge it.
          return new Response("ok", { status: 200 });
        }

        const eventRowId = (inserted as { id: string } | null)?.id ?? null;

        const { processShopifyWebhook } = await import("@/lib/shopify-webhook.server");
        await processShopifyWebhook({
          supabase: service,
          topic,
          shopDomain,
          payload,
          eventRowId,
        });

        return new Response("ok", { status: 200 });
      },
    },
  },
});
