import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 35: a number's WhatsApp business profile (Settings → WhatsApp).
 * action "get" reads it from Meta, "update" changes the text fields,
 * "display_name" asks Meta to review a new display name. Owners and admins
 * (settings.manage). The photo has its own upload route (profile-photo).
 */
export const Route = createFileRoute("/api/whatsapp/profile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } =
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
        const denied = await requirePermission(
          auth,
          "settings.manage",
          "change the WhatsApp profile",
        );
        if (denied) return denied;

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        const { connection, error } = await getWhatsAppConnection(
          auth.supabase,
          auth.organizationId,
          (payload["whatsapp_account_id"] as string | null) ?? null,
        );
        if (!connection) return jsonError(error ?? "Connect a number first.", 400);

        const profile = await import("@/lib/whatsapp-profile.server");
        const actor = { organizationId: auth.organizationId, userId: auth.userId };
        const action = String(payload["action"] ?? "get");
        const answer =
          action === "update"
            ? await profile.updateProfile(
                auth.supabase,
                actor,
                connection,
                (payload["profile"] ?? {}) as import("@/lib/whatsapp-profile").ProfilePatch,
              )
            : action === "display_name"
              ? await profile.requestDisplayName(
                  auth.supabase,
                  actor,
                  connection,
                  String(payload["name"] ?? ""),
                )
              : await profile.readProfile(connection);
        if (!answer.ok) return jsonError(answer.error, answer.status);
        return Response.json(answer.data);
      },
    },
  },
});
