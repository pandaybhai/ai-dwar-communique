import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";

/**
 * Cashfree calls this for AiDwar's own billing. The same money-path rules as
 * the Razorpay webhook:
 *   verify the signature over the raw body -> record the event once ->
 *   settle -> answer 200.
 * A settlement that failed after the money was taken answers 500 so Cashfree
 * delivers the event again; crediting is idempotent per payment.
 *
 * Cashfree sends no event id, so the dedupe key is a hash of the raw body —
 * a redelivery carries the identical body and is recognised.
 */
export const Route = createFileRoute("/api/public/cashfree-webhook")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true }),

      POST: async ({ request }) => {
        const raw = await request.text();
        const signature = request.headers.get("x-webhook-signature") ?? "";
        const timestamp = request.headers.get("x-webhook-timestamp") ?? "";

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { verifyWebhookSignature, cashfreeWebhookSecret } = await import(
          "@/lib/cashfree.server"
        );
        const supabase = getServiceClient();

        const secret = await cashfreeWebhookSecret(supabase);
        if (!secret || !signature || !timestamp || !verifyWebhookSignature(timestamp, raw, signature, secret)) {
          return new Response("Invalid signature", { status: 401 });
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return new Response("ok");
        }

        const eventId = `cf_${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 40)}`;

        // One row per event: a replay is recognised and dropped — unless the
        // earlier delivery failed, when it is taken again.
        const { data: inserted, error: recordError } = await supabase
          .from("webhook_events")
          .insert({
            provider: "cashfree",
            external_event_id: eventId,
            payload: body,
            signature_valid: true,
          })
          .select("id")
          .maybeSingle();
        // Not stored = not processed: Cashfree must deliver it again.
        if (recordError && recordError.code !== "23505") {
          console.error("[cashfree-webhook] event not stored", eventId, recordError.message);
          return new Response("retry", { status: 500 });
        }
        let recorded = inserted as { id: string } | null;
        if (recordError?.code === "23505") {
          const { data: retry, error: retryError } = await supabase
            .from("webhook_events")
            .update({ error: null, processed_at: null })
            .eq("provider", "cashfree")
            .eq("external_event_id", eventId)
            .not("error", "is", null)
            .select("id")
            .maybeSingle();
          if (retryError) return new Response("retry", { status: 500 });
          recorded = (retry as { id: string } | null) ?? null;
          if (!recorded) {
            // A delivery that died mid-way: taken again once it is
            // CASHFREE_STUCK_MS old; received_at moves to now as the claim.
            const { data: stuck, error: stuckError } = await supabase
              .from("webhook_events")
              .update({ received_at: new Date().toISOString() })
              .eq("provider", "cashfree")
              .eq("external_event_id", eventId)
              .is("processed_at", null)
              .lt("received_at", new Date(Date.now() - CASHFREE_STUCK_MS).toISOString())
              .select("id")
              .maybeSingle();
            if (stuckError) return new Response("retry", { status: 500 });
            recorded = (stuck as { id: string } | null) ?? null;
          }
        }
        if (!recorded) return new Response("ok");

        try {
          await handleEvent(supabase, body);
          await supabase
            .from("webhook_events")
            .update({ processed_at: new Date().toISOString() })
            .eq("id", recorded.id);
        } catch (error) {
          await supabase
            .from("webhook_events")
            .update({
              processed_at: new Date().toISOString(),
              error: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
            })
            .eq("id", recorded.id);
          const { isSettleError } = await import("@/lib/billing.server");
          if (isSettleError(error)) return new Response("retry", { status: 500 });
        }

        return new Response("ok");
      },
    },
  },
});

type AnyRecord = Record<string, unknown>;

/** A stored event still unprocessed after this long belongs to a delivery that died. */
const CASHFREE_STUCK_MS = 5 * 60_000;

function dataOf(body: AnyRecord): AnyRecord {
  return (body["data"] ?? {}) as AnyRecord;
}

async function handleEvent(
  supabase: Awaited<ReturnType<typeof import("@/lib/whatsapp-webhook.server")["getServiceClient"]>>,
  body: AnyRecord,
): Promise<void> {
  const type = String(body["type"] ?? "");
  const data = dataOf(body);

  if (type === "PAYMENT_LINK_EVENT") {
    const status = String(data["link_status"] ?? "");
    const notes = (data["link_notes"] ?? {}) as AnyRecord;
    const paymentId = typeof notes["payment_id"] === "string" ? notes["payment_id"] : null;
    if (!paymentId) return;
    const order = (data["order"] ?? {}) as AnyRecord;

    if (status === "PAID") {
      const { settlePayment } = await import("@/lib/billing.server");
      await settlePayment(
        supabase,
        paymentId,
        (order["order_id"] as string | undefined) ?? null,
        body,
      );
      return;
    }
    if (status === "EXPIRED" || status === "CANCELLED") {
      await supabase
        .from("payments")
        .update({ status: "failed", raw: { ...notes, reason: status.toLowerCase(), event: body } })
        .eq("id", paymentId)
        .in("status", ["created", "pending"]);
    }
    return;
  }

  if (type.startsWith("SUBSCRIPTION_")) {
    const { applyCashfreeSubscriptionEvent } = await import("@/lib/subscriptions.server");
    await applyCashfreeSubscriptionEvent(supabase, type, data, body);
    return;
  }
}
