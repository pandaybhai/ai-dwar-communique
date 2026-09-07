import { createFileRoute } from "@tanstack/react-router";

/** Daily money job: plan fees, the overdue ladder, and the invoice backfill. */
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
        const { runMonthlyBilling } = await import("@/lib/billing-monthly.server");
        return Response.json({ ok: true, ...(await runMonthlyBilling(getServiceClient())) });
      },
    },
  },
});
