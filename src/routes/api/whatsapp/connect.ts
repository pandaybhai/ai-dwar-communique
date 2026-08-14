import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/whatsapp/connect")({
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
        const { reprocessUnprocessedEvents } = await import("@/lib/whatsapp-webhook.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        if (auth.role !== "owner" && auth.role !== "admin") {
          return jsonError("Only owners and admins can connect WhatsApp.", 403);
        }

        const wabaId = String(payload["waba_id"] ?? "").trim();
        const phoneNumberId = String(payload["phone_number_id"] ?? "").trim();
        const displayPhone = String(payload["display_phone_number"] ?? "").trim();
        const accessToken = String(payload["access_token"] ?? "").trim();

        if (!wabaId || !phoneNumberId || !accessToken) {
          return jsonError("WABA ID, Phone Number ID and access token are all required.");
        }

        // Validate the credentials against Meta before storing anything.
        const check = await graphFetch(phoneNumberId, accessToken, {
          query: { fields: "id,display_phone_number,verified_name,quality_rating" },
        });
        if (!check.ok) {
          return jsonError(graphErrorMessage(check.body), 400);
        }

        const { supabase, organizationId, userId } = auth;

        const { error: credErr } = await supabase.from("whatsapp_credentials").upsert(
          {
            organization_id: organizationId,
            access_token: accessToken,
            token_type: "business",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id" },
        );
        if (credErr) return jsonError("We couldn't store your credentials. Please try again.", 500);

        const account = {
          organization_id: organizationId,
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          display_phone_number:
            (check.body["display_phone_number"] as string) || displayPhone || null,
          verified_name: (check.body["verified_name"] as string) ?? null,
          quality_rating: (check.body["quality_rating"] as string) ?? "UNKNOWN",
          status: "active",
          connected_at: new Date().toISOString(),
        };

        const { data: saved, error: accErr } = await supabase
          .from("whatsapp_accounts")
          .upsert(account, { onConflict: "phone_number_id" })
          .select("id, display_phone_number, verified_name, quality_rating, status, connected_at")
          .single();
        if (accErr) return jsonError("We couldn't save this number. Please try again.", 500);

        let reprocessed = 0;
        try {
          reprocessed = await reprocessUnprocessedEvents(supabase, { olderThanSeconds: 0 });
        } catch {
          // never block the connect flow
        }

        await logServerActivity(supabase, organizationId, userId, "whatsapp_connected", {
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
        });

        return Response.json({ account: saved, reprocessed_events: reprocessed });
      },

      DELETE: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, logServerActivity, graphFetch } =
          await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        if (auth.role !== "owner" && auth.role !== "admin") {
          return jsonError("Only owners and admins can disconnect WhatsApp.", 403);
        }

        const { supabase, organizationId, userId } = auth;

        // Best effort with Meta first: stop webhooks and revoke the token so a
        // later re-connect starts from a clean slate. Local cleanup happens
        // regardless — a stale token must never survive a disconnect here.
        const { data: creds } = await supabase
          .from("whatsapp_credentials")
          .select("access_token")
          .eq("organization_id", organizationId)
          .maybeSingle();
        const { data: accounts } = await supabase
          .from("whatsapp_accounts")
          .select("waba_id")
          .eq("organization_id", organizationId)
          .eq("status", "active");

        const token = (creds?.access_token as string | undefined) ?? "";
        let unsubscribed = false;
        let revoked = false;
        if (token) {
          for (const row of accounts ?? []) {
            const wabaId = (row as { waba_id: string | null }).waba_id;
            if (!wabaId) continue;
            try {
              const res = await graphFetch(`${wabaId}/subscribed_apps`, token, { method: "DELETE" });
              unsubscribed = unsubscribed || res.ok;
            } catch {
              // Meta being unreachable must not block the disconnect.
            }
          }
          try {
            const res = await graphFetch("me/permissions", token, { method: "DELETE" });
            revoked = res.ok;
          } catch {
            // ignore — the token is deleted locally either way
          }
        }

        await supabase
          .from("whatsapp_accounts")
          .update({ status: "disconnected" })
          .eq("organization_id", organizationId);
        await supabase.from("whatsapp_credentials").delete().eq("organization_id", organizationId);

        await logServerActivity(supabase, organizationId, userId, "whatsapp_disconnected", {
          unsubscribed,
          token_revoked: revoked,
        });
        return Response.json({ ok: true, unsubscribed, token_revoked: revoked });
      },
    },
  },
});
