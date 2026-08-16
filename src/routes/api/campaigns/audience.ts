import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/campaigns/audience")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { audienceSummary } = await import("@/lib/campaigns.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        // The number is part of the request: opt-out state is workspace-wide,
        // but sendability belongs to a number, so the count is re-run whenever
        // the picker changes. An account id that isn't ours is rejected.
        const accountId = (payload["whatsapp_account_id"] as string | null) || null;
        if (accountId) {
          const { resolveAccount } = await import("@/lib/whatsapp-numbers.server");
          const { account } = await resolveAccount(auth.supabase, auth.organizationId, accountId);
          if (!account) return jsonError("That number isn't connected to this workspace.");
        }

        try {
          const summary = await audienceSummary(
            auth.supabase,
            auth.organizationId,
            (payload["segment_id"] as string | null) ?? null,
          );
          return Response.json(summary);
        } catch {
          return jsonError("We couldn't work out this audience. Please try again.", 500);
        }

      },
    },
  },
});
