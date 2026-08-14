import { createFileRoute } from "@tanstack/react-router";

/**
 * Meta Embedded Signup completion.
 *
 * The browser hands us the one-time code plus the WABA and phone number ids it
 * received from Meta's session-info event. Everything else happens here: the
 * code is exchanged for a business token with the app secret, the number is
 * verified against Graph, and only then do we persist any credentials. A
 * failure before that point leaves no partial state behind.
 */
export const Route = createFileRoute("/api/whatsapp/es-exchange")({
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
          GRAPH_VERSION,
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

        const code = String(payload["code"] ?? "").trim();
        const wabaId = String(payload["waba_id"] ?? "").trim();
        const phoneNumberId = String(payload["phone_number_id"] ?? "").trim();

        if (!code || !wabaId || !phoneNumberId) {
          return jsonError(
            "Meta didn't return the details we need. Please run the connect flow again.",
          );
        }
        if (!/^\d{5,25}$/.test(wabaId) || !/^\d{5,25}$/.test(phoneNumberId)) {
          return jsonError("Meta returned an unexpected account id. Please try again.");
        }

        const appId = process.env["META_APP_ID"];
        const appSecret = process.env["META_APP_SECRET"];
        if (!appId || !appSecret) {
          return jsonError("WhatsApp sign-up isn't configured yet. Please contact support.", 500);
        }

        // 1. Exchange the one-time code for the client's business token.
        const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
        tokenUrl.searchParams.set("client_id", appId);
        tokenUrl.searchParams.set("client_secret", appSecret);
        tokenUrl.searchParams.set("code", code);

        let tokenBody: Record<string, unknown> = {};
        try {
          const res = await fetch(tokenUrl.toString());
          tokenBody = (await res.json()) as Record<string, unknown>;
          if (!res.ok) {
            return jsonError(
              `We couldn't finish the sign-up with Meta: ${graphErrorMessage(tokenBody)}`,
              400,
            );
          }
        } catch {
          return jsonError("We couldn't reach Meta to finish the sign-up. Please try again.", 502);
        }

        const accessToken = String(tokenBody["access_token"] ?? "");
        if (!accessToken) {
          return jsonError("Meta didn't return an access token. Please run the flow again.", 400);
        }

        // 2. Verify the number before anything is written.
        const check = await graphFetch(phoneNumberId, accessToken, {
          query: { fields: "id,display_phone_number,verified_name,quality_rating" },
        });
        if (!check.ok) {
          return jsonError(graphErrorMessage(check.body), 400);
        }

        const { supabase, organizationId, userId } = auth;

        // Guard against a number that already belongs to another workspace.
        const { data: clash } = await supabase
          .from("whatsapp_accounts")
          .select("organization_id")
          .eq("phone_number_id", phoneNumberId)
          .neq("organization_id", organizationId)
          .limit(1);
        if (clash && clash.length) {
          return jsonError(
            "This number is already connected to another AiDwar workspace. Disconnect it there first.",
            409,
          );
        }

        const pin = String(Math.floor(100000 + Math.random() * 900000));

        // 3. Persist credentials — the exchange succeeded, so this is safe.
        const { error: credErr } = await supabase.from("whatsapp_credentials").upsert(
          {
            organization_id: organizationId,
            access_token: accessToken,
            token_type: "business",
            two_step_pin: pin,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id" },
        );
        if (credErr) {
          return jsonError("We couldn't store your connection. Please try again.", 500);
        }

        const { data: saved, error: accErr } = await supabase
          .from("whatsapp_accounts")
          .upsert(
            {
              organization_id: organizationId,
              waba_id: wabaId,
              phone_number_id: phoneNumberId,
              display_phone_number: (check.body["display_phone_number"] as string) ?? null,
              verified_name: (check.body["verified_name"] as string) ?? null,
              quality_rating: (check.body["quality_rating"] as string) ?? "UNKNOWN",
              status: "active",
              connected_at: new Date().toISOString(),
            },
            { onConflict: "phone_number_id" },
          )
          .select("id, display_phone_number, verified_name, quality_rating, status, connected_at")
          .single();
        if (accErr) {
          await supabase.from("whatsapp_credentials").delete().eq("organization_id", organizationId);
          return jsonError("We couldn't save this number. Please try again.", 500);
        }

        // 4. Subscribe our app to the client's WABA so webhooks start flowing.
        const warnings: string[] = [];
        const subscribe = await graphFetch(`${wabaId}/subscribed_apps`, accessToken, {
          method: "POST",
        });
        if (!subscribe.ok) {
          warnings.push(
            `We connected the number but couldn't turn on incoming messages yet: ${graphErrorMessage(subscribe.body)}`,
          );
        }

        // 5. Register the number for Cloud API sending (best effort).
        const register = await graphFetch(`${phoneNumberId}/register`, accessToken, {
          method: "POST",
          body: { messaging_product: "whatsapp", pin },
        });
        let registered = register.ok;
        if (!register.ok) {
          const msg = graphErrorMessage(register.body);
          if (/already/i.test(msg) && /register/i.test(msg)) {
            registered = true;
          } else {
            warnings.push(`Meta couldn't finish activating this number: ${msg}`);
          }
        }

        let reprocessed = 0;
        try {
          reprocessed = await reprocessUnprocessedEvents(supabase, { olderThanSeconds: 0 });
        } catch {
          // never block the connect flow
        }

        await logServerActivity(supabase, organizationId, userId, "whatsapp_connected", {
          method: "embedded_signup",
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          registered,
          subscribed: subscribe.ok,
        });

        return Response.json({
          account: saved,
          registered,
          subscribed: subscribe.ok,
          warnings,
          reprocessed_events: reprocessed,
        });
      },
    },
  },
});
