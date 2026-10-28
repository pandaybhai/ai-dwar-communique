import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 37): the workspace's wallet balance and per-category
 * message prices (accountBalance, src/lib/public-api-account.server.ts).
 * Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/account/balance")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { accountBalance } = await import("@/lib/public-api-account.server");
        return runApiRoute(request, { step: "account_balance" }, ({ supabase, caller }) =>
          accountBalance(supabase, caller, new URL(request.url).searchParams),
        );
      },
    },
  },
});
