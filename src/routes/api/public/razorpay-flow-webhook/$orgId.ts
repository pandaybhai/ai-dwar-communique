import { createFileRoute } from "@tanstack/react-router";

/**
 * The merchant's own Razorpay account calls this when a flow's payment link is
 * paid. Verified with that workspace's webhook secret; the run is resumed on
 * its "Paid" path once (idempotent via the run's event key).
 * AiDwar's own billing webhook (/api/public/razorpay-webhook) is separate.
 */
export const Route = createFileRoute("/api/public/razorpay-flow-webhook/$orgId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const orgId = params.orgId;
        if (!/^[0-9a-f-]{36}$/i.test(orgId)) return new Response("Not found", { status: 404 });
        const raw = await request.text();
        const signature = request.headers.get("x-razorpay-signature") ?? "";
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { razorpayWebhookSecretFor } = await import("@/lib/flow-connections.server");
        const { verifyWebhookSignature } = await import("@/lib/razorpay.server");
        const svc = getServiceClient();
        const secret = await razorpayWebhookSecretFor(svc, orgId);
        if (!secret || !signature || !verifyWebhookSignature(raw, signature, secret)) return new Response("Invalid signature", { status: 401 });
        let body: { event?: string; payload?: { payment_link?: { entity?: { id?: string; notes?: Record<string, string> } } } };
        try {
          body = JSON.parse(raw);
        } catch {
          return new Response("ok");
        }
        if (body.event !== "payment_link.paid") return new Response("ok");
        const link = body.payload?.payment_link?.entity;
        const notes = link?.notes ?? {};
        if (notes["aidwar_org"] !== orgId || !notes["aidwar_run"] || !notes["aidwar_node"]) return new Response("ok");
        try {
          const { resumePaidRun } = await import("@/lib/flow-engine.server");
          await resumePaidRun(svc, { organizationId: orgId, runId: notes["aidwar_run"], nodeId: notes["aidwar_node"], paymentLinkId: link?.id ?? "" });
        } catch {
          // Signature was valid; answer 200 so Razorpay doesn't replay.
        }
        return new Response("ok");
      },
    },
  },
});
