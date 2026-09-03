import { createFileRoute } from "@tanstack/react-router";

/** Daily: plan-fee invoices for workspaces without auto-pay, then dunning. */
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
        const { runPlanBilling } = await import("@/lib/plan-billing.server");
        const { runDunning } = await import("@/lib/dunning.server");

        const supabase = getServiceClient();
        const billing = await runPlanBilling(supabase);
        const dunning = await runDunning(supabase);
        return Response.json({ ok: true, billing, dunning });
      },
    },
  },
});
