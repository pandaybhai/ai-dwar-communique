import { createFileRoute } from "@tanstack/react-router";

/**
 * The monthly money run, in one place: plan fees, the dunning ladder, and a
 * backfill that issues any paid-but-still-draft invoice. Every step is
 * idempotent, so a repeated call costs nothing.
 */
export const Route = createFileRoute("/api/internal/billing-monthly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { runPlanBilling } = await import("@/lib/plan-billing.server");
        const { runDunning } = await import("@/lib/dunning.server");
        const { issuePendingInvoices } = await import("@/lib/invoices.server");

        const supabase = getServiceClient();
        const billing = await runPlanBilling(supabase);
        const dunning = await runDunning(supabase);
        const backfill = await issuePendingInvoices(supabase);
        return Response.json({ ok: true, billing, dunning, backfill });
      },
    },
  },
});
