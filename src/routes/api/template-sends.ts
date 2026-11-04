import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 63 (B/C): the one write behind the template Sent report and Settings
 * → Notifications: the workspace's daily "couldn't be delivered" summary on
 * or off (organizations.branding.send_failure_summary; only false turns it
 * off). settings.manage, audit-logged. The report itself is read in the
 * browser through the member's own client (RLS) — no route.
 *
 * POST { organization_id, action: "set_summary", enabled }
 */
export const Route = createFileRoute("/api/template-sends")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
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
        if (payload["action"] !== "set_summary") return jsonError("Unknown action.");
        if (typeof payload["enabled"] !== "boolean") return jsonError("Say on or off.");
        const denied = await requirePermission(auth, "settings.manage", "change notifications");
        if (denied) return denied;
        const { data, error } = await auth.supabase
          .from("organizations")
          .select("branding")
          .eq("id", auth.organizationId)
          .maybeSingle();
        if (error) return jsonError("We couldn't save that. Please try again.");
        const branding = {
          ...(((data as { branding?: Record<string, unknown> | null } | null)?.branding ??
            {}) as Record<string, unknown>),
        };
        branding["send_failure_summary"] = payload["enabled"];
        const { error: writeError } = await auth.supabase
          .from("organizations")
          .update({ branding })
          .eq("id", auth.organizationId);
        if (writeError) return jsonError("We couldn't save that. Please try again.");
        await logServerActivity(
          auth.supabase,
          auth.organizationId,
          auth.userId,
          "send_failure_summary_changed",
          {
            enabled: payload["enabled"],
          },
        );
        return Response.json({ ok: true, enabled: payload["enabled"] });
      },
    },
  },
});
