import { createFileRoute } from "@tanstack/react-router";

/**
 * Short link resolver — the destination behind every template link button.
 *
 * A customer tapping this must always land somewhere useful. An unknown or
 * expired token sends them to the merchant's shop, never to an error page.
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

        try {
          await recordShortLinkClick(supabase, link);

          const [{ emitEvent }, sendRow] = await Promise.all([
            import("@/lib/events.server"),
            link.scheduled_send_id
              ? supabase
                  .from("scheduled_sends")
                  .select("flow_id, flow_step_id")
                  .eq("id", link.scheduled_send_id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
          ]);

          const send = (sendRow as { data: { flow_id?: string; flow_step_id?: string } | null })
            .data;

          emitEvent(supabase, "flow.clicked", {
            organizationId: link.organization_id,
            entityType: "short_link",
            entityId: link.id,
            properties: {
              scheduled_send_id: link.scheduled_send_id,
              flow_id: send?.flow_id ?? null,
              flow_step_id: send?.flow_step_id ?? null,
              contact_id: link.contact_id,
              campaign_id: null,
            },
          });
        } catch (caught) {
          // Counting a click must never stand between a customer and their cart.
          console.warn(
            JSON.stringify({
              scope: "short_links",
              stage: "click_record_failed",
              error: caught instanceof Error ? caught.message : String(caught),
            }),
          );
        }

        return Response.redirect(link.target_url, 302);
      },
    },
  },
});
