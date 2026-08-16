import { createFileRoute } from "@tanstack/react-router";

/**
 * Effective permission keys for the caller in the requested organization,
 * resolved exactly the way public.has_permission resolves them:
 * super admin -> owner -> member override -> role preset.
 */
export const Route = createFileRoute("/api/permissions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const { resolveEffectivePermissions } = await import("@/lib/permissions.server");

        const url = new URL(request.url);
        const requested = url.searchParams.get("organization_id");

        const auth = await requireOrgMember(request, requested);
        if (isResponse(auth)) return auth;

        const resolved = await resolveEffectivePermissions(
          auth.supabase,
          auth.organizationId,
          auth.userId,
        );

        return Response.json({
          organization_id: auth.organizationId,
          role: resolved.role,
          is_super_admin: resolved.isSuperAdmin,
          permissions: resolved.keys,
          overrides: resolved.overrides,
        });
      },
    },
  },
});
