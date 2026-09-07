import { createFileRoute } from "@tanstack/react-router";

/** Alias of /api/internal/billing-monthly, kept for existing schedules. */
export const Route = createFileRoute("/api/internal/plan-billing")({
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
        return Response.json({ ok: true, alias_of: "billing-monthly", ...(await runMonthlyBilling(getServiceClient())) });
      },
    },
  },
});
