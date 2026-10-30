import { createFileRoute } from "@tanstack/react-router";

/**
 * The public price list. No auth, and deliberately no rate cards — what we pay
 * Meta is never part of a public response.
 */
export const Route = createFileRoute("/api/public/plans")({
  server: {
    handlers: {
      GET: async () => {
        const { loadPublicPlans, loadPublicGstRegistered } =
          await import("@/lib/public-plans.server");
        const [plans, gstRegistered] = await Promise.all([
          loadPublicPlans(),
          loadPublicGstRegistered(),
        ]);
        return Response.json(
          { plans, gst_registered: gstRegistered },
          { headers: { "cache-control": "public, max-age=300" } },
        );
      },
    },
  },
});
