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
        if (auth.role !== "owner" && auth.role !== "admin") {
          return jsonError("Only owners and admins can refresh number quality.", 403);
        }

        const { supabase, organizationId, userId } = auth;

        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("id, phone_number_id, quality_rating")
          .eq("organization_id", organizationId)
          .eq("status", "active")
          .order("connected_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (!account) return jsonError("No active number is connected yet.", 400);

        const { data: cred } = await supabase
          .from("whatsapp_credentials")
          .select("access_token")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!cred?.access_token) {
          return jsonError("We couldn't find stored credentials for this number.", 400);
        }

        const result = await graphFetch(
          account.phone_number_id as string,
          cred.access_token as string,
          { query: { fields: "quality_rating,name_status" } },
        );
        if (!result.ok) return jsonError(graphErrorMessage(result.body), 400);

        const previous = (account.quality_rating as string | null) ?? null;
        const rating = (result.body["quality_rating"] as string) ?? "UNKNOWN";
        const nameStatus = (result.body["name_status"] as string) ?? null;
        const nowIso = new Date().toISOString();

        const { error: updateErr } = await supabase
          .from("whatsapp_accounts")
          .update({ quality_rating: rating, quality_updated_at: nowIso })
          .eq("id", account.id as string);
        if (updateErr) return jsonError("We couldn't save the latest quality rating.", 500);

        if (previous !== rating) {
          await logServerActivity(supabase, organizationId, userId, "quality_changed", {
            old_rating: previous,
            new_rating: rating,
            source: "manual_refresh",
          });
        }

        return Response.json({
          quality_rating: rating,
          name_status: nameStatus,
          quality_updated_at: nowIso,
          changed: previous !== rating,
        });
      },
    },
  },
});
