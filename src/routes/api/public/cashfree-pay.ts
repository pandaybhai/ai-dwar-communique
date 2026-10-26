import { createFileRoute } from "@tanstack/react-router";

/**
 * The pay page's server side (/pay/<payment id>): what is due and the
 * checkout session for one Cashfree payment, and — after the checkout comes
 * back — our own confirmation with Cashfree (GET order). The redirect is
 * never trusted: only Cashfree's answer to our server settles a payment.
 *
 * Public by design (an invoice link is opened from WhatsApp, maybe not signed
 * in): the payment id is an unguessable uuid, and what goes out is the amount
 * due and Cashfree's session id — never a key, never another workspace's data.
 */
const PURPOSE_COPY: Record<string, string> = {
  credit_purchase: "AiDwar credits",
  plan_fee: "AiDwar plan fee",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/public/cashfree-pay")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const paymentId = new URL(request.url).searchParams.get("payment_id") ?? "";
        if (!UUID.test(paymentId))
          return Response.json({ error: "We couldn't find that payment." }, { status: 404 });
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const supabase = getServiceClient();
        const { data } = await supabase
          .from("payments")
          .select("id, provider, purpose, status, currency, raw")
          .eq("id", paymentId)
          .maybeSingle();
        const row = (data ?? null) as Record<string, unknown> | null;
        if (!row || row["provider"] !== "cashfree") {
          return Response.json({ error: "We couldn't find that payment." }, { status: 404 });
        }
        const raw = (row["raw"] ?? {}) as Record<string, unknown>;
        const cash = (raw["cashfree"] ?? {}) as Record<string, unknown>;
        const status = String(row["status"]);
        const sessionId =
          typeof cash["payment_session_id"] === "string"
            ? (cash["payment_session_id"] as string)
            : "";
        // A failed try (card declined, customer left) can be paid again on the
        // same order — unless Cashfree closed it or a newer payment replaced it.
        const failure = (raw["failure"] ?? {}) as Record<string, unknown>;
        const closed =
          raw["reason"] === "superseded" ||
          failure["order_status"] === "EXPIRED" ||
          failure["order_status"] === "TERMINATED" ||
          (typeof raw["expires_at"] === "string" &&
            Date.parse(raw["expires_at"] as string) < Date.now());
        const payable =
          (status === "pending" || status === "failed") && Boolean(sessionId) && !closed;
        return Response.json({
          status: status === "paid" ? "paid" : status === "failed" ? "failed" : "pending",
          amount: Number(raw["gross_amount"] ?? raw["gross"] ?? 0),
          currency: String(row["currency"] ?? "INR"),
          label: PURPOSE_COPY[String(row["purpose"])] ?? "AiDwar payment",
          checkout: payable
            ? {
                payment_session_id: sessionId,
                mode: cash["env"] === "production" ? "production" : "sandbox",
              }
            : null,
        });
      },

      POST: async ({ request }) => {
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Invalid request." }, { status: 400 });
        }
        const paymentId = String(payload["payment_id"] ?? "");
        if (!UUID.test(paymentId))
          return Response.json({ error: "We couldn't find that payment." }, { status: 404 });
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { confirmCashfreePayment } = await import("@/lib/cashfree-billing.server");
        try {
          const result = await confirmCashfreePayment(getServiceClient(), paymentId);
          return Response.json({ status: result.status });
        } catch {
          // settlePayment told an admin and the webhook retries it.
          return Response.json({ status: "pending" });
        }
      },
    },
  },
});
