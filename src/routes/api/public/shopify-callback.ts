import { createFileRoute } from "@tanstack/react-router";

/**
 * Shopify OAuth completion. Public because Shopify redirects the merchant's
 * browser here with no session of ours; the signed state and the HMAC are what
 * prove the request is genuine and which workspace it belongs to.
 */
export const Route = createFileRoute("/api/public/shopify-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const {
          shopifyCredentials,
          normalizeShopDomain,
          verifyOAuthHmac,
          verifyInstallState,
          exchangeAccessToken,
          registerWebhooks,
          getServiceClient,
          SHOPIFY_SCOPES,
        } = await import("@/lib/shopify.server");

        const url = new URL(request.url);
        const settingsUrl = (params: Record<string, string>) => {
          const target = new URL("/app/settings", url.origin);
          target.searchParams.set("tab", "integrations");
          for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
          return Response.redirect(target.toString(), 302);
        };

        const creds = shopifyCredentials();
        if (!creds) return settingsUrl({ shopify_error: "not_configured" });

        if (!(await verifyOAuthHmac(url, creds.apiSecret))) {
          return settingsUrl({ shopify_error: "signature" });
        }

        const shopDomain = normalizeShopDomain(url.searchParams.get("shop"));
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!shopDomain || !code) return settingsUrl({ shopify_error: "invalid_request" });

        const verified = await verifyInstallState(state);
        // The state names the workspace; it must also name this same shop.
        if (!verified || verified.shopDomain !== shopDomain) {
          return settingsUrl({ shopify_error: "state" });
        }

        const exchange = await exchangeAccessToken({
          shopDomain,
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          code,
        });
        if (!exchange.ok || !exchange.accessToken) {
          return settingsUrl({ shopify_error: "exchange" });
        }

        const service = getServiceClient();
        const nowIso = new Date().toISOString();
        const scopes = exchange.scopes?.length ? exchange.scopes : [...SHOPIFY_SCOPES];

        // One row per (org, provider, shop) — reinstalling reuses it.
        const { data: saved } = await service
          .from("integrations")
          .upsert(
            {
              organization_id: verified.organizationId,
              provider: "shopify",
              shop_domain: shopDomain,
              display_name: shopDomain.replace(".myshopify.com", ""),
              status: "connected",
              scopes,
              installed_at: nowIso,
              sync_error: null,
              created_by: verified.userId || null,
              updated_at: nowIso,
            },
            { onConflict: "organization_id,provider,shop_domain" },
          )
          .select("id")
          .maybeSingle();

        const integrationId = (saved as { id: string } | null)?.id;
        if (!integrationId) return settingsUrl({ shopify_error: "save" });

        await service.from("integration_credentials").upsert(
          {
            integration_id: integrationId,
            organization_id: verified.organizationId,
            access_token: exchange.accessToken,
            granted_scopes: scopes,
            install_state: "installed",
            updated_at: nowIso,
          },
          { onConflict: "integration_id" },
        );

        const callbackBase =
          (process.env["SHOPIFY_APP_URL"] ?? url.origin).replace(/\/$/, "") || url.origin;
        const hooks = await registerWebhooks({
          shopDomain,
          accessToken: exchange.accessToken,
          callbackBase,
        });

        const { emitEvent } = await import("@/lib/events.server");
        emitEvent(service, "shopify.connected", {
          organizationId: verified.organizationId,
          entityType: "integration",
          entityId: integrationId,
          actorUserId: verified.userId || null,
          properties: {
            integration_id: integrationId,
            shop_domain: shopDomain,
            provider: "shopify",
            scopes,
            webhooks_registered: hooks.registered.length,
            webhooks_failed: hooks.failed,
          },
        });

        await service.from("activity_log").insert({
          organization_id: verified.organizationId,
          user_id: verified.userId || null,
          action: "integration_connected",
          details: { provider: "shopify", shop_domain: shopDomain, scopes },
        });

        // Backfill runs behind the redirect so the merchant lands on a page,
        // not on a spinner waiting for 90 days of orders.
        const { data: job } = await service
          .from("integration_sync_jobs")
          .insert({
            organization_id: verified.organizationId,
            integration_id: integrationId,
            kind: "backfill",
            status: "running",
            phase: "queued",
          })
          .select("id")
          .maybeSingle();

        const jobId = (job as { id: string } | null)?.id;
        if (jobId) {
          const { runBackfill } = await import("@/lib/shopify-sync.server");
          void runBackfill(
            {
              supabase: service,
              organizationId: verified.organizationId,
              integrationId,
              shopDomain,
            },
            { accessToken: exchange.accessToken, jobId },
          ).catch(() => {});
        }

        return settingsUrl({ shopify_connected: shopDomain });
      },
    },
  },
});
