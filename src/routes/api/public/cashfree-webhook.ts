import { createFileRoute } from "@tanstack/react-router";

/**
 * Cashfree calls this (AiDwar's own billing: orders, refunds, subscriptions).
 * The rules of the money path, as for Razorpay:
 *   verify the signature over the raw body (and a fresh timestamp) -> record
 *   the event once per Cashfree payment -> settle through settlePayment ->
 *   answer 200.
 * A settlement that failed after the money was taken answers 500 so Cashfree
 * delivers again; crediting is idempotent per payment.
 *
 * Events are held like Batch 27 holds them: a delivery takes the row with a
 * lease (webhook_events.lease_until), never processed_at before it ran; a
 * lease that ran out with processed_at still empty is a delivery that died,
 * and the next delivery takes it again.
 */
export const Route = createFileRoute("/api/public/cashfree-webhook")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true }),

      POST: async ({ request }) => {
        const raw = await request.text();
        const signature = request.headers.get("x-webhook-signature") ?? "";
        const timestamp = request.headers.get("x-webhook-timestamp") ?? "";

        const { matchCashfreeSignature, webhookTimestampFresh, cashfreeConfig } =
          await import("@/lib/cashfree.server");
        const config = cashfreeConfig();
        const matched = config
          ? matchCashfreeSignature(raw, timestamp, signature, config.webhookSecrets)
          : null;
        if (!matched) {
          console.warn(
            "[cashfree-webhook] signature not valid",
            JSON.stringify({ configured: Boolean(config) }),
          );
          return new Response("Invalid signature", { status: 401 });
        }
        // Which key and form Cashfree signed with (never the key): confirms the
        // timestamp+body form on the first real delivery.
        console.info("[cashfree-webhook] signature", JSON.stringify(matched));
        if (!webhookTimestampFresh(timestamp)) {
          return new Response("Stale timestamp", { status: 401 });
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return new Response("ok");
        }

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { cashfreeEventKey, handleCashfreeEvent } =
          await import("@/lib/cashfree-billing.server");
        const supabase = getServiceClient();
        const eventKey = cashfreeEventKey(body);

        const claim = await claimCashfreeEvent(supabase, eventKey, body);
        if (claim === "retry") return new Response("retry", { status: 500 });
        if (!claim) return new Response("ok");

        try {
          await handleCashfreeEvent(supabase, body);
          await closeEvent(supabase, claim, null);
        } catch (error) {
          await closeEvent(
            supabase,
            claim,
            error instanceof Error ? error.message.slice(0, 500) : "unknown error",
          );
          const { isSettleError } = await import("@/lib/billing.server");
          if (isSettleError(error)) return new Response("retry", { status: 500 });
        }
        return new Response("ok");
      },
    },
  },
});

type Service = ReturnType<(typeof import("@/lib/whatsapp-webhook.server"))["getServiceClient"]>;
type Claim = { id: string; leased: boolean };

/** How long one delivery holds an event before another may take it. */
export const CASHFREE_EVENT_LEASE_MS = 5 * 60_000;

const missingColumn = (error: { code?: string; message?: string } | null) =>
  Boolean(
    error &&
    (error.code === "42703" ||
      error.code === "PGRST204" ||
      /lease_until/.test(error.message ?? "")),
  );

/**
 * One row per event key: a replay is recognised and dropped — unless the
 * earlier delivery failed (taken again), or died holding it (its lease ran
 * out). Until lease_until exists, a stuck row is taken by received_at age,
 * as the Razorpay webhook does.
 */
async function claimCashfreeEvent(
  supabase: Service,
  eventKey: string | null,
  body: Record<string, unknown>,
): Promise<Claim | "retry" | null> {
  const leaseUntil = () => new Date(Date.now() + CASHFREE_EVENT_LEASE_MS).toISOString();
  const row = {
    provider: "cashfree",
    external_event_id: eventKey,
    payload: body,
    signature_valid: true,
  };

  let leased = true;
  let { data: inserted, error } = await supabase
    .from("webhook_events")
    .insert({ ...row, lease_until: leaseUntil() })
    .select("id")
    .maybeSingle();
  if (missingColumn(error)) {
    leased = false;
    ({ data: inserted, error } = await supabase
      .from("webhook_events")
      .insert(row)
      .select("id")
      .maybeSingle());
  }
  // Not stored = not processed: Cashfree must deliver it again.
  if (error && error.code !== "23505") {
    console.error("[cashfree-webhook] event not stored", eventKey, error.message);
    return "retry";
  }
  if (inserted) return { id: (inserted as { id: string }).id, leased };
  if (!eventKey) return null;

  // Seen before: a delivery that failed is taken again.
  const failedPatch = leased
    ? { error: null, processed_at: null, lease_until: leaseUntil() }
    : { error: null, processed_at: null };
  const { data: retried, error: retryError } = await supabase
    .from("webhook_events")
    .update(failedPatch)
    .eq("provider", "cashfree")
    .eq("external_event_id", eventKey)
    .not("error", "is", null)
    .select("id")
    .maybeSingle();
  if (retryError) return "retry";
  if (retried) return { id: (retried as { id: string }).id, leased };

  // A delivery that died mid-way left it neither processed nor failed.
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - CASHFREE_EVENT_LEASE_MS).toISOString();
  const { data: stuck, error: stuckError } = leased
    ? await supabase
        .from("webhook_events")
        .update({ lease_until: leaseUntil(), received_at: now })
        .eq("provider", "cashfree")
        .eq("external_event_id", eventKey)
        .is("processed_at", null)
        .or(`lease_until.lt.${now},and(lease_until.is.null,received_at.lt.${stale})`)
        .select("id")
        .maybeSingle()
    : await supabase
        .from("webhook_events")
        .update({ received_at: now })
        .eq("provider", "cashfree")
        .eq("external_event_id", eventKey)
        .is("processed_at", null)
        .lt("received_at", stale)
        .select("id")
        .maybeSingle();
  if (stuckError) return "retry";
  return stuck ? { id: (stuck as { id: string }).id, leased } : null;
}

async function closeEvent(supabase: Service, claim: Claim, error: string | null): Promise<void> {
  await supabase
    .from("webhook_events")
    .update({
      processed_at: new Date().toISOString(),
      error,
      ...(claim.leased ? { lease_until: null } : {}),
    })
    .eq("id", claim.id);
}
