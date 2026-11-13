import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 80: the /999 checkout sheet's two server steps (checkout-999.server.ts).
 *
 *  - POST { action: "lead", phone, name, business_name, company_website_confirm }
 *    anonymous: saves the lead once (source landing_999) and sets the signed
 *    httpOnly lead cookie. Answers { ok, lead: true } — never the lead's id.
 *  - POST { action: "pay", phone, organization_id? } with the buyer's session
 *    (Authorization: Bearer): starts the Basic plan's payment for their own
 *    workspace and answers the Cashfree session for the popup, or
 *    { code: "needs_workspace" } so the sheet creates the workspace first.
 */
export const Route = createFileRoute("/api/public/checkout-999")({
  server: {
    handlers: {
      GET: async () => Response.json({ error: "Not allowed." }, { status: 405 }),
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          const raw = await request.text();
          if (raw.length > 4000) return Response.json({ error: "Too large." }, { status: 413 });
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Bad request." }, { status: 400 });
        }
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const supabase = getServiceClient();
        const c = await import("@/lib/checkout-999.server");
        const action = body["action"];

        if (action === "lead") {
          const ip =
            request.headers.get("cf-connecting-ip") ??
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            null;
          const saved = await c.saveCheckoutLead(supabase, body, {
            ip,
            referrer: request.headers.get("referer"),
            cookieLeadId: await c.leadFromCookie(request).catch(() => null),
          });
          if (!saved.ok) {
            return Response.json(
              { error: saved.error, ...(saved.field ? { field: saved.field } : {}) },
              { status: saved.status },
            );
          }
          const headers = new Headers();
          if (saved.id) {
            try {
              headers.append("set-cookie", await c.leadCookie(saved.id));
            } catch {
              // no signing key: the lead is saved; it just won't be linked
            }
          }
          return Response.json({ ok: true, lead: true }, { headers });
        }

        if (action === "pay") {
          const { requireSignedIn, isResponse } = await import("@/lib/whatsapp-api.server");
          const auth = await requireSignedIn(request);
          if (isResponse(auth)) return auth;
          const checked = c.checkCheckoutFields({
            phone: body["phone"],
            name: "ok",
            business_name: "ok",
          });
          if (!checked.ok) {
            return Response.json({ error: checked.error, field: "phone" }, { status: 400 });
          }
          const orgId =
            typeof body["organization_id"] === "string" &&
            /^[0-9a-f-]{36}$/i.test(body["organization_id"])
              ? body["organization_id"]
              : null;
          const started = await c.startCheckoutPayment(supabase, {
            userId: auth.userId,
            leadId: await c.leadFromCookie(request).catch(() => null),
            phone: checked.lead.phone,
            organizationId: orgId,
            request,
          });
          if (!started.ok) {
            return Response.json(
              { error: started.error, ...(started.code ? { code: started.code } : {}) },
              { status: started.status },
            );
          }
          return Response.json(started);
        }

        return Response.json({ error: "Unknown action." }, { status: 400 });
      },
    },
  },
});
