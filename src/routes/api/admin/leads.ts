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
  // Batch 52: an AI app's OAuth token works only through /mcp.
  const refusedClient = (await import("@/lib/mcp-auth.server")).refuseOAuthClientToken(token);
  if (refusedClient) return refusedClient;

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
        // Batch 76: the new-lead WhatsApp alert numbers, for the editor.
        const { readLeadAlertNumbers } = await import("@/lib/lead-alerts.server");
        return Response.json({
          ...(await listLeads(auth.supabase)),
          alert_numbers: await readLeadAlertNumbers(auth.supabase),
        });
      },

      POST: async ({ request }) => {
        const auth = await requireSuperAdmin(request);
        if (auth instanceof Response) return auth;

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        // Batch 76: replace the new-lead WhatsApp alert numbers.
        if (body["action"] === "alert_numbers") {
          const { saveLeadAlertNumbers } = await import("@/lib/lead-alerts.server");
          const saved = await saveLeadAlertNumbers(auth.supabase, body["numbers"], auth.userId);
          return saved.ok
            ? Response.json({ ok: true, alert_numbers: saved.numbers })
            : Response.json({ error: saved.error }, { status: 400 });
        }
        // Batch 76: the one-off backfill of existing leads into AiDwar's own
        // workspace (re-run until remaining is 0; idempotent).
        if (body["action"] === "mirror_backfill") {
          const { backfillLeadMirror } = await import("@/lib/lead-mirror.server");
          const out = await backfillLeadMirror(auth.supabase);
          return out.ok
            ? Response.json(out)
            : Response.json({ error: out.error }, { status: 409 });
        }

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
        if ("next_follow_up_at" in body) patch["next_follow_up_at"] = body["next_follow_up_at"] ?? null;
        if ("demo_attended_at" in body) patch["demo_attended_at"] = body["demo_attended_at"] ?? null;

        const result = await updateLead(auth.supabase, leadId, patch);
        if (result.ok && "status" in patch) {
          // Batch 76: lead_status on the lead's contact in AiDwar's workspace.
          const { mirrorLead } = await import("@/lib/lead-mirror.server");
          await mirrorLead(auth.supabase, leadId);
        }
        return result.ok
          ? Response.json({ ok: true })
          : Response.json({ error: result.error }, { status: 400 });
      },
    },
  },
});
