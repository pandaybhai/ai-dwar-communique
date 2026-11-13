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
        // Batch 78: /start has its own answer (verify on WhatsApp; no Lead yet).
        if (body["source"] === "landing_start") {
          const { startLeadResponse } = await import("@/lib/start-submit.server");
          return startLeadResponse(getServiceClient(), request, body, result);
        }
        // Batch 72: Lead to Meta's Conversions API for every /demo lead,
        // whatever the cookie banner said (as our other server events; the
        // browser pixel still waits for Accept). One id per person — "Lead." +
        // sha256 of the number — so /start, /demo and sign-up count once.
        // Only hashed matching (number, name, lead id); fbc from the fbclid
        // the visitor arrived with. Batch 77: that fbc, the _fbp cookie (only
        // when it exists) and the external_id are kept on the lead for its
        // later stage events — never the raw IP or user agent. (Batch 78:
        // /start's Lead waits for WhatsApp verification — start-submit.server.ts.)
        let meta: import("@/lib/meta-events").BrowserMetaEvent | null = null;
        try {
          const { fbcFromFbclid, leadEventId, safeParams } = await import("@/lib/meta-events");
          const eventId = await leadEventId(result.phone ?? null, result.id);
          const params = safeParams({ content_name: "demo", lead_source: "landing" });
          const { queueMetaEvent, requestFacts } = await import("@/lib/meta-capi.server");
          const fbc = fbcFromFbclid(body["fbclid"], body["fbclid_at"]);
          if (result.id && !result.duplicate) {
            const facts = requestFacts(request);
            const { rememberLeadMatching } = await import("@/lib/lead-stage-events.server");
            await rememberLeadMatching(getServiceClient(), result.id, {
              fbc: facts.fbc ?? fbc,
              fbp: facts.fbp ?? null,
            });
          }
          await queueMetaEvent(getServiceClient(), {
            event: "Lead",
            eventId,
            params,
            sourceUrl: request.headers.get("referer"),
            request,
            lead: { phone: result.phone ?? null, name: result.name ?? null, leadId: result.id },
            fbc,
            once: true,
          });
          meta = { event: "Lead", event_id: eventId, params };
        } catch {
          meta = null; // the lead is saved; measurement never changes the answer
        }
        // Batch 76: the lead appears in AiDwar's own workspace (contact, tag
        // "AiDwar lead", attributes). Sends nothing; never fails the answer.
        if (result.id) {
          const { mirrorLead } = await import("@/lib/lead-mirror.server");
          await mirrorLead(getServiceClient(), result.id);
        }
        return Response.json({ ok: true, duplicate: result.duplicate, meta });
      },
    },
  },
});
