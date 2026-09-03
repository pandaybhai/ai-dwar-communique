import { createFileRoute } from "@tanstack/react-router";

/** Drains queued billing notices. Cron-only, same guard as every worker. */
export const Route = createFileRoute("/api/internal/billing-notify")({
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
        const { drainBillingNotifications } = await import("@/lib/billing-notify.server");

        const counts = await drainBillingNotifications(getServiceClient(), 50);
        return Response.json({ ok: true, ...counts });
      },
    },
  },
});
