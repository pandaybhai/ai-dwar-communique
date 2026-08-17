import { createFileRoute } from "@tanstack/react-router";

/**
 * Workspace-facing Shopify controls: list connected stores, start an install,
 * resync, disconnect. The public half of OAuth lives in
 * /api/public/shopify-callback, which is where Shopify can actually reach us.
 */
export const Route = createFileRoute("/api/integrations/shopify")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;

        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "integrations.view", "view integrations");
        if (denied) return denied;

        const { supabase, organizationId } = auth;

        const { data: integrations } = await supabase
          .from("integrations")
          .select(
            "id, provider, shop_domain, display_name, status, scopes, installed_at, last_sync_at, sync_error, created_at",
          )
          .eq("organization_id", organizationId)
          .eq("provider", "shopify")
          .order("created_at", { ascending: true });

        const ids = ((integrations ?? []) as Array<{ id: string }>).map((i) => i.id);
        const { data: jobs } = ids.length
          ? await supabase
              .from("integration_sync_jobs")
              .select(
                "id, integration_id, kind, status, phase, products_synced, orders_synced, contacts_matched, error, started_at, finished_at",
              )
              .in("integration_id", ids)
              .order("started_at", { ascending: false })
          : { data: [] as Array<Record<string, unknown>> };

        const latestJob = new Map<string, Record<string, unknown>>();
        for (const job of (jobs ?? []) as Array<Record<string, unknown>>) {
          const key = String(job["integration_id"]);
          if (!latestJob.has(key)) latestJob.set(key, job);
        }

        const { shopifyCredentials } = await import("@/lib/shopify.server");

        return Response.json({
          configured: Boolean(shopifyCredentials()),
          integrations: ((integrations ?? []) as Array<Record<string, unknown>>).map((row) => ({
            ...row,
            latest_sync: latestJob.get(String(row["id"])) ?? null,
          })),
        });
      },

      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
          await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(
          auth,
          "integrations.manage",
          "manage store integrations",
        );
        if (denied) return denied;

        const { supabase, organizationId, userId } = auth;
        const action = String(payload["action"] ?? "");

        const {
          shopifyCredentials,
          normalizeShopDomain,
          buildInstallUrl,
          callbackUrl,
          signInstallState,
          getShopifyConnection,
        } = await import("@/lib/shopify.server");

        const creds = shopifyCredentials();
        if (!creds) {
          return jsonError(
            "Shopify isn't configured for this deployment yet. Add the app's API key and secret first.",
            400,
          );
        }

        if (action === "install") {
          const shopDomain = normalizeShopDomain(payload["shop_domain"] as string);
          if (!shopDomain) {
            return jsonError(
              "Enter your store address, for example your-store.myshopify.com.",
              400,
            );
          }

          const state = await signInstallState({ organizationId, shopDomain, userId });
          return Response.json({
            install_url: buildInstallUrl({
              shopDomain,
              apiKey: creds.apiKey,
              redirectUri: callbackUrl(request),
              state,
            }),
          });
        }

        const integrationId = String(payload["integration_id"] ?? "");
        if (!integrationId) return jsonError("Which store did you mean?", 400);

        // Scope the row to the caller's workspace before anything else.
        const { data: owned } = await supabase
          .from("integrations")
          .select("id, shop_domain, status")
          .eq("id", integrationId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!owned) return jsonError("That store is not connected to this workspace.", 404);
        const integration = owned as { id: string; shop_domain: string; status: string };

        if (action === "disconnect") {
          const { getServiceClient } = await import("@/lib/shopify.server");
          const service = getServiceClient();
          await service.from("integration_credentials").delete().eq("integration_id", integrationId);
          await service
            .from("integrations")
            .update({ status: "disconnected", sync_error: null })
            .eq("id", integrationId);

          const { emitEvent } = await import("@/lib/events.server");
          emitEvent(supabase, "shopify.disconnected", {
            organizationId,
            entityType: "integration",
            entityId: integrationId,
            actorUserId: userId,
            properties: {
              integration_id: integrationId,
              shop_domain: integration.shop_domain,
              provider: "shopify",
              reason: "manual",
            },
          });
          await logServerActivity(supabase, organizationId, userId, "integration_disconnected", {
            provider: "shopify",
            shop_domain: integration.shop_domain,
          });

          return Response.json({ ok: true, status: "disconnected" });
        }

        if (action === "resync") {
          const { getServiceClient } = await import("@/lib/shopify.server");
          const service = getServiceClient();
          const connection = await getShopifyConnection(service, integrationId);
          if (!connection.ok) return jsonError(connection.error, 400);

          // Enqueue only — the cron worker does the paging so this request
          // stays short and the work survives the response.
          const { enqueueBackfill } = await import("@/lib/shopify-sync.server");
          const jobId = await enqueueBackfill(service, {
            organizationId,
            integrationId,
          });
          if (!jobId) return jsonError("We couldn't start the sync just now.", 500);

          await logServerActivity(supabase, organizationId, userId, "integration_resynced", {
            provider: "shopify",
            shop_domain: integration.shop_domain,
          });

          return Response.json({ ok: true, job_id: jobId });
        }

        return jsonError("Unknown action.", 400);
      },
    },
  },
});
