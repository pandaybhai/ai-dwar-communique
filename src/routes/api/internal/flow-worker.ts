import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Flow worker — one tick per minute from pg_cron.
 *
 * Claims a small batch of due scheduled sends (FOR UPDATE SKIP LOCKED inside
 * claim_scheduled_sends) and re-checks every gate at dispatch time before it
 * sends: cancellation/recovery, opt-in class, quiet hours and frequency cap.
 * A failure is terminal — status 'failed' with the provider error — so a bad
 * row can never be retried forever.
 */

const CLAIM_LIMIT = 25;

export const Route = createFileRoute("/api/internal/flow-worker")({
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
        const { emitEvent } = await import("@/lib/events.server");
        const flows = await import("@/lib/flows.server");

        const supabase = getServiceClient();

        const { data: claimed } = await supabase.rpc("claim_scheduled_sends", {
          p_limit: CLAIM_LIMIT,
        });
        const batch = (claimed ?? []) as Array<{
          id: string;
          organization_id: string;
          flow_id: string;
          flow_step_id: string;
          contact_id: string | null;
          trigger_type: string;
          trigger_id: string | null;
        }>;

        const outcomes: Array<Record<string, unknown>> = [];

        for (const send of batch) {
          const orgId = send.organization_id;

          const finish = async (
            status: "sent" | "cancelled" | "skipped" | "failed",
            patch: Record<string, unknown>,
            event: { type: string; properties: Record<string, unknown> } | null,
          ) => {
            await supabase
              .from("scheduled_sends")
              .update({ status, claimed_at: null, ...patch })
              .eq("id", send.id);
            if (event) {
              emitEvent(supabase, event.type, {
                organizationId: orgId,
                entityType: "scheduled_send",
                entityId: send.id,
                properties: event.properties,
              });
            }
            outcomes.push({ id: send.id, status, ...patch });
          };

          const { data: flowRow } = await supabase
            .from("flows")
            .select("id, organization_id, key, name, is_enabled, whatsapp_account_id, config")
            .eq("id", send.flow_id)
            .maybeSingle();
          const flow = flowRow as flowsFlow | null;

          const { data: stepRow } = await supabase
            .from("flow_steps")
            .select("id, flow_id, step_order, delay_minutes, template_id, condition, is_enabled")
            .eq("id", send.flow_step_id)
            .maybeSingle();
          const step = stepRow as {
            id: string;
            step_order: number;
            template_id: string | null;
            is_enabled: boolean;
          } | null;

          const baseProps = {
            flow_key: flow?.key ?? null,
            flow_id: send.flow_id,
            step_order: step?.step_order ?? null,
            contact_id: send.contact_id,
            trigger_type: send.trigger_type,
            trigger_id: send.trigger_id,
          };

          if (!flow || !flow.is_enabled || !step || !step.is_enabled) {
            await finish("skipped", { cancel_reason: "flow_disabled" }, {
              type: "flow.skipped",
              properties: { ...baseProps, reason: "flow_disabled" },
            });
            continue;
          }

          const messageClass = flows.messageClassOf(flow);

          // Recovery/cancellation can happen after scheduling, so it is checked
          // again here — immediately before dispatch, not only on ingest.
          const validity = await flows.triggerStillValid(
            supabase,
            send.trigger_type,
            send.trigger_id,
          );
          if (!validity.valid) {
            await finish("cancelled", { cancel_reason: validity.reason ?? "invalid_trigger" }, {
              type: "flow.cancelled",
              properties: { ...baseProps, reason: validity.reason ?? "invalid_trigger" },
            });
            continue;
          }

          if (!send.contact_id) {
            await finish("skipped", { cancel_reason: "no_contact" }, {
              type: "flow.skipped",
              properties: { ...baseProps, reason: "no_contact" },
            });
            continue;
          }

          const { data: contactRow } = await supabase
            .from("contacts")
            .select("id, name, phone, opt_in_status")
            .eq("id", send.contact_id)
            .maybeSingle();
          const contact = contactRow as {
            id: string;
            name: string | null;
            phone: string;
            opt_in_status: string | null;
          } | null;

          if (!contact) {
            await finish("skipped", { cancel_reason: "no_contact" }, {
              type: "flow.skipped",
              properties: { ...baseProps, reason: "no_contact" },
            });
            continue;
          }

          const consent = flows.optInAllows(contact.opt_in_status, messageClass);
          if (!consent.allowed) {
            await finish("skipped", { cancel_reason: consent.reason ?? "no_consent" }, {
              type: "flow.skipped",
              properties: {
                ...baseProps,
                reason: consent.reason ?? "no_consent",
                message_class: messageClass,
              },
            });
            continue;
          }

          const settings = await flows.loadSendSettings(supabase, orgId);

          // Quiet hours defer, never skip.
          const now = new Date();
          const allowedAt = flows.applyQuietHours(now, settings, messageClass);
          if (allowedAt.getTime() > now.getTime()) {
            await supabase
              .from("scheduled_sends")
              .update({ send_after: allowedAt.toISOString(), claimed_at: null })
              .eq("id", send.id);
            outcomes.push({ id: send.id, status: "deferred", send_after: allowedAt.toISOString() });
            continue;
          }

          if (messageClass === "marketing") {
            const capped = await flows.frequencyCapReached(
              supabase,
              orgId,
              contact.id,
              settings,
            );
            if (capped) {
              await finish("skipped", { cancel_reason: "frequency_cap" }, {
                type: "flow.skipped",
                properties: { ...baseProps, reason: "frequency_cap", message_class: messageClass },
              });
              continue;
            }
          }

          if (!step.template_id) {
            await finish("failed", { error: "No template is configured for this step." }, {
              type: "flow.skipped",
              properties: { ...baseProps, reason: "no_template" },
            });
            continue;
          }

          const { data: templateRow } = await supabase
            .from("message_templates")
            .select("name, language, category, status, components")
            .eq("id", step.template_id)
            .eq("organization_id", orgId)
            .maybeSingle();
          const template = templateRow as {
            name: string;
            language: string;
            category: string | null;
            status: string;
            components: unknown;
          } | null;

          if (!template || template.status !== "APPROVED") {
            await finish("failed", { error: "The step's template is missing or not approved." }, {
              type: "flow.skipped",
              properties: { ...baseProps, reason: "template_unavailable" },
            });
            continue;
          }

          const sender = await loadSenderContext(supabase, orgId, flow.whatsapp_account_id);
          if (!sender) {
            await finish("failed", { error: "No connected number is available to send from." }, {
              type: "flow.skipped",
              properties: { ...baseProps, reason: "no_sender" },
            });
            continue;
          }

          const variables = await flows.resolveFlowVariables(
            supabase,
            send.trigger_type,
            send.trigger_id,
            contact,
          );

          const outcome = await sendCampaignTemplate(
            supabase,
            orgId,
            sender,
            { contactId: contact.id, phone: contact.phone, variables },
            {
              name: template.name,
              language: template.language || "en_US",
              variableOrder: extractVariables(templateBodyText((template.components ?? []) as never)),
            },
            {
              campaignId: null,
              category: String(template.category ?? "utility").toLowerCase(),
            },
          );

          if (outcome.error) {
            await finish(
              "failed",
              { error: outcome.error, message_id: outcome.messageId },
              {
                type: "flow.skipped",
                properties: { ...baseProps, reason: "send_failed", error: outcome.error },
              },
            );
            continue;
          }

          await finish(
            "sent",
            { message_id: outcome.messageId, error: null, cancel_reason: null },
            {
              type: "flow.sent",
              properties: {
                ...baseProps,
                reason: null,
                message_class: messageClass,
                message_id: outcome.messageId,
                template_name: template.name,
                whatsapp_account_id: sender.accountId,
              },
            },
          );
        }

        return Response.json({
          claimed: batch.length,
          outcomes,
          commit: buildInfo().commit,
        });
      },
    },
  },
});

type flowsFlow = {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  is_enabled: boolean;
  whatsapp_account_id: string | null;
  config: Record<string, unknown> | null;
};
