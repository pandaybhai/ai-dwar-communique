import { createFileRoute } from "@tanstack/react-router";

/**
 * Razorpay calls this. The rules of the money path:
 *   verify the signature over the raw body -> record the event once ->
 *   credit the wallet -> answer 200.
 * Anything after a valid signature answers 200, except a settlement that
 * failed after the money was taken: that answers 500 so Razorpay delivers the
 * event again, and the redelivery (same event id, recorded with an error) is
 * processed again — crediting is idempotent per payment.
 */
export const Route = createFileRoute("/api/public/razorpay-webhook")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true }),

      POST: async ({ request }) => {
        const raw = await request.text();
        const signature = request.headers.get("x-razorpay-signature") ?? "";
        const eventId = request.headers.get("x-razorpay-event-id") ?? null;

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { verifyWebhookSignature, razorpayWebhookSecret } = await import(
          "@/lib/razorpay.server"
        );
        const supabase = getServiceClient();

        const secret = await razorpayWebhookSecret(supabase);
        if (!secret || !signature || !verifyWebhookSignature(raw, signature, secret)) {
          return new Response("Invalid signature", { status: 401 });
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return new Response("ok");
        }

        // One row per Razorpay event id: a replay is recognised and dropped —
        // unless the earlier delivery failed, when it is taken again.
        const { data: inserted, error: recordError } = await supabase
          .from("webhook_events")
          .insert({
            provider: "razorpay",
            external_event_id: eventId,
            payload: body,
            signature_valid: true,
          })
          .select("id")
          .maybeSingle();
        // Not stored = not processed: Razorpay must deliver it again.
        if (recordError && recordError.code !== "23505") {
          console.error("[razorpay-webhook] event not stored", eventId, recordError.message);
          return new Response("retry", { status: 500 });
        }
        let recorded = inserted as { id: string } | null;
        if (recordError?.code === "23505" && eventId) {
          const { data: retry, error: retryError } = await supabase
            .from("webhook_events")
            .update({ error: null, processed_at: null })
            .eq("provider", "razorpay")
            .eq("external_event_id", eventId)
            .not("error", "is", null)
            .select("id")
            .maybeSingle();
          if (retryError) return new Response("retry", { status: 500 });
          recorded = (retry as { id: string } | null) ?? null;
          if (!recorded) {
            // A delivery that died mid-way left the row neither processed nor
            // failed: taken again once it is RAZORPAY_STUCK_MS old. received_at
            // moves to now as the claim, so two redeliveries can't both take it.
            const { data: stuck, error: stuckError } = await supabase
              .from("webhook_events")
              .update({ received_at: new Date().toISOString() })
              .eq("provider", "razorpay")
              .eq("external_event_id", eventId)
              .is("processed_at", null)
              .lt("received_at", new Date(Date.now() - RAZORPAY_STUCK_MS).toISOString())
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
const RAZORPAY_STUCK_MS = 5 * 60_000;

function entity(body: AnyRecord, key: string): AnyRecord | null {
  const payload = (body["payload"] ?? {}) as AnyRecord;
  const wrapper = (payload[key] ?? {}) as AnyRecord;
  return (wrapper["entity"] as AnyRecord | undefined) ?? null;
}

function ourPaymentId(...candidates: (AnyRecord | null)[]): string | null {
  for (const item of candidates) {
    const notes = (item?.["notes"] ?? {}) as AnyRecord;
    const id = notes["payment_id"];
    if (typeof id === "string" && id.length > 0) return id;
    const reference = item?.["reference_id"];
    if (typeof reference === "string" && reference.length > 0) return reference;
  }
  return null;
}

async function handleEvent(
  supabase: Awaited<ReturnType<typeof import("@/lib/whatsapp-webhook.server")["getServiceClient"]>>,
  body: AnyRecord,
): Promise<void> {
  const event = String(body["event"] ?? "");
  const payment = entity(body, "payment");
  const link = entity(body, "payment_link");

  if (event === "payment_link.paid" || event === "payment.captured") {
    const paymentId = ourPaymentId(link, payment);
    if (!paymentId) return;
    const { settlePayment } = await import("@/lib/billing.server");
    await settlePayment(
      supabase,
      paymentId,
      (payment?.["id"] as string | undefined) ?? null,
      body,
    );
    return;
  }

  if (event.startsWith("subscription.")) {
    const subscription = entity(body, "subscription");
    if (!subscription) return;
    const { applySubscriptionEvent } = await import("@/lib/subscriptions.server");
    await applySubscriptionEvent(supabase, event, subscription, payment, body);
    return;
  }

  if (event === "payment.failed") {
    const paymentId = ourPaymentId(link, payment);
    if (!paymentId) return;
    await supabase
      .from("payments")
      .update({ status: "failed", raw: body })
      .eq("id", paymentId)
      .eq("status", "created");
  }
}
