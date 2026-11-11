import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 70: the browser's side door to the Conversions API, for the moments
 * only the browser sees. Every answer is small and never says more than
 * "ok"; nothing here reads or returns customer data.
 *
 *  - ViewContent / Contact: the server copy of a pixel event (same event id),
 *    only with consent (the pixel itself ran), only from our own pages.
 *  - CompleteRegistration: an account created in the last 15 minutes (sign-up
 *    terms), once per user.
 *  - StartTrial: a workspace the signed-in member just created (trial, under
 *    two hours old), once per workspace; answers what the pixel should fire.
 *  - payment: a paid plan / credit payment → the Subscribe / Purchase the
 *    pixel fires (the server sent its own copy when it settled). Sends nothing.
 */

const RECENT_USER_MS = 15 * 60_000;
const RECENT_WORKSPACE_MS = 2 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/public/meta-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ok = (extra: Record<string, unknown> = {}) => Response.json({ ok: true, ...extra });
        let body: Record<string, unknown>;
        try {
          const raw = await request.text();
          if (raw.length > 2000) return Response.json({ error: "Too large." }, { status: 413 });
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Bad request." }, { status: 400 });
        }
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const supabase = getServiceClient();
        const meta = await import("@/lib/meta-events");
        const capi = await import("@/lib/meta-capi.server");
        const event = String(body["event"] ?? "");

        // Only our own site's pages are ever named as the event's page.
        const ownUrl = (value: unknown): string | null => {
          try {
            const u = new URL(String(value ?? ""));
            const own = new URL(request.url);
            return u.host === own.host ? `${u.origin}${u.pathname}` : null;
          } catch {
            return null;
          }
        };

        if (event === "ViewContent" || event === "Contact") {
          const id = body["event_id"];
          if (body["consent"] !== true || !meta.isEventId(id) || !id.startsWith(`${event}.`))
            return ok();
          const url = ownUrl(body["url"]);
          if (!url) return ok();
          await capi.queueMetaEvent(supabase, {
            event,
            eventId: id,
            params: event === "ViewContent" ? { content_name: body["content_name"] } : {},
            sourceUrl: url,
            request,
          });
          return ok();
        }

        if (event === "CompleteRegistration") {
          const userId = String(body["user_id"] ?? "");
          if (!UUID.test(userId)) return ok();
          const person = await capi.loadPerson(supabase, userId);
          const created = person?.createdAt ? Date.parse(person.createdAt) : Number.NaN;
          if (!person || !(Date.now() - created < RECENT_USER_MS)) return ok();
          await capi.queueMetaEvent(supabase, {
            event: "CompleteRegistration",
            eventId: meta.metaEventId("CompleteRegistration", userId),
            userId,
            sourceUrl: ownUrl(body["url"]),
            request,
            once: true,
          });
          return ok();
        }

        if (event === "StartTrial") {
          const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
          const auth = await requireOrgMember(
            request,
            String(body["organization_id"] ?? "") || null,
          );
          if (isResponse(auth)) return ok();
          const { data: org } = await supabase
            .from("organizations")
            .select("id, plan_status, created_at")
            .eq("id", auth.organizationId)
            .maybeSingle();
          const created = Date.parse(String(org?.["created_at"] ?? ""));
          if (
            !org ||
            org["plan_status"] !== "trial" ||
            !(Date.now() - created < RECENT_WORKSPACE_MS)
          )
            return ok();
          // predicted_ltv: the plan they came for (?plan= from pricing), else
          // the first paid public plan, × 6 months.
          const { loadPublicPlans } = await import("@/lib/public-plans.server");
          const plans = (await loadPublicPlans().catch(() => [])).filter(
            (p) => Number(p.price_monthly ?? 0) > 0,
          );
          const wanted = String(body["plan"] ?? "");
          const plan =
            plans.find((p) => p.key === wanted) ??
            [...plans].sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly))[0];
          const params = meta.safeParams({
            value: 0,
            currency: "INR",
            predicted_ltv: meta.predictedLtv(plan?.price_monthly ?? 0, 6),
          });
          const eventId = meta.metaEventId("StartTrial", auth.organizationId);
          await capi.queueMetaEvent(supabase, {
            event: "StartTrial",
            eventId,
            params,
            userId: auth.userId,
            sourceUrl: ownUrl(body["url"]),
            request,
            once: true,
          });
          return ok({ meta: { event: "StartTrial", event_id: eventId, params } });
        }

        if (event === "payment") {
          const paymentId = String(body["payment_id"] ?? "");
          if (!UUID.test(paymentId)) return ok({ meta: null });
          const c = await capi.paymentConversion(supabase, paymentId);
          return ok({
            meta: c ? { event: c.event, event_id: c.eventId, params: c.params } : null,
          });
        }

        return ok();
      },
    },
  },
});
