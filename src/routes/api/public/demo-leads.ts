import { createFileRoute } from "@tanstack/react-router";

/**
 * Public demo enquiry intake. Write-only on purpose: nobody can list or read
 * leads through this route, and the table itself is unreachable from any
 * client key. All validation, normalisation and rate limiting is server-side.
 */
export const Route = createFileRoute("/api/public/demo-leads")({
  server: {
    handlers: {
      GET: async () => Response.json({ error: "Not allowed." }, { status: 405 }),
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { submitLead } = await import("@/lib/leads.server");

        let body: Record<string, unknown>;
        try {
          const raw = await request.text();
          if (raw.length > 8000) {
            return Response.json({ error: "That request was too large." }, { status: 413 });
          }
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "We couldn't read that request." }, { status: 400 });
        }

        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;

        const result = await submitLead(getServiceClient(), body, {
          ip,
          referrer: request.headers.get("referer"),
        });

        if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
        // Batch 70: Lead's server copy, only when the visitor accepted the
        // cookie banner (the pixel fired with this same id) and it isn't a repeat.
        // The lead's own details are never sent.
        if (!result.duplicate && body["meta_consent"] === true) {
          const { isEventId } = await import("@/lib/meta-events");
          const id = body["meta_event_id"];
          if (isEventId(id) && id.startsWith("Lead.")) {
            const { queueMetaEvent } = await import("@/lib/meta-capi.server");
            await queueMetaEvent(getServiceClient(), {
              event: "Lead",
              eventId: id,
              sourceUrl: request.headers.get("referer"),
              request,
            });
          }
        }
        return Response.json({ ok: true, duplicate: result.duplicate });
      },
    },
  },
});
