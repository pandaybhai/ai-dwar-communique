import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 40: the first-run journey (/app/start). One route, a few actions:
 *   peek      — a quick look at a website (name, logo, colour); signed in, no workspace needed
 *   state     — where this workspace is (worked out from facts), and what Aiden has learned
 *   begin     — start the journey: keep the brand, queue the Day-0 read (or save a description)
 *   mark      — connect_opened / connect_skipped / dismissed
 *   test      — Meet Aiden: one customer question, answered from the workspace's material
 *   go_live   — Draft or Replying, through the one mode switch
 *   callback  — "Need help? We'll call you"
 */
export const Route = createFileRoute("/api/onboarding/journey")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requireSignedIn, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const action = String(payload["action"] ?? "state");

        if (action === "peek") {
          const caller = await requireSignedIn(request);
          if (isResponse(caller)) return caller;
          const { peekSite } = await import("@/lib/site-peek.server");
          const peek = await peekSite(String(payload["url"] ?? ""));
          return peek.ok ? Response.json(peek) : jsonError(peek.error, 422);
        }

        const auth = await requireOrgMember(
          request,
          (payload["organization_id"] as string) ?? null,
        );
        if (isResponse(auth)) return auth;
        const { hasPermission } = await import("@/lib/permissions.server");
        const canConfigure =
          auth.role === "owner" ||
          (await hasPermission(auth.supabase, auth.organizationId, auth.userId, "ai.configure"));
        const ctx = {
          supabase: auth.supabase,
          organizationId: auth.organizationId,
          userId: auth.userId,
          role: auth.role,
          canConfigure,
        };

        const api = await import("@/lib/onboarding-journey-api.server");
        try {
          const reply =
            action === "state"
              ? await api.journeyState(ctx, payload["learned"] === true)
              : action === "begin"
                ? await api.journeyBegin(ctx, payload)
                : action === "mark"
                  ? await api.journeyMark(ctx, payload)
                  : action === "test"
                    ? await api.journeyTest(ctx, payload)
                    : action === "go_live"
                      ? await api.journeyGoLive(ctx, payload)
                      : action === "callback"
                        ? await api.journeyCallback(ctx, payload)
                        : null;
          if (!reply) return jsonError("Unknown action.");
          return Response.json(reply.body, { status: reply.status });
        } catch (error) {
          console.error(
            "[onboarding-journey]",
            action,
            error instanceof Error ? error.message : String(error),
          );
          return jsonError("Something went wrong on our side. Please try again.", 500);
        }
      },
    },
  },
});
