import { createFileRoute } from "@tanstack/react-router";

/**
 * On-demand quality refresh. The phone_number_quality_update webhook only
 * fires on an actual change, so admins need a way to read the current value.
 */
export const Route = createFileRoute("/api/whatsapp/refresh-quality")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          requireOrgMember,
          isResponse,
          jsonError,
          graphFetch,
          graphErrorMessage,
          logServerActivity,
        } = await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "settings.whatsapp", "refresh number quality");
        if (denied) return denied;

        const { supabase, organizationId, userId } = auth;

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        // Quality is per number, so the caller says which one to refresh.
        const { connection, error: connectionError } = await getWhatsAppConnection(
          supabase,
          organizationId,
          (payload["whatsapp_account_id"] as string | undefined) || null,
        );
        if (!connection) return jsonError(connectionError ?? "No active number is connected yet.", 400);

        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("quality_rating")
          .eq("id", connection.accountId)
          .maybeSingle();

        const result = await graphFetch(connection.phoneNumberId, connection.accessToken, {
          query: { fields: "quality_rating,name_status,messaging_limit_tier" },
        });
        if (!result.ok) return jsonError(graphErrorMessage(result.body), 400);

        const previous = (account?.quality_rating as string | null) ?? null;
        const rating = (result.body["quality_rating"] as string) ?? "UNKNOWN";
        const nameStatus = (result.body["name_status"] as string) ?? null;
        const nowIso = new Date().toISOString();

        const { error: updateErr } = await supabase
          .from("whatsapp_accounts")
          .update({
            quality_rating: rating,
            quality_updated_at: nowIso,
            messaging_tier: (result.body["messaging_limit_tier"] as string | null) ?? null,
          })
          .eq("id", connection.accountId);
        if (updateErr) return jsonError("We couldn't save the latest quality rating.", 500);

        // Append to the quality timeline — the account row only holds current state.
        await supabase.from("whatsapp_quality_history").insert({
          organization_id: organizationId,
          phone_number_id: connection.phoneNumberId,
          quality_rating: rating,
          recorded_at: nowIso,
        });

        if (previous !== rating) {
          await logServerActivity(supabase, organizationId, userId, "quality_changed", {
            old_rating: previous,
            new_rating: rating,
            source: "manual_refresh",
            whatsapp_account_id: connection.accountId,
          });
        }

        return Response.json({
          whatsapp_account_id: connection.accountId,
          quality_rating: rating,
          name_status: nameStatus,
          quality_updated_at: nowIso,
          changed: previous !== rating,
        });
      },
    },
  },
});
