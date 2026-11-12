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
        // Batch 75: a /start honeypot hit looks like any other "ok" — nothing
        // saved, nothing fired, no cookie.
        if (result.honeypot) return Response.json({ ok: true, duplicate: false, meta: null });
        // Batch 72: Lead to Meta's Conversions API for every lead, whatever
        // the cookie banner said (as our other server events; the browser
        // pixel still waits for Accept). One id per person — "Lead." +
        // sha256 of the number — so /start, /demo and sign-up count once.
        // Only hashed matching (number, name, lead id); fbc from the fbclid
        // the visitor arrived with, never stored.
        let meta: import("@/lib/meta-events").BrowserMetaEvent | null = null;
        try {
          const { fbcFromFbclid, leadEventId, safeParams } = await import("@/lib/meta-events");
          const start = body["source"] === "landing_start";
          const eventId = await leadEventId(result.phone ?? null, result.id);
          const params = safeParams({
            content_name: start ? "start_free_trial" : "demo",
            lead_source: start ? "landing_start" : "landing",
          });
          const { queueMetaEvent } = await import("@/lib/meta-capi.server");
          await queueMetaEvent(getServiceClient(), {
            event: "Lead",
            eventId,
            params,
            sourceUrl: request.headers.get("referer"),
            request,
            lead: { phone: result.phone ?? null, name: result.name ?? null, leadId: result.id },
            fbc: fbcFromFbclid(body["fbclid"], body["fbclid_at"]),
            once: true,
          });
          meta = { event: "Lead", event_id: eventId, params };
        } catch {
          meta = null; // the lead is saved; measurement never changes the answer
        }
        // Batch 75: the /start lead this browser created (or repeated) is
        // signed into an httpOnly cookie, so the two questions that follow
        // can answer for this lead and no other.
        const headers = new Headers();
        if (body["source"] === "landing_start" && result.id) {
          try {
            const { startLeadSetCookie } = await import("@/lib/start-lead-cookie.server");
            headers.append("set-cookie", await startLeadSetCookie(result.id));
          } catch {
            // no signing key: the lead is saved; the questions just can't be stored
          }
        }
        return Response.json({ ok: true, duplicate: result.duplicate, meta }, { headers });
      },
    },
  },
});
