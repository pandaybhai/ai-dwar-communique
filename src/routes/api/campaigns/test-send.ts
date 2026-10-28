import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 35: "Send a test" from the campaign wizard. action "quote" answers what
 * the test costs and how many tests are left; action "send" sends it.
 */
export const Route = createFileRoute("/api/campaigns/test-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(
          request,
          (payload["organization_id"] as string) ?? null,
        );
        if (isResponse(auth)) return auth;

        const { campaignTestSend, parseTestSendBody } =
          await import("@/lib/campaign-test-send.server");
        const answer = await campaignTestSend(auth, parseTestSendBody(payload));
        if (!answer.ok) {
          return Response.json(
            { error: answer.error, ...(answer.quote ? { quote: answer.quote } : {}) },
            { status: answer.status },
          );
        }
        return Response.json(answer);
      },
    },
  },
});
