import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 82: the /199 checkout — the /999 checkout's server steps
 * (checkout-999.server.ts) with PAGE_199: lead source landing_199, its own
 * lead cookie, ₹199 decided on the server (startPlanPurchase). One ₹199 per
 * workspace and per WhatsApp number: a number that paid before is told so
 * right after its lead is saved (the team still sees the lead), and "pay"
 * checks the workspace and the number again before any order exists — a used
 * offer answers 409 { code: "offer_used" } and nothing is created.
 *
 * Batch 80 (/999), the same steps:
 *
 *  - POST { action: "lead", phone, name, business_name, company_website_confirm }
 *    anonymous: saves the lead once (source landing_999) and sets the signed
 *    httpOnly lead cookie. Answers { ok, lead: true } — never the lead's id.
 *  - POST { action: "pay", phone, organization_id? } with the buyer's session
 *    (Authorization: Bearer): starts the Basic plan's payment for their own
 *    workspace and answers the Cashfree session for the popup, or
 *    { code: "needs_workspace" } so the sheet creates the workspace first.
 */
export const Route = createFileRoute("/api/public/checkout-199")({
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
          const saved = await c.saveCheckoutLead(
            supabase,
            body,
            {
              ip,
              referrer: request.headers.get("referer"),
              cookieLeadId: await c.leadFromCookie(request, c.PAGE_199).catch(() => null),
            },
            c.PAGE_199,
          );
          if (!saved.ok) {
            return Response.json(
              { error: saved.error, ...(saved.field ? { field: saved.field } : {}) },
              { status: saved.status },
            );
          }
          const headers = new Headers();
          if (saved.id) {
            try {
              headers.append("set-cookie", await c.leadCookie(saved.id, c.PAGE_199));
            } catch {
              // no signing key: the lead is saved; it just won't be linked
            }
          }
          // This number already had its ₹199: say so now (no account, no order).
          const checked = c.checkCheckoutFields({ phone: body["phone"], name: "ok" });
          if (checked.ok && !saved.honeypot && body["admin_test_price"] !== 1) {
            const used = await c.introCheck199(supabase, {
              organizationId: null,
              phone: checked.lead.phone,
            });
            if (used !== "eligible") {
              return Response.json(
                { error: c.OFFER_USED_MESSAGE, code: "offer_used" },
                { status: 409, headers },
              );
            }
          }
          return Response.json({ ok: true, lead: true }, { headers });
        }

        // Batch 81: the account, with no password typed (createOrRecallAccount).
        if (action === "account") {
          const out = await c.createOrRecallAccount(
            supabase,
            {
              leadId: await c.leadFromCookie(request, c.PAGE_199).catch(() => null),
              phone: String(body["phone"] ?? ""),
              name: String(body["name"] ?? ""),
              email: String(body["email"] ?? ""),
            },
            c.PAGE_199,
          );
          if (!out.ok) {
            return Response.json(
              { error: out.error, ...(out.field ? { field: out.field } : {}) },
              { status: out.status },
            );
          }
          return Response.json(out);
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
            leadId: await c.leadFromCookie(request, c.PAGE_199).catch(() => null),
            phone: checked.lead.phone,
            organizationId: orgId,
            request,
            page: c.PAGE_199,
            ...("admin_test_price" in body ? { adminTestPrice: body["admin_test_price"] } : {}),
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
