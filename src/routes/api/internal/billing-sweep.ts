import { createFileRoute } from "@tanstack/react-router";

/** Nightly money sweep: warnings, auto top-ups, reminders and expiry. */
export const Route = createFileRoute("/api/internal/billing-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { cronSecretAccepted } = await import("@/lib/cron-auth.server");
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!cronSecretAccepted(provided)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { runBillingSweep } = await import("@/lib/billing-sweep.server");

        const counts = await runBillingSweep(getServiceClient());
        return Response.json({ ok: true, ...counts });
      },
    },
  },
});
