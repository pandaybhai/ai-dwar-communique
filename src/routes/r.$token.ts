import { createFileRoute } from "@tanstack/react-router";

/**
 * Short link resolver — the destination behind every template link button.
 *
 * A customer tapping this must always land somewhere useful. An unknown or
 * expired token sends them to the merchant's shop, never to an error page.
 *
 * Both the click count and the flow.clicked event are awaited before the
 * redirect is returned. They used to be fired and forgotten, and the runtime
 * discarded them the moment the response left — which is exactly how two
 * recorded clicks produced zero events.
 */
export const Route = createFileRoute("/r/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { resolveShortLink, recordShortLinkClick, fallbackShopUrl } = await import(
          "@/lib/short-links.server"
        );

        const supabase = getServiceClient();
        const token = String(params.token ?? "").trim();
        const link = token ? await resolveShortLink(supabase, token) : null;

        const expired =
          link?.expires_at != null && new Date(link.expires_at).getTime() < Date.now();

        if (!link || expired) {
          const fallback = await fallbackShopUrl(supabase, link?.organization_id ?? null);
          return Response.redirect(fallback, 302);
        }

        // Counting the click and recording the event are independent: a failure
        // in one must not swallow the other, and neither may block the customer.
        try {
          await recordShortLinkClick(supabase, link);
        } catch (caught) {
          console.warn(
            JSON.stringify({
              scope: "short_links",
              stage: "click_count_failed",
              token,
              error: caught instanceof Error ? caught.message : String(caught),
            }),
          );
        }

        try {
          const { emitEvent } = await import("@/lib/events.server");

          let flowId: string | null = null;
          let flowStepId: string | null = null;
          if (link.scheduled_send_id) {
            const { data } = await supabase
              .from("scheduled_sends")
              .select("flow_id, flow_step_id")
              .eq("id", link.scheduled_send_id)
              .maybeSingle();
            const send = data as { flow_id?: string; flow_step_id?: string } | null;
            flowId = send?.flow_id ?? null;
            flowStepId = send?.flow_step_id ?? null;
          }

          await emitEvent(supabase, "flow.clicked", {
            organizationId: link.organization_id,
            entityType: "short_link",
            entityId: link.id,
            properties: {
              scheduled_send_id: link.scheduled_send_id,
              flow_id: flowId,
              flow_step_id: flowStepId,
              contact_id: link.contact_id,
              campaign_id: link.campaign_id,
            },
          });
        } catch (caught) {
          console.warn(
            JSON.stringify({
              scope: "short_links",
              stage: "click_event_failed",
              token,
              error: caught instanceof Error ? caught.message : String(caught),
            }),
          );
        }

        return Response.redirect(link.target_url, 302);
      },
    },
  },
});
