import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 75: the /start qualification step — "What do you sell?" and "How
 * many customers do you have?". Updates only demo_leads.qualification (and
 * business_type when the answer fits its existing values) of the lead this
 * browser created: the lead id comes from the signed httpOnly cookie set by
 * /api/public/demo-leads, never from the request body. Answers once (a lead
 * already answered keeps its answers). Then a LeadQualified server event
 * (Conversions API, always — like Lead; the browser pixel only after Accept).
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

        let meta: import("@/lib/meta-events").BrowserMetaEvent | null = null;
        if (result.saved) {
          try {
            const { qualifiedEventId, safeParams } = await import("@/lib/meta-events");
            const eventId = await qualifiedEventId(result.phone);
            if (eventId) {
              const params = safeParams({ sells: result.sells, customers: result.customers });
              const { queueMetaEvent } = await import("@/lib/meta-capi.server");
              await queueMetaEvent(supabase, {
                event: "LeadQualified",
                eventId,
                params,
                sourceUrl: request.headers.get("referer"),
                request,
                lead: { phone: result.phone, name: result.name, leadId },
                once: true,
              });
              meta = { event: "LeadQualified", event_id: eventId, params };
            }
          } catch {
            meta = null; // the answers are saved; measurement never changes the answer
          }
        }
        return Response.json({ ok: true, saved: result.saved, meta });
      },
    },
  },
});
