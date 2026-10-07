import { createFileRoute } from "@tanstack/react-router";

/**
 * Drains queued billing notices: WhatsApp ones, then email ones (a separate
 * drain that does nothing until RESEND_API_KEY is set). Cron-only, same
 * guard as every worker.
 */
export const Route = createFileRoute("/api/internal/billing-notify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { secretEquals } = await import("@/lib/cron-auth.server");
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || !secretEquals(provided, expected)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { drainBillingNotifications } = await import("@/lib/billing-notify.server");
        const { drainEmailNotices } = await import("@/lib/email-notices.server");

        const supabase = getServiceClient();
        const counts = await drainBillingNotifications(supabase, 50);
        const email = await drainEmailNotices(supabase, 20);
        return Response.json({ ok: true, ...counts, email });
      },
    },
  },
});
