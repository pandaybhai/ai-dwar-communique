import { createFileRoute } from "@tanstack/react-router";

/**
 * The demo enquiry inbox. Super admins: everything. Batch 76: the sales team
 * (profiles.is_sales) may also view and work leads — status, notes, the next
 * follow-up and assigning to themselves — but the CSV export and the
 * new-lead alert numbers stay super admin only.
 */
export const Route = createFileRoute("/api/admin/leads")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireAdminRole } = await import("@/lib/admin-access.server");
        const auth = await requireAdminRole(request, ["super_admin", "sales"]);
        if (auth instanceof Response) return auth;

        const url = new URL(request.url);
        const leadId = url.searchParams.get("lead_id");
        const { listLeads, listNotes, leadsCsv } = await import("@/lib/leads.server");

        if (leadId) {
          return Response.json({ notes: await listNotes(auth.supabase, leadId) });
        }
        if (url.searchParams.get("format") === "csv") {
          if (auth.role !== "super_admin") {
            return Response.json(
              { error: "Only a super admin can export leads." },
              { status: 403 },
            );
          }
          const { leads } = await listLeads(auth.supabase);
          return new Response(leadsCsv(leads), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="aidwar-leads.csv"`,
            },
          });
        }
        const payload = await listLeads(auth.supabase);
        let alertNumbers: string[] | null = null;
        if (auth.role === "super_admin") {
          const { readLeadAlertNumbers } = await import("@/lib/lead-alerts.server");
          alertNumbers = await readLeadAlertNumbers(auth.supabase);
        }
        return Response.json({
          ...payload,
          role: auth.role,
          me: auth.userId,
          alert_numbers: alertNumbers,
        });
      },

      POST: async ({ request }) => {
        const { requireAdminRole } = await import("@/lib/admin-access.server");
        const auth = await requireAdminRole(request, ["super_admin", "sales"]);
        if (auth instanceof Response) return auth;

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        // Batch 76: the new-lead WhatsApp alert numbers — super admin only.
        if (body["action"] === "alert_numbers") {
          if (auth.role !== "super_admin") {
            return Response.json(
              { error: "Only a super admin can change alert numbers." },
              { status: 403 },
            );
          }
          const { saveLeadAlertNumbers } = await import("@/lib/lead-alerts.server");
          const saved = await saveLeadAlertNumbers(auth.supabase, body["numbers"], auth.userId);
          return saved.ok
            ? Response.json({ ok: true, alert_numbers: saved.numbers })
            : Response.json({ error: saved.error }, { status: 400 });
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
        if ("assigned_to" in body) {
          const to = body["assigned_to"] ?? null;
          // A sales member assigns leads to themselves (or lets go); never to someone else.
          if (auth.role === "sales" && to !== null && to !== auth.userId) {
            return Response.json(
              { error: "You can assign leads to yourself only." },
              { status: 403 },
            );
          }
          patch["assigned_to"] = to;
        }
        if ("demo_at" in body) patch["demo_at"] = body["demo_at"] ?? null;
        if ("next_follow_up_at" in body)
          patch["next_follow_up_at"] = body["next_follow_up_at"] ?? null;
        if ("demo_attended_at" in body)
          patch["demo_attended_at"] = body["demo_attended_at"] ?? null;

        const result = await updateLead(auth.supabase, leadId, patch);
        return result.ok
          ? Response.json({ ok: true })
          : Response.json({ error: result.error }, { status: 400 });
      },
    },
  },
});
