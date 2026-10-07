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
/**
 * Written on the row (error column) right before Meta is asked; the status
 * check has no 'sending'. A row claimed again with it still there belongs to
 * a run that died mid-send: it is settled from the message rows, never sent
 * a second time.
 */
const SEND_STARTED = "send_started";

/** One flow-worker tick (the route checks the cron secret first). */
export async function runFlowWorker(): Promise<Record<string, unknown>> {
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

  await Promise.all(batch.map(async (send) => {
    const orgId = send.organization_id;

    const finish = async (
      status: "sent" | "cancelled" | "skipped" | "failed",
      patch: Record<string, unknown>,
      event: { type: string; properties: Record<string, unknown> } | null,
    ) => {
      const { error: finishError } = await supabase
        .from("scheduled_sends")
        .update({ status, claimed_at: null, ...patch })
        .eq("id", send.id);
      if (finishError) throw new Error(`Could not persist ${status}: ${finishError.message}`);
      if (event) {
        await emitEvent(supabase, event.type, {
          organizationId: orgId,
          entityType: "scheduled_send",
          entityId: send.id,
          properties: event.properties,
        });
      }
      outcomes.push({ id: send.id, status, ...patch });
    };

    // Mark the send started (only while still scheduled) before Meta is asked.
    const markStarted = async () => {
      const { error: markError } = await supabase
        .from("scheduled_sends")
        .update({ error: SEND_STARTED })
        .eq("id", send.id)
        .eq("status", "scheduled");
      if (markError) throw new Error(`Could not mark the send started: ${markError.message}`);
    };

    try {

    if ((send as { error?: string | null }).error === SEND_STARTED) {
      const retakeProps = {
        flow_id: send.flow_id,
        scheduled_send_id: send.id,
        contact_id: send.contact_id,
        trigger_type: send.trigger_type,
        trigger_id: send.trigger_id,
      };
      // Re-taken after a run died mid-send: the message row says what
      // happened. None = failed, never re-sent (at most once).
      const { data: prior, error: priorError } = await supabase
        .from("messages")
        .select("id, status")
        .eq("organization_id", orgId)
        .eq("scheduled_send_id", send.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priorError) throw new Error(`Could not check an interrupted send: ${priorError.message}`);
      const sentBefore = (prior as { status?: string } | null)?.status;
      if (sentBefore && sentBefore !== "failed") {
        await finish("sent", { message_id: (prior as { id: string }).id, error: null }, {
          type: "flow.sent",
          properties: { ...retakeProps, reason: "recovered_after_interrupt" },
        });
      } else {
        await finish(
          "failed",
          { message_id: (prior as { id?: string } | null)?.id ?? null, error: "The send was interrupted; not sent again." },
          { type: "flow.failed", properties: { ...retakeProps, reason: "send_interrupted" } },
        );
      }
      return;
    }

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
      condition: Record<string, unknown> | null;
      is_enabled: boolean;
    } | null;


    const baseProps = {
      flow_key: flow?.key ?? null,
      flow_id: send.flow_id,
      // Every flow event joins back to its row through this.
      scheduled_send_id: send.id,
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
      return;
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
      return;
    }

    // Step-level gates (cash-on-delivery only, still-unanswered) are
    // re-checked here too — the answer can arrive after scheduling.
    const gate = await flows.stepGateAllows(supabase, step.condition, {
      type: send.trigger_type,
      id: send.trigger_id,
    });
    if (!gate.allowed) {
      await finish("skipped", { cancel_reason: gate.reason ?? "step_condition" }, {
        type: "flow.skipped",
        properties: { ...baseProps, reason: gate.reason ?? "step_condition" },
      });
      return;
    }



    if (!send.contact_id) {
      await finish("skipped", { cancel_reason: "no_contact" }, {
        type: "flow.skipped",
        properties: { ...baseProps, reason: "no_contact" },
      });
      return;
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
      return;
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
      return;
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
      return;
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
        return;
      }
    }

    // "Send a form" steps: a WhatsApp form inside the 24-hour window.
    if ((step.condition ?? {})["step_type"] === "send_form") {
      const formId = String((step.condition ?? {})["form_id"] ?? "");
      const { data: convRow } = await supabase
        .from("conversations")
        .select("id")
        .eq("organization_id", orgId)
        .eq("contact_id", contact.id)
        .order("last_customer_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (!convRow) {
        await finish("skipped", { cancel_reason: "no_conversation" }, {
          type: "flow.skipped",
          properties: { ...baseProps, reason: "no_conversation" },
        });
        return;
      }
      const { sendFormMessage } = await import("@/lib/wa-forms.server");
      await markStarted();
      const sentForm = await sendFormMessage(supabase, {
        organizationId: orgId,
        conversationId: convRow.id as string,
        formId,
        source: "flow",
      });
      if (sentForm.ok) {
        await finish("sent", { message_id: sentForm.messageId }, {
          type: "flow.sent",
          properties: { ...baseProps, message_class: messageClass, kind: "form" },
        });
      } else {
        await finish("failed", { error: sentForm.error ?? "Form not sent." }, {
          type: "flow.failed",
          properties: { ...baseProps, reason: "form_send_failed", error_detail: sentForm.error },
        });
      }
      return;
    }

    if (!step.template_id) {
      await finish("failed", { error: "No template is configured for this step." }, {
        type: "flow.skipped",
        properties: { ...baseProps, reason: "no_template" },
      });
      return;
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
      return;
    }

    const sender = await loadSenderContext(supabase, orgId, flow.whatsapp_account_id);
    if (!sender) {
      await finish("failed", { error: "No connected number is available to send from." }, {
        type: "flow.skipped",
        properties: { ...baseProps, reason: "no_sender" },
      });
      return;
    }

    const linkTarget = await flows.flowLinkTarget(
      supabase,
      send.trigger_type,
      send.trigger_id,
    );

    const variables = await flows.resolveFlowVariables(
      supabase,
      send.trigger_type,
      send.trigger_id,
      contact,
    );

    // A carousel template shows the customer's actual items, one card
    // each. If we can't picture any of them, the template still sends
    // with whatever the template itself was built with.
    const { templateVariableSpec } = await import("@/lib/templates");
    const spec = templateVariableSpec((template.components ?? []) as never);
    const cards = spec.cards.length
      ? await flows.flowCarouselCards(
          supabase,
          orgId,
          send.trigger_type,
          send.trigger_id,
          spec.cards.length,
          linkTarget,
        )
      : [];

    await markStarted();
    const outcome = await sendCampaignTemplate(
      supabase,
      orgId,
      sender,
      { contactId: contact.id, phone: contact.phone, variables },
      {
        name: template.name,
        language: template.language || "en_US",
        variableOrder: extractVariables(templateBodyText((template.components ?? []) as never)),
        components: (template.components ?? []) as never,
      },
      {
        campaignId: null,
        category: String(template.category ?? "utility").toLowerCase(),
        flowId: send.flow_id,
        flowStepId: send.flow_step_id,
        scheduledSendId: send.id,
        linkTarget,
        ...(cards.length ? { cards } : {}),
      },


    );

    if (outcome.error) {
      await finish(
        "failed",
        { error: outcome.error, message_id: outcome.messageId },
        {
          type: "flow.failed",
          properties: { ...baseProps, reason: "send_failed", error: outcome.error },
        },
      );
      return;
    }

    // A branded card pinned to this step rides after the template —
    // only when the workspace has cards on, and never at the cost of
    // the text, which has already arrived.
    const cardCfg = (step.condition as Record<string, unknown> | null)?.["card"] as
      | { kind?: string; vars?: Record<string, string> }
      | undefined;
    if (cardCfg?.kind) {
      try {
        const cards = await import("@/lib/customer-cards.server");
        if (await cards.cardsEnabled(supabase, orgId)) {
          await cards.sendCardToContact(supabase, {
            organizationId: orgId,
            contactId: contact.id,
            phone: contact.phone,
            sender,
            kind: cardCfg.kind,
            vars: cards.fillCardVars(cardCfg.vars ?? {}, variables),
            caption: template.name,
          });
        }
      } catch {
        // card is decoration; the words already arrived
      }
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

    // A cash-on-delivery ask remembers which message asked, so the
    // customer's button reply can be matched back to the order.
    const { noteCodAsk } = await import("@/lib/cod.server");
    await noteCodAsk(supabase, {
      flowKey: flow.key,
      triggerType: send.trigger_type,
      triggerId: send.trigger_id,
      scheduledSendId: send.id,
      messageId: outcome.messageId ?? null,
    });

    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      console.error(JSON.stringify({
        scope: "flows",
        stage: "dispatch_exception",
        scheduled_send_id: send.id,
        organization_id: orgId,
        error,
      }));

      const { error: persistError } = await supabase
        .from("scheduled_sends")
        .update({ status: "failed", claimed_at: null, error: error.slice(0, 1000) })
        .eq("id", send.id);
      if (persistError) {
        console.error(JSON.stringify({
          scope: "flows",
          stage: "dispatch_exception_persist_failed",
          scheduled_send_id: send.id,
          error: persistError.message,
        }));
      } else {
        await emitEvent(supabase, "flow.failed", {
          organizationId: orgId,
          entityType: "scheduled_send",
          entityId: send.id,
          properties: {
            flow_id: send.flow_id,
            scheduled_send_id: send.id,
            contact_id: send.contact_id,
            trigger_type: send.trigger_type,
            trigger_id: send.trigger_id,
            reason: "dispatch_exception",
            error,
          },
        });
        outcomes.push({ id: send.id, status: "failed", error });
      }
    }
  }));

  const claimedIds = batch.map((send) => send.id);
  if (claimedIds.length > 0) {
    const { data: stranded, error: strandedQueryError } = await supabase
      .from("scheduled_sends")
      .select("id")
      .in("id", claimedIds)
      .eq("status", "scheduled")
      .not("claimed_at", "is", null);

    if (strandedQueryError) {
      console.warn(JSON.stringify({
        scope: "flows",
        stage: "stranded_check_failed",
        claimed: claimedIds.length,
        error: strandedQueryError.message,
      }));
    } else if ((stranded ?? []).length > 0) {
      const strandedIds = stranded.map((row) => row.id as string);
      console.warn(JSON.stringify({
        scope: "flows",
        stage: "tick_ended_with_claimed_rows",
        claimed: claimedIds.length,
        stranded: strandedIds,
      }));
      const error = "Dispatch tick ended before this claimed send reached an outcome.";
      const { error: terminalizeError } = await supabase
        .from("scheduled_sends")
        .update({ status: "failed", claimed_at: null, error })
        .in("id", strandedIds)
        .eq("status", "scheduled");
      if (terminalizeError) {
        console.error(JSON.stringify({
          scope: "flows",
          stage: "stranded_terminalize_failed",
          stranded: strandedIds,
          error: terminalizeError.message,
        }));
      } else {
        outcomes.push(...strandedIds.map((id) => ({ id, status: "failed", error })));
      }
    }
  }

  // Cash-on-delivery asks that got no answer within 24 hours.
  const { expireCodConfirmations } = await import("@/lib/cod.server");
  const codExpired = await expireCodConfirmations(supabase);

  // Flows v2 runs: due waits and reply timeouts. Isolated from the sends above.
  let flowRuns: Record<string, unknown> = {};
  try {
    const { tickRuns } = await import("@/lib/flow-engine.server");
    flowRuns = await tickRuns(supabase);
  } catch (error) {
    flowRuns = { error: error instanceof Error ? error.message : String(error) };
  }

  // Flows v2 "no reply for N days" triggers. Isolated too.
  let noReply: Record<string, unknown> = {};
  try {
    const { dispatchNoReply } = await import("@/lib/flow-triggers.server");
    noReply = await dispatchNoReply(supabase);
  } catch (error) {
    noReply = { error: error instanceof Error ? error.message : String(error) };
  }

  // Batch 16: one reminder for a chat still waiting on a person after
  // 30 minutes, inside business hours. Isolated; never clears needs_human.
  let handoffReminders: number | { error: string } = 0;
  try {
    const { remindWaitingHandoffs } = await import("@/lib/handoff-alerts.server");
    handoffReminders = await remindWaitingHandoffs(supabase);
  } catch (error) {
    handoffReminders = { error: error instanceof Error ? error.message : String(error) };
  }

  return {
    flow_runs: flowRuns,
    no_reply_triggers: noReply,
    handoff_reminders: handoffReminders,
    claimed: batch.length,
    outcomes,
    cod_expired: codExpired,
    commit: buildInfo().commit,
  };
}

type flowsFlow = {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  is_enabled: boolean;
  whatsapp_account_id: string | null;
  config: Record<string, unknown> | null;
};
