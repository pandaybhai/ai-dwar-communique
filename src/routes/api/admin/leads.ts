import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Super-admin only: the demo enquiry inbox. */
async function requireSuperAdmin(
  request: Request,
): Promise<{ supabase: SupabaseClient; userId: string } | Response> {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");

  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError("Not authenticated.", 401);

  const supabase = getServiceClient();
  const { data } = await supabase.auth.getUser(token);
  const user = data.user;
  if (!user) return jsonError("Not authenticated.", 401);
  if (!(await isSuperAdmin(supabase, user.id))) {
    return jsonError("Super Admin access required.", 403);
  }
  return { supabase, userId: user.id };
}

export const Route = createFileRoute("/api/admin/leads")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireSuperAdmin(request);
        if (auth instanceof Response) return auth;

        const url = new URL(request.url);
        const leadId = url.searchParams.get("lead_id");
        const { listLeads, listNotes } = await import("@/lib/leads.server");

        if (leadId) {
          return Response.json({ notes: await listNotes(auth.supabase, leadId) });
        }
        return Response.json(await listLeads(auth.supabase));
      },

      POST: async ({ request }) => {
        const auth = await requireSuperAdmin(request);
        if (auth instanceof Response) return auth;

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const leadId = typeof body["lead_id"] === "string" ? body["lead_id"] : "";
        if (!leadId) return Response.json({ error: "Missing lead." }, { status: 400 });

        const { addNote, updateLead } = await import("@/lib/leads.server");

        if (typeof body["note"] === "string") {
          const result = await addNote(auth.supabase, leadId, auth.userId, body["note"]);
          return result.ok
            ? Response.json({ ok: true })
            : Response.json({ error: result.error }, { status: 400 });
        }

        const patch: Record<string, unknown> = {};
        if (typeof body["status"] === "string") patch["status"] = body["status"];
        if ("assigned_to" in body) patch["assigned_to"] = body["assigned_to"] ?? null;
        if ("demo_at" in body) patch["demo_at"] = body["demo_at"] ?? null;

        const result = await updateLead(auth.supabase, leadId, patch);
        return result.ok
          ? Response.json({ ok: true })
          : Response.json({ error: result.error }, { status: 400 });
      },
    },
  },
});
