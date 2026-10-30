import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 53: Aiden Workspace / Classic for the signed-in member.
 *
 * GET  ?organization_id=  -> what the resolver needs beyond the client's
 *      flags (a Super Admin's new_design decision, this person's choice,
 *      the workspace's unlock time, whether the intro was seen).
 * POST { organization_id, action: "choose", design, from, path }
 *      -> remembers the choice (every device) and records design.switched.
 * POST { organization_id, action: "intro_seen" }
 *
 * Only the caller's own row is ever read or written (user_id from the
 * session, never from the body).
 */
export const Route = createFileRoute("/api/design")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const { loadDesignState } = await import("@/lib/aiden-workspace.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const state = await loadDesignState(auth.supabase, auth.organizationId, auth.userId);
        return Response.json({
          super_admin_override: state.superAdminOverride,
          choice: state.choice,
          unlocked_at: state.unlockedAt,
          intro_seen_at: state.introSeenAt,
        });
      },
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import("@/lib/whatsapp-api.server");
        const { saveDesignChoice, markIntroSeen } = await import("@/lib/aiden-workspace.server");
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const action = String(payload["action"] ?? "");
        if (action === "intro_seen") {
          return Response.json(await markIntroSeen(auth.supabase, auth.userId));
        }
        if (action === "choose") {
          const design = payload["design"];
          if (design !== "classic" && design !== "aiden_workspace") return jsonError("Pick Classic or Aiden Workspace.");
          const from = payload["from"] === "aiden_workspace" ? "aiden_workspace" : "classic";
          const path = typeof payload["path"] === "string" ? payload["path"].slice(0, 200) : null;
          const result = await saveDesignChoice(auth.supabase, {
            organizationId: auth.organizationId,
            userId: auth.userId,
            design,
            from,
            path,
          });
          return Response.json(result);
        }
        return jsonError("Unknown action.");
      },
    },
  },
});
