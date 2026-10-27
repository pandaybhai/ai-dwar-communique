import { createFileRoute } from "@tanstack/react-router";

/**
 * Settings → API & webhooks: the workspace's Public API keys (Batch 34).
 * GET lists them (never a hash); POST creates one — the full key is in that
 * one answer and nowhere else, ever — or revokes one. Needs public_api.manage;
 * creating needs the public_api flag on, revoking never does (a key can always
 * be switched off).
 */
export const Route = createFileRoute("/api/developer/keys")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "public_api.manage", "manage API keys");
        if (denied) return denied;
        const { listApiKeys, publicApiEnabled, maskedKey } =
          await import("@/lib/public-api.server");
        try {
          const [keys, enabled] = await Promise.all([
            listApiKeys(auth.supabase, auth.organizationId),
            publicApiEnabled(auth.supabase, auth.organizationId),
          ]);
          return Response.json({
            enabled,
            keys: keys.map((k) => ({ ...k, masked: maskedKey(k.prefix) })),
          });
        } catch {
          return jsonError("We couldn't load your API keys. Please try again.", 503);
        }
      },

      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
          await import("@/lib/whatsapp-api.server");
        let p: Record<string, unknown> = {};
        try {
          p = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, (p["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "public_api.manage", "manage API keys");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const lib = await import("@/lib/public-api.server");
        const action = String(p["action"] ?? "");

        if (action === "create") {
          if (!(await lib.publicApiEnabled(supabase, organizationId))) {
            return jsonError("The Public API isn't switched on for this workspace.", 403);
          }
          const created = await lib.createApiKey(supabase, {
            organizationId,
            name: String(p["name"] ?? ""),
            userId,
          });
          if (!created.ok) return jsonError(created.error, created.status);
          await logServerActivity(supabase, organizationId, userId, "api_key_created", {
            key_id: created.row.id,
            name: created.row.name,
            prefix: created.row.prefix,
          });
          // The only time the key itself leaves the server.
          return Response.json({
            key: created.key,
            row: { ...created.row, masked: lib.maskedKey(created.row.prefix) },
          });
        }

        if (action === "revoke") {
          const keyId = String(p["key_id"] ?? "").trim();
          if (!keyId) return jsonError("Which key?");
          try {
            const row = await lib.revokeApiKey(supabase, { organizationId, keyId });
            if (!row) return jsonError("That key isn't active in this workspace.", 404);
            await logServerActivity(supabase, organizationId, userId, "api_key_revoked", {
              key_id: row.id,
              name: row.name,
              prefix: row.prefix,
            });
            return Response.json({ ok: true, row: { ...row, masked: lib.maskedKey(row.prefix) } });
          } catch {
            return jsonError("We couldn't revoke the key. Please try again.", 503);
          }
        }

        return jsonError("Unknown action.");
      },
    },
  },
});
