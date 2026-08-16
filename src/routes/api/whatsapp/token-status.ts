import { createFileRoute } from "@tanstack/react-router";

/**
 * Connection token status, per connected number. whatsapp_credentials is
 * service-role only, so the browser can never read a token or its expiry
 * directly — this route returns only the safe classification the UI needs.
 * A workspace can hold several numbers across several business accounts, and
 * each business account carries its own token and expiry.
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

        const { data: accounts } = await supabase
          .from("whatsapp_accounts")
          .select("id, waba_id, display_phone_number, verified_name, status, is_default")
          .eq("organization_id", organizationId)
          .eq("status", "active");

        const rows = (accounts ?? []) as Array<{
          id: string;
          waba_id: string | null;
          display_phone_number: string | null;
          verified_name: string | null;
          is_default: boolean;
        }>;
        if (rows.length === 0) return Response.json({ connected: false, numbers: [] });

        const wabaIds = Array.from(
          new Set(rows.map((r) => r.waba_id).filter((v): v is string => Boolean(v))),
        );

        const { data: creds, error } = await supabase
          .from("whatsapp_credentials")
          .select("waba_id, expires_at, expires_never, token_type, granted_scopes")
          .eq("organization_id", organizationId)
          .in("waba_id", wabaIds.length > 0 ? wabaIds : ["__none__"]);
        if (error) return jsonError("We couldn't check your connection health.", 500);

        const byWaba = new Map(
          ((creds ?? []) as Array<{
            waba_id: string;
            expires_at: string | null;
            expires_never: boolean | null;
            token_type: string | null;
            granted_scopes: string[] | null;
          }>).map((c) => [c.waba_id, c]),
        );

        const numbers = rows.map((row) => {
          const cred = row.waba_id ? byWaba.get(row.waba_id) : undefined;
          const expiry = classifyTokenExpiry(cred?.expires_at, cred?.expires_never === true);
          if (cred && expiry.expiry_unknown) {
            console.error(
              JSON.stringify({
                scope: "whatsapp_token",
                event: "expiry_missing_on_read",
                organization_id: organizationId,
                whatsapp_account_id: row.id,
              }),
            );
          }
          return {
            whatsapp_account_id: row.id,
            waba_id: row.waba_id,
            display_phone_number: row.display_phone_number,
            verified_name: row.verified_name,
            is_default: row.is_default,
            credentials_missing: !cred,
            scopes: cred?.granted_scopes ?? null,
            token_type: cred?.token_type ?? null,
            ...expiry,
          };
        });

        // Worst case across numbers, so a single banner can speak for the
        // workspace while the settings list shows each number individually.
        return Response.json({
          connected: true,
          numbers,
          credentials_missing: numbers.some((n) => n.credentials_missing),
          token_expired: numbers.some((n) => n.token_expired),
          token_expiring: numbers.some((n) => n.token_expiring),
        });
      },
    },
  },
});
