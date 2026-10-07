import { createFileRoute } from "@tanstack/react-router";

/**
 * Flow worker — one tick per minute from pg_cron.
 *
 * Claims a small batch of due scheduled sends (FOR UPDATE SKIP LOCKED inside
 * claim_scheduled_sends) and re-checks every gate at dispatch time before it
 * sends: cancellation/recovery, opt-in class, quiet hours and frequency cap.
 * A failure is terminal — status 'failed' with the provider error — so a bad
 * row can never be retried forever.
 *
 * The tick itself lives in src/lib/flow-worker.server.ts (runFlowWorker).
 */

export const Route = createFileRoute("/api/internal/flow-worker")({
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

        const { runFlowWorker } = await import("@/lib/flow-worker.server");
        return Response.json(await runFlowWorker());
      },
    },
  },
});
