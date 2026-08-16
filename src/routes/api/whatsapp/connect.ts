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

        // Manual token paste skips the register and subscribe steps, so it is a
        // platform-support tool only — never available to org admins.
        const { isSuperAdmin, debugToken } = await import("@/lib/whatsapp-api.server");
        if (!(await isSuperAdmin(auth.supabase, auth.userId))) {
          return jsonError(
            "Manual connection is restricted to AiDwar support. Please use Connect with Facebook.",
            403,
          );
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

        const info = await debugToken(accessToken);
        if (!info.expires_at) {
          console.error(
            JSON.stringify({
              scope: "whatsapp_token",
              event: "expiry_missing",
              method: "manual",
              organization_id: organizationId,
              phone_number_id: phoneNumberId,
              debug_token_error: info.error,
            }),
          );
        }

        // One credential row per business account — a workspace can hold several.
        const { error: credErr } = await supabase.from("whatsapp_credentials").upsert(
          {
            organization_id: organizationId,
            waba_id: wabaId,
            access_token: accessToken,
            token_type: "business",
            expires_at: info.expires_at,
            granted_scopes: info.granted_scopes,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id,waba_id" },
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
          .select(
            "id, waba_id, phone_number_id, display_phone_number, verified_name, quality_rating, status, is_default, connected_at",
          )
          .single();
        if (accErr) return jsonError("We couldn't save this number. Please try again.", 500);

        // The first number a workspace connects becomes its default; later ones
        // are added alongside it and leave the default untouched.
        const { ensureDefaultAccount } = await import("@/lib/whatsapp-numbers.server");
        await ensureDefaultAccount(supabase, organizationId);

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
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "settings.whatsapp", "disconnect the business number");
        if (denied) return denied;

        const { supabase, organizationId, userId } = auth;
        const { getWhatsAppConnection, ensureDefaultAccount } = await import(
          "@/lib/whatsapp-numbers.server"
        );

        // Disconnect one number, never the whole workspace.
        const targetAccountId = (payload["whatsapp_account_id"] as string | undefined) || null;
        const { connection, error: connectionError } = await getWhatsAppConnection(
          supabase,
          organizationId,
          targetAccountId,
        );

        const { data: targetRow } = await supabase
          .from("whatsapp_accounts")
          .select("id, waba_id")
          .eq("organization_id", organizationId)
          .eq("id", targetAccountId ?? connection?.accountId ?? "")
          .maybeSingle();
        const account = (targetRow ?? null) as { id: string; waba_id: string | null } | null;
        if (!account) return jsonError(connectionError ?? "That number isn't connected.", 404);

        // Is this the last active number on its business account? Only then may
        // we unsubscribe the WABA and drop its token — a sibling number on the
        // same business account still needs both.
        const { data: siblings } = await supabase
          .from("whatsapp_accounts")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("waba_id", account.waba_id ?? "")
          .eq("status", "active")
          .neq("id", account.id);
        const lastOnWaba = (siblings ?? []).length === 0;

        const token = connection?.accessToken ?? "";
        let unsubscribed = false;
        let revoked = false;
        if (token && lastOnWaba && account.waba_id) {
          try {
            const res = await graphFetch(`${account.waba_id}/subscribed_apps`, token, {
              method: "DELETE",
            });
            unsubscribed = res.ok;
          } catch {
            // Meta being unreachable must not block the disconnect.
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
          .update({ status: "disconnected", is_default: false })
          .eq("id", account.id);

        if (lastOnWaba && account.waba_id) {
          await supabase
            .from("whatsapp_credentials")
            .delete()
            .eq("organization_id", organizationId)
            .eq("waba_id", account.waba_id);
        }

        // Promote another live number so the workspace still has a default.
        await ensureDefaultAccount(supabase, organizationId);

        await logServerActivity(supabase, organizationId, userId, "whatsapp_disconnected", {
          whatsapp_account_id: account.id,
          unsubscribed,
          token_revoked: revoked,
        });
        return Response.json({
          ok: true,
          whatsapp_account_id: account.id,
          unsubscribed,
          token_revoked: revoked,
        });
      },
    },
  },
});
