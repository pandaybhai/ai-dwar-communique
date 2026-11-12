import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 75: a /start lead becomes "signed up". Called by /signup right after
 * an account is created in the same browser: the lead comes only from the
 * signed /start cookie, and it is linked (demo_leads.linked_user_id) only when
 * the new account is under 15 minutes old and its sign-up number is the
 * lead's number. Always answers 200 with { linked } — it never tells a
 * browser anything about another account.
 */
const RECENT_USER_MS = 15 * 60 * 1000;

export const Route = createFileRoute("/api/public/start-link")({
  server: {
    handlers: {
      GET: async () => Response.json({ error: "Not allowed." }, { status: 405 }),
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { readStartLeadToken, startLeadFromRequest } =
          await import("@/lib/start-lead-cookie.server");
        const { linkStartLeadToUser } = await import("@/lib/start-reminders.server");
        const leadId = await readStartLeadToken(startLeadFromRequest(request));
        let userId = "";
        try {
          const body = JSON.parse((await request.text()).slice(0, 2000)) as Record<string, unknown>;
          userId = typeof body["user_id"] === "string" ? body["user_id"] : "";
        } catch {
          userId = "";
        }
        if (!leadId || !/^[0-9a-f-]{36}$/i.test(userId)) return Response.json({ linked: false });
        const linked = await linkStartLeadToUser(getServiceClient(), {
          leadId,
          userId,
          recentMs: RECENT_USER_MS,
        });
        return Response.json({ linked });
      },
    },
  },
});
