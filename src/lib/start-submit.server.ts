import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadResult } from "@/lib/leads.server";

/**
 * Batch 78: what /api/public/demo-leads answers for a /start lead (step 3 of
 * the card — answers, name, business name, number — saved once, complete).
 *
 *  - The lead appears in AiDwar's own workspace (Batch 76 mirror).
 *  - Meta gets "LeadUnverified" (server; the browser copy only after the
 *    cookie banner's Accept) — never "Lead": that waits for the WhatsApp
 *    proof (lead-verify.server.ts).
 *  - Two httpOnly cookies: the signed lead (Batch 75) and this browser's
 *    random nonce; then a VERIFY code bound to the lead, its number and the
 *    nonce. When verification isn't available the answer has verify: null
 *    and the page goes on to /signup — nobody is stuck.
 */
export async function startLeadResponse(
  supabase: SupabaseClient,
  request: Request,
  body: Record<string, unknown>,
  result: Extract<LeadResult, { ok: true }>,
): Promise<Response> {
  const headers = new Headers();
  const phone = result.phone ?? null;

  // Batch 76: the lead's contact in AiDwar's workspace. Sends nothing.
  const { mirrorLead } = await import("@/lib/lead-mirror.server");
  await mirrorLead(supabase, result.id);

  let meta: import("@/lib/meta-events").BrowserMetaEvent | null = null;
  try {
    const { fbcFromFbclid, safeParams, unverifiedEventId } = await import("@/lib/meta-events");
    const eventId = await unverifiedEventId(phone);
    if (eventId) {
      const params = safeParams({
        lead_source: "landing_start",
        sells: result.sells,
        customers: result.customers,
      });
      const { queueMetaEvent, requestFacts } = await import("@/lib/meta-capi.server");
      // Batch 77: what this visit is matched with (fbc, the _fbp cookie only
      // when it exists, the external_id) is kept on the lead for its later
      // stage events and the verified Lead — never the raw IP or user agent.
      if (!result.duplicate) {
        const facts = requestFacts(request);
        const { rememberLeadMatching } = await import("@/lib/lead-stage-events.server");
        await rememberLeadMatching(supabase, result.id, {
          fbc: facts.fbc ?? fbcFromFbclid(body["fbclid"], body["fbclid_at"]),
          fbp: facts.fbp ?? null,
        });
      }
      await queueMetaEvent(supabase, {
        event: "LeadUnverified",
        eventId,
        params,
        sourceUrl: request.headers.get("referer"),
        request,
        lead: { phone, name: result.name ?? null, leadId: result.id },
        fbc: fbcFromFbclid(body["fbclid"], body["fbclid_at"]),
        once: true,
      });
      meta = { event: "LeadUnverified", event_id: eventId, params };
    }
  } catch {
    meta = null; // the lead is saved; measurement never changes the answer
  }

  let verify: { wa_link: string; message: string; expires_at: string } | null = null;
  try {
    const { startLeadSetCookie } = await import("@/lib/start-lead-cookie.server");
    headers.append("set-cookie", await startLeadSetCookie(result.id));
    const { issueVerifyCode, newNonce, nonceSetCookie } = await import("@/lib/lead-verify.server");
    const nonce = newNonce();
    const issued = phone
      ? await issueVerifyCode(supabase, { leadId: result.id, phone, nonce })
      : null;
    if (issued?.ok) {
      headers.append("set-cookie", nonceSetCookie(nonce));
      verify = {
        wa_link: issued.issued.waLink,
        message: issued.issued.message,
        expires_at: issued.issued.expiresAt,
      };
    }
  } catch {
    verify = null; // no signing key / no verification: on to /signup unverified
  }

  return Response.json({ ok: true, duplicate: result.duplicate, meta, verify }, { headers });
}
