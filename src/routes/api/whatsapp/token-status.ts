import { createFileRoute } from "@tanstack/react-router";

/**
 * Connection token status. whatsapp_credentials is service-role only, so the
 * browser can never read the token or its expiry directly — this route returns
 * only the safe classification the UI needs.
 */
export const Route = createFileRoute("/api/whatsapp/token-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, classifyTokenExpiry } = await import(
          "@/lib/whatsapp-api.server"
        );

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const { supabase, organizationId } = auth;

        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("id, status")
          .eq("organization_id", organizationId)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();
        if (!account) return Response.json({ connected: false });

        const { data: cred, error } = await supabase
          .from("whatsapp_credentials")
          .select("expires_at, granted_scopes")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (error) return jsonError("We couldn't check your connection health.", 500);

        const expiry = classifyTokenExpiry(cred?.expires_at as string | null | undefined);
        if (!cred) {
          return Response.json({ connected: true, credentials_missing: true, ...expiry });
        }
        if (expiry.expiry_unknown) {
          console.error(
            JSON.stringify({
              scope: "whatsapp_token",
              event: "expiry_missing_on_read",
              organization_id: organizationId,
            }),
          );
        }
        return Response.json({
          connected: true,
          credentials_missing: false,
          scopes: (cred.granted_scopes as string[] | null) ?? null,
          ...expiry,
        });
      },
    },
  },
});
