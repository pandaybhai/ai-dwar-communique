import { createFileRoute } from "@tanstack/react-router";

/**
 * Settings → API & webhooks (Batch 61): "Also send every API template message
 * to" — the workspace's default copy numbers (up to MAX_CC, 10), used by every API
 * template send that has no `cc` of its own. GET reads them; POST saves them
 * (an empty list switches copies off). Needs public_api.manage (owner and
 * admin); each save is in the activity log as api_cc_default_saved.
 */
export const Route = createFileRoute("/api/developer/copies")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "public_api.manage", "manage API copies");
        if (denied) return denied;
        const { ccColumnMissing, MAX_CC } = await import("@/lib/public-api-cc.server");
        const { storedCcNumbers } = await import("@/lib/public-api-cc");
        const { data, error } = await auth.supabase
          .from("organizations")
          .select("api_cc_numbers")
          .eq("id", auth.organizationId)
          .maybeSingle();
        if (error && !ccColumnMissing(error))
          return jsonError("We couldn't load the copy numbers. Please try again.", 503);
        return Response.json({
          available: !error,
          max: MAX_CC,
          numbers: error
            ? []
            : storedCcNumbers((data as { api_cc_numbers?: unknown } | null)?.api_cc_numbers),
        });
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
        const denied = await requirePermission(auth, "public_api.manage", "manage API copies");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const { publicApiEnabled } = await import("@/lib/public-api.server");
        const numbers = Array.isArray(p["numbers"]) ? p["numbers"] : null;
        if (!numbers) return jsonError("Send the numbers as a list.");
        // Switching copies off is always allowed; setting them needs the API on.
        if (numbers.length && !(await publicApiEnabled(supabase, organizationId)))
          return jsonError("The Public API isn't switched on for this workspace.", 403);
        const { saveApiCcDefault } = await import("@/lib/public-api-cc.server");
        const saved = await saveApiCcDefault(supabase, organizationId, numbers);
        if (!saved.ok) return jsonError(saved.error, saved.status);
        await logServerActivity(supabase, organizationId, userId, "api_cc_default_saved", {
          numbers: saved.numbers,
          previous: saved.previous,
        });
        return Response.json({ ok: true, numbers: saved.numbers });
      },
    },
  },
});
