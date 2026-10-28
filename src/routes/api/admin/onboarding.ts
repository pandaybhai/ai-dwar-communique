import { createFileRoute } from "@tanstack/react-router";

/**
 * Super-admin only (Batch 40): the onboarding funnel (GET) and submitting
 * the resume-link nudge template to Meta (POST action submit_link_template).
 */
async function superAdmin(request: Request) {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError("Not authenticated.", 401);
  const supabase = getServiceClient();
  const { data: userData } = await supabase.auth.getUser(token);
  const user = userData.user;
  if (!user) return jsonError("Not authenticated.", 401);
  if (!(await isSuperAdmin(supabase, user.id))) return jsonError("Super Admin access required.", 403);
  return { supabase, userId: user.id };
}

export const Route = createFileRoute("/api/admin/onboarding")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await superAdmin(request);
        if (auth instanceof Response) return auth;
        const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 1), 90);
        const { loadOnboardingFunnel } = await import("@/lib/admin-onboarding.server");
        return Response.json(await loadOnboardingFunnel(auth.supabase, days));
      },
      POST: async ({ request }) => {
        const auth = await superAdmin(request);
        if (auth instanceof Response) return auth;
        const { jsonError } = await import("@/lib/whatsapp-api.server");
        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        if (payload["action"] !== "submit_link_template") return jsonError("Unknown action.");
        const { ensureResumeLinkTemplate } = await import("@/lib/onboarding-nudges.server");
        const result = await ensureResumeLinkTemplate(auth.supabase, auth.userId);
        if (result.error) return jsonError(result.error, 502);
        return Response.json(result);
      },
    },
  },
});
