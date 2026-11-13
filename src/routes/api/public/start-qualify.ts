import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 75: the /start qualification step — "What do you sell?" and "How
 * many customers do you have?". Updates only demo_leads.qualification (and
 * business_type when the answer fits its existing values) of the lead this
 * browser created: the lead id comes from the signed httpOnly cookie set by
 * /api/public/demo-leads, never from the request body. Answers once (a lead
 * already answered keeps its answers). Batch 78: no Meta event any more
 * (LeadQualified retired; the answers ride on the verified Lead), and only
 * leads made before Batch 78 still come here (the reminder link).
 */
export const Route = createFileRoute("/api/public/start-qualify")({
  server: {
    handlers: {
      GET: async () => Response.json({ error: "Not allowed." }, { status: 405 }),
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { readStartLeadToken, startLeadFromRequest } =
          await import("@/lib/start-lead-cookie.server");
        const { qualifyStartLead } = await import("@/lib/leads.server");

        const leadId = await readStartLeadToken(startLeadFromRequest(request));
        if (!leadId) {
          return Response.json(
            { error: "We couldn't find your details. Please carry on." },
            { status: 403 },
          );
        }
        let body: Record<string, unknown>;
        try {
          const raw = await request.text();
          if (raw.length > 2000) {
            return Response.json({ error: "That request was too large." }, { status: 413 });
          }
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "We couldn't read that request." }, { status: 400 });
        }

        const supabase = getServiceClient();
        const result = await qualifyStartLead(supabase, leadId, body["sells"], body["customers"]);
        if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

        if (result.saved) {
          // Batch 76: the answers reach the lead's contact in AiDwar's workspace.
          const { mirrorLead } = await import("@/lib/lead-mirror.server");
          await mirrorLead(supabase, leadId);
        }

        // Batch 78: LeadQualified is no longer sent — the answers ride on the
        // verified Lead's custom_data. (This route now only serves leads made
        // before Batch 78, finishing from the reminder link.)
        return Response.json({ ok: true, saved: result.saved, meta: null });
      },
    },
  },
});
