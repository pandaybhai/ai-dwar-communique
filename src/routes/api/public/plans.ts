import { createFileRoute } from "@tanstack/react-router";

/**
 * The public price list. No auth, and deliberately no rate cards — what we pay
 * Meta is never part of a public response.
 */
export const Route = createFileRoute("/api/public/plans")({
  server: {
    handlers: {
      GET: async () => {
        const { loadPublicPlans } = await import("@/lib/public-plans.server");
        const plans = await loadPublicPlans();
        return Response.json({ plans }, { headers: { "cache-control": "public, max-age=300" } });
      },
    },
  },
});
