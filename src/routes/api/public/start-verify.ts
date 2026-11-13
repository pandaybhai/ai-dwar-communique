import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 78: /start's WhatsApp verification, from the browser that made the
 * lead. The lead comes only from the signed httpOnly lead cookie and the
 * browser only from its httpOnly nonce cookie — never from the request body.
 *
 *  GET  → { state: "none" | "waiting" | "verified" | "expired" } (the page
 *         asks every 2 s while visible, for at most 15 minutes).
 *  POST { action: "new_code" } → a fresh code (and nonce) for the same lead.
 *  POST { fbclid?, fbclid_at?, action: "claim" } → once verified: the
 *         details for /signup's prefill, and Meta's Lead (sent from here, the
 *         visitor's own request) for the browser pixel after consent.
 */
async function context(request: Request) {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { readStartLeadToken, startLeadFromRequest } =
    await import("@/lib/start-lead-cookie.server");
  const { nonceFromRequest } = await import("@/lib/lead-verify.server");
  let leadId: string | null = null;
  try {
    leadId = await readStartLeadToken(startLeadFromRequest(request));
  } catch {
    leadId = null;
  }
  return { supabase: getServiceClient(), leadId, nonce: nonceFromRequest(request) };
}

const noStore = { "cache-control": "no-store" };

export const Route = createFileRoute("/api/public/start-verify")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { supabase, leadId, nonce } = await context(request);
        if (!leadId || !nonce) return Response.json({ state: "none" }, { headers: noStore });
        const { pollVerify } = await import("@/lib/lead-verify.server");
        return Response.json(
          { state: await pollVerify(supabase, { leadId, nonce }) },
          { headers: noStore },
        );
      },
      POST: async ({ request }) => {
        const { supabase, leadId, nonce } = await context(request);
        if (!leadId) {
          return Response.json(
            { error: "We couldn't find your details. Please start again." },
            { status: 403 },
          );
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await request.text();
          if (raw.length > 2000) {
            return Response.json({ error: "That request was too large." }, { status: 413 });
          }
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          return Response.json({ error: "We couldn't read that request." }, { status: 400 });
        }
        const server = await import("@/lib/lead-verify.server");

        if (body["action"] === "new_code") {
          const lead = await server.readStartLead(supabase, leadId);
          if (!lead)
            return Response.json({ error: "We couldn't find your details." }, { status: 404 });
          const fresh = server.newNonce();
          const issued = await server.issueVerifyCode(supabase, {
            leadId,
            phone: lead.phone,
            nonce: fresh,
          });
          if (!issued.ok) {
            return Response.json({ error: issued.error }, { status: issued.status });
          }
          return Response.json(
            {
              verify: {
                wa_link: issued.issued.waLink,
                message: issued.issued.message,
                expires_at: issued.issued.expiresAt,
              },
            },
            { headers: { "set-cookie": server.nonceSetCookie(fresh), ...noStore } },
          );
        }

        if (body["action"] === "claim") {
          if (!nonce) return Response.json({ state: "none" }, { status: 409 });
          const { fbcFromFbclid } = await import("@/lib/meta-events");
          const out = await server.claimVerified(supabase, {
            leadId,
            nonce,
            request,
            fbc: fbcFromFbclid(body["fbclid"], body["fbclid_at"]),
          });
          if (!out.ok) return Response.json({ state: out.state }, { status: 409 });
          return Response.json(
            { state: "verified", prefill: out.prefill, meta: out.meta },
            { headers: noStore },
          );
        }

        return Response.json({ error: "Unknown action." }, { status: 400 });
      },
    },
  },
});
