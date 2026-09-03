import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

const CLAIM_LIMIT = 30;

export const Route = createFileRoute("/api/internal/campaign-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { loadSenderContext, sendCampaignTemplate } = await import("@/lib/campaigns.server");
        const { extractVariables, templateBodyText } = await import("@/lib/templates");

        const supabase = getServiceClient();
        const nowIso = new Date().toISOString();

        const { data: campaigns } = await supabase
          .from("campaigns")
          .select(
            "id, organization_id, whatsapp_account_id, status, template_name, template_language, scheduled_at, started_at, send_settings",
          )
          .or(`status.eq.sending,and(status.eq.scheduled,scheduled_at.lte.${nowIso})`)
          .order("created_at", { ascending: true })
          .limit(5);

        const report: Array<Record<string, unknown>> = [];

        for (const campaign of (campaigns ?? []) as Array<Record<string, unknown>>) {
          const campaignId = campaign["id"] as string;
          const orgId = campaign["organization_id"] as string;

          if (campaign["status"] === "scheduled") {
            await supabase
              .from("campaigns")
              .update({ status: "sending", started_at: campaign["started_at"] ?? nowIso })
              .eq("id", campaignId);
          }

          const templateName = (campaign["template_name"] as string | null) ?? "";
          if (!templateName) {
            await supabase.from("campaigns").update({ status: "failed" }).eq("id", campaignId);
            continue;
          }

          // The campaign carries the number it was created for.
          const sender = await loadSenderContext(
            supabase,
            orgId,
            (campaign["whatsapp_account_id"] as string | null) ?? null,
          );
          if (!sender) {
            await supabase.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
            report.push({ campaign_id: campaignId, paused: "no_active_whatsapp_account" });
            continue;
          }

          const { data: template } = await supabase
            .from("message_templates")
            .select("components, category")
            .eq("organization_id", orgId)
            // Template libraries are per business account.
            .eq("waba_id", sender.wabaId)
            .eq("name", templateName)
            .limit(1)
            .maybeSingle();
          const templateCategory = String(
            (template as { category?: string } | null)?.category ?? "marketing",
          ).toLowerCase();
          const variableOrder = extractVariables(
            templateBodyText((template?.components ?? []) as never),
          );

          // Media chosen when the campaign was created — the header file and
          // one file per carousel card. Anything left blank falls back to the
          // file the template itself was authored with.
          const settings = (campaign["send_settings"] ?? {}) as Record<string, unknown>;
          const headerMediaUrl = (settings["header_media_url"] as string | null) ?? null;
          const settingCards = Array.isArray(settings["cards"])
            ? (settings["cards"] as Array<{ media_url?: string | null }>).map((c) => ({
                mediaUrl: c?.media_url ?? null,
              }))
            : [];
          // Offer details chosen when the campaign was created.
          const couponCode = (settings["coupon_code"] as string | null) ?? null;
          const offerExpiresAt = (settings["offer_expires_at"] as string | null) ?? null;

          const { data: claimed } = await supabase.rpc("claim_campaign_recipients", {
            p_campaign_id: campaignId,
            p_limit: CLAIM_LIMIT,
          });
          const batch = (claimed ?? []) as Array<{
            id: string;
            contact_id: string | null;
            phone: string;
            resolved_variables: Record<string, string> | null;
          }>;

          let sent = 0;
          let failed = 0;

          for (const recipient of batch) {
            const outcome = await sendCampaignTemplate(
              supabase,
              orgId,
              sender,
              {
                contactId: recipient.contact_id,
                phone: recipient.phone,
                variables: recipient.resolved_variables ?? {},
              },
              {
                name: templateName,
                language: (campaign["template_language"] as string) ?? "en_US",
                variableOrder,
                components: (template?.components ?? null) as never,
              },
              {
                campaignId,
                category: templateCategory,
                ...(headerMediaUrl ? { headerMediaUrl } : {}),
                ...(settingCards.length ? { cards: settingCards } : {}),
                ...(couponCode ? { couponCode } : {}),
                ...(offerExpiresAt ? { offerExpiresAt } : {}),
              },
            );

            if (outcome.error) {
              failed += 1;
              await supabase
                .from("campaign_recipients")
                .update({ status: "failed", error: outcome.error, message_id: outcome.messageId })
                .eq("id", recipient.id);
            } else {
              sent += 1;
              await supabase
                .from("campaign_recipients")
                .update({ status: "sent", message_id: outcome.messageId, error: null })
                .eq("id", recipient.id);
            }
          }

          if (sent || failed) {
            await supabase.rpc("bump_campaign_counters", {
              p_campaign_id: campaignId,
              p_sent: sent,
              p_failed: failed,
            });
          }

          const { count: remaining } = await supabase
            .from("campaign_recipients")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", campaignId)
            .in("status", ["queued", "sending"]);

          if (!remaining) {
            const { data: finished } = await supabase
              .from("campaigns")
              .update({ status: "completed", completed_at: new Date().toISOString() })
              .eq("id", campaignId)
              .eq("status", "sending")
              .select("id, sent_count, failed_count");
            // Only the run that actually flipped the row emits, so a retry of
            // the worker can't double-count a completion.
            if (finished && finished.length > 0) {
              const { emitEvent } = await import("@/lib/events.server");
              await emitEvent(supabase, "campaign.completed", {
                organizationId: campaign["organization_id"] as string,
                whatsappAccountId: (campaign["whatsapp_account_id"] as string | null) ?? null,
                entityType: "campaign",
                entityId: campaignId,
                properties: {
                  campaign_id: campaignId,
                  template_name: (campaign["template_name"] as string | null) ?? null,
                  sent_count: finished[0]!.sent_count ?? null,
                  failed_count: finished[0]!.failed_count ?? null,
                },
              });
            }
          }

          report.push({ campaign_id: campaignId, sent, failed, remaining: remaining ?? 0 });
        }

        return Response.json({
          processed: report.length,
          campaigns: report,
          commit: buildInfo().commit,
        });
      },
    },
  },
});
