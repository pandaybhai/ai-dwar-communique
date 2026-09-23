import { createFileRoute } from "@tanstack/react-router";

/**
 * WhatsApp catalogue: status, enable, sync. Gated on the scopes Meta granted
 * for the connected number (catalog_management + business_management) — there
 * is no per-user gating here; Meta already restricts who can grant them until
 * App Review passes.
 */
export const Route = createFileRoute("/api/whatsapp/catalog")({
  server: {
    handlers: {
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
          "settings.whatsapp",
          "manage the WhatsApp connection",
        );
        if (denied) return denied;

        const { supabase, organizationId, userId } = auth;
        const accountId = (payload["whatsapp_account_id"] as string) ?? null;
        const action = String(payload["action"] ?? "status");

        const {
          resolveCatalogContext,
          hasCatalogScopes,
          getCatalogRow,
          enableCatalog,
          syncCatalog,
          listBusinessCatalogs,
          refreshLinkedCatalog,
        } = await import("@/lib/whatsapp-catalog.server");

        if (action === "status") {
          const { ctx, error } = await resolveCatalogContext(supabase, organizationId, accountId);
          if (!ctx) return Response.json({ connected: false, scopes_ok: false, reason: error });
          const catalog = await getCatalogRow(supabase, organizationId, ctx.wabaId);
          return Response.json({
            connected: true,
            scopes_ok: hasCatalogScopes(ctx.scopes),
            granted_scopes: ctx.scopes ?? [],
            catalog,
          });
        }

        if (action === "list_catalogs") {
          const result = await listBusinessCatalogs({
            supabase,
            organizationId,
            userId,
            whatsappAccountId: accountId,
          });
          if (!result.ok)
            return jsonError(result.error ?? "We couldn't read your catalogues.", 400);
          return Response.json({ catalogs: result.catalogs ?? [] });
        }

        if (action === "enable") {
          const { data: org } = await supabase
            .from("organizations")
            .select("name")
            .eq("id", organizationId)
            .maybeSingle();
          const result = await enableCatalog({
            supabase,
            organizationId,
            userId,
            whatsappAccountId: accountId,
            businessName: ((org as { name?: string } | null)?.name ?? "Business").slice(0, 60),
            useCatalogId: (payload["catalog_id"] as string) ?? null,
          });
          if (!result.ok) return jsonError(result.error ?? "We couldn't create the catalogue.", 400);
          await logServerActivity(supabase, organizationId, userId, "whatsapp_catalog_enabled", {
            catalog_id: result.catalog_id,
            created: result.created ?? false,
            mode: result.mode ?? "managed",
          });
          return Response.json(result);
        }

        if (action === "refresh") {
          const result = await refreshLinkedCatalog({
            supabase,
            organizationId,
            userId,
            whatsappAccountId: accountId,
          });
          if (!result.ok) return jsonError(result.error ?? "We couldn't read the catalogue.", 400);
          await logServerActivity(supabase, organizationId, userId, "whatsapp_catalog_synced", {
            catalog_id: result.catalog_id,
            imported: result.imported,
            mode: "linked",
          });
          return Response.json(result);
        }

        if (action === "sync") {
          const result = await syncCatalog({
            supabase,
            organizationId,
            userId,
            whatsappAccountId: accountId,
          });
          if (!result.ok) return jsonError(result.error ?? "We couldn't sync the catalogue.", 400);
          await logServerActivity(supabase, organizationId, userId, "whatsapp_catalog_synced", {
            catalog_id: result.catalog_id,
            eligible: result.eligible,
            pushed: result.pushed,
            rejected: result.rejected,
            mode: "managed",
          });
          return Response.json(result);
        }

        return jsonError("Unknown action.", 400);
      },
    },
  },
});
