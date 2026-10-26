import { createFileRoute } from "@tanstack/react-router";

/**
 * The merchant's own Cashfree account calls this when a flow's payment link
 * is paid. Verified with that workspace's webhook secret; the run is resumed
 * on its "Paid" path once (idempotent via the run's event key).
 * AiDwar's own billing webhook (/api/public/cashfree-webhook) is separate.
 */
export const Route = createFileRoute("/api/public/cashfree-flow-webhook/$orgId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const orgId = params.orgId;
        if (!/^[0-9a-f-]{36}$/i.test(orgId)) return new Response("Not found", { status: 404 });
        const raw = await request.text();
        const signature = request.headers.get("x-webhook-signature") ?? "";
        const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { cashfreeWebhookSecretFor } = await import("@/lib/flow-connections.server");
        const { verifyWebhookSignature } = await import("@/lib/cashfree.server");
        const svc = getServiceClient();
        const secret = await cashfreeWebhookSecretFor(svc, orgId);
        if (!secret || !signature || !timestamp || !verifyWebhookSignature(timestamp, raw, signature, secret)) {
          return new Response("Invalid signature", { status: 401 });
        }
        let body: {
          type?: string;
          data?: {
            link_status?: string;
            cf_link_id?: number | string;
            link_id?: string;
            link_notes?: Record<string, string>;
          };
        };
        try {
          body = JSON.parse(raw);
        } catch {
          return new Response("ok");
        }
        if (body.type !== "PAYMENT_LINK_EVENT" || body.data?.link_status !== "PAID") {
          return new Response("ok");
        }
        const notes = body.data.link_notes ?? {};
        if (notes["aidwar_org"] !== orgId || !notes["aidwar_run"] || !notes["aidwar_node"]) {
          return new Response("ok");
        }
        try {
          const { resumePaidRun } = await import("@/lib/flow-engine.server");
          await resumePaidRun(svc, {
            organizationId: orgId,
            runId: notes["aidwar_run"],
            nodeId: notes["aidwar_node"],
            paymentLinkId: String(body.data.cf_link_id ?? body.data.link_id ?? ""),
          });
        } catch (error) {
          // Not resumed: Cashfree delivers it again. A run that already took
          // this payment is a no-op on the retry (its event key), so a retry
          // never pays a path twice.
          console.error("[cashfree-flow-webhook] resume failed", orgId, error instanceof Error ? error.message : String(error));
          return new Response("retry", { status: 500 });
        }
        return new Response("ok");
      },
    },
  },
});
