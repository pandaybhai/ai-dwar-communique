import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 63 (A): Super Admin's per-workspace feature switches.
 *
 *  - "list"          → every override row of the given workspaces, each with
 *                       `manual` (a person set it: kept on plan changes).
 *  - "set"           → a person sets a switch (marked manual).
 *  - "reset_to_plan" → back to what the plan says; plan changes manage it again.
 *
 * Super Admin only; the service client writes. Used by both Super Admin
 * screens (the workspace's Features sheet and Super Admin > Flags), which
 * used to upsert the rows straight from the browser with no ownership record
 * — so the next plan change rewrote them (Zoori, 2 Nov).
 */
async function superAdmin(request: Request) {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError("Not authenticated.", 401);
  // Batch 52: an AI app's OAuth token works only through /mcp.
  const refusedClient = (await import("@/lib/mcp-auth.server")).refuseOAuthClientToken(token);
  if (refusedClient) return refusedClient;
  const supabase = getServiceClient();
  const { data: userData } = await supabase.auth.getUser(token);
  const user = userData.user;
  if (!user) return jsonError("Not authenticated.", 401);
  if (!(await isSuperAdmin(supabase, user.id)))
    return jsonError("Super Admin access required.", 403);
  return { supabase, userId: user.id };
}

const UUID = /^[0-9a-f-]{36}$/i;
const FLAG = /^[a-z0-9_]{1,64}$/;

export const Route = createFileRoute("/api/admin/feature-overrides")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await superAdmin(request);
        if (auth instanceof Response) return auth;
        const { jsonError } = await import("@/lib/whatsapp-api.server");
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const own = await import("@/lib/feature-ownership.server");
        const action = String(body["action"] ?? "");

        if (action === "list") {
          const ids = (
            Array.isArray(body["organization_ids"])
              ? body["organization_ids"]
              : [body["organization_id"]]
          )
            .map(String)
            .filter((id) => UUID.test(id))
            .slice(0, 200);
          const { isManualOverride } = await import("@/lib/feature-ownership");
          const out: Record<
            string,
            Array<{ flag_key: string; enabled: boolean; manual: boolean }>
          > = {};
          for (const id of ids) {
            const [rows, manualFlags] = await Promise.all([
              own.readOverrideRows(auth.supabase, id),
              own.readManualFlags(auth.supabase, id),
            ]);
            out[id] = rows.map((r) => ({
              flag_key: r.flag_key,
              enabled: r.enabled,
              manual: isManualOverride(r, manualFlags),
            }));
          }
          return Response.json({ overrides: out });
        }

        const organizationId = String(body["organization_id"] ?? "");
        const flagKey = String(body["flag_key"] ?? "");
        if (!UUID.test(organizationId) || !FLAG.test(flagKey))
          return jsonError("Pick a workspace and a feature.");

        if (action === "set") {
          if (typeof body["enabled"] !== "boolean") return jsonError("Say on or off.");
          const result = await own.writeManualOverride(auth.supabase, {
            organizationId,
            flagKey,
            enabled: body["enabled"],
            actorId: auth.userId,
            via: String(body["via"] ?? "super_admin"),
          });
          return result.ok ? Response.json(result) : jsonError(result.error);
        }
        if (action === "reset_to_plan") {
          const result = await own.resetOverrideToPlan(auth.supabase, {
            organizationId,
            flagKey,
            actorId: auth.userId,
          });
          return result.ok ? Response.json(result) : jsonError(result.error);
        }
        return jsonError("Unknown action.");
      },
    },
  },
});
