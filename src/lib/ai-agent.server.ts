/**
 * The AI employee acting on a real inbound customer message.
 *
 * Called from the webhook, once per genuinely new inbound text, after
 * opt-out keywords, cash-on-delivery answers and automations have had their
 * turn. Three modes:
 *
 *   off       -> nothing at all
 *   draft     -> writes a reply for a teammate to read (nothing is sent)
 *   replying  -> answers the customer directly, unless it decided to pass
 *                the conversation to a person
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { agentAnswer, suggestReply } from "@/lib/ai-tasks.server";
import { enabledFlags } from "@/lib/ai-tools.server";
import { sendServiceImage, sendServiceText } from "@/lib/service-text.server";
import { isServiceWindowOpen } from "@/lib/service-window";

export type AgentInboundArgs = {
  organizationId: string;
  conversationId: string;
  contactId: string;
  phoneNumberId: string;
  accessToken: string;
  waId: string;
  body: string | null;
  /** True when something else already answered this message. */
  alreadyHandled: boolean;
  optedOut: boolean;
};

export type AgentInboundOutcome =
  | { acted: false; reason: string }
  | { acted: true; mode: "draft"; runId: string | null; status: string }
  | { acted: true; mode: "replying"; runId: string | null; status: string; sent: boolean };

function log(outcome: string, detail: Record<string, unknown>) {
  console.log("[ai-agent]", outcome, JSON.stringify(detail));
}

export async function runAgentOnInbound(
  supabase: SupabaseClient,
  args: AgentInboundArgs,
): Promise<AgentInboundOutcome> {
  const question = (args.body ?? "").trim();
  if (!question) return { acted: false, reason: "no_text" };
  if (args.alreadyHandled) return { acted: false, reason: "already_handled" };
  if (args.optedOut) return { acted: false, reason: "contact_opted_out" };

  const { data: agentRow } = await supabase
    .from("ai_agents")
    .select("id, mode")
    .eq("organization_id", args.organizationId)
    .eq("is_default", true)
    .maybeSingle();
  const mode = (agentRow as { mode?: string } | null)?.mode ?? "off";
  if (mode !== "draft" && mode !== "replying") return { acted: false, reason: "mode_off" };

  const flags = await enabledFlags(supabase, args.organizationId);
  if (!flags.has("ai_features")) return { acted: false, reason: "feature_off" };

  const { data: settings } = await supabase
    .from("organization_ai_settings")
    .select("ai_enabled")
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if ((settings as { ai_enabled?: boolean } | null)?.ai_enabled === false) {
    return { acted: false, reason: "ai_disabled" };
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("assigned_to, needs_human, handover_state, last_customer_message_at, status")
    .eq("id", args.conversationId)
    .maybeSingle();
  const convo = (conversation ?? null) as {
    assigned_to?: string | null;
    needs_human?: boolean | null;
    last_customer_message_at?: string | null;
  } | null;

  // A thread a person owns, or one already waiting on a person, is theirs.
  // And we never pay for an answer WhatsApp wouldn't let us send.
  if (mode === "replying") {
    if (convo?.assigned_to) {
      log("skipped", { conversation_id: args.conversationId, reason: "assigned_to_human" });
      return { acted: false, reason: "assigned_to_human" };
    }
    if (convo?.needs_human === true) {
      log("skipped", { conversation_id: args.conversationId, reason: "awaiting_human" });
      return { acted: false, reason: "awaiting_human" };
    }
    if (!isServiceWindowOpen(convo)) {
      log("skipped", { conversation_id: args.conversationId, reason: "window_closed" });
      return { acted: false, reason: "window_closed" };
    }
  }

  const common = { organizationId: args.organizationId, actorUserId: null, actingRole: null };

  if (mode === "draft") {
    const run = await suggestReply(supabase, common, args.conversationId);
    log("drafted", { conversation_id: args.conversationId, status: run.status });
    return { acted: true, mode: "draft", runId: run.runId, status: run.status };
  }

  const run = await agentAnswer(supabase, common, args.conversationId, question);
  const answer = run.output.trim();
  const shouldSend = run.status === "ok" && answer.length > 0;

  if (!shouldSend) {
    // The customer must never be left in silence. Say a person is coming,
    // then put the thread in front of one.
    const { defaultAgentId, handoverMessage, DEFAULT_HANDOVER_MESSAGE } = await import(
      "@/lib/ai-tasks.server"
    );
    const { isServiceWindowOpen } = await import("@/lib/service-window");
    const agentId = (agentRow as { id?: string } | null)?.id
      ?? (await defaultAgentId(supabase, args.organizationId));
    const configured = await handoverMessage(supabase, agentId);
    // A missing number or a missing source is a "let me check", not a
    // "let me help": the owner is about to be asked for the real answer.
    const needsOwner =
      run.escalationSignal === "unsupported_number" || run.escalationSignal === "no_source";
    const text =
      needsOwner && configured === DEFAULT_HANDOVER_MESSAGE
        ? "Let me get someone from the team to confirm that — they'll reply here shortly."
        : configured;

    const { data: convo } = await supabase
      .from("conversations")
      .select("last_customer_message_at")
      .eq("id", args.conversationId)
      .maybeSingle();

    let handoverState: "sent" | "window_closed" | "failed" | "not_configured" = "not_configured";
    if (!text.trim()) {
      handoverState = "not_configured";
    } else if (!isServiceWindowOpen(convo as { last_customer_message_at?: string | null } | null)) {
      handoverState = "window_closed";
    } else {
      const handover = await sendServiceText(supabase, {
        organizationId: args.organizationId,
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        conversationId: args.conversationId,
        to: args.waId,
        body: text,
      });
      handoverState = handover.ok ? "sent" : "failed";
      if (!handover.ok) {
        log("handover_send_failed", {
          conversation_id: args.conversationId,
          error: handover.error,
        });
      }
    }

    log("held_back", {
      conversation_id: args.conversationId,
      status: run.status,
      signal: run.escalationSignal,
      handover: handoverState,
    });

    // Anything it wouldn't answer becomes a person's job: surface the thread.
    await supabase
      .from("conversations")
      .update({
        status: "open",
        needs_human: true,
        needs_human_reason: run.escalationSignal ?? run.status,
        needs_human_question: question.slice(0, 500),
        needs_human_at: new Date().toISOString(),
        handover_state: handoverState,
      })
      .eq("id", args.conversationId)
      .eq("organization_id", args.organizationId);

    // Ask the owner on the AiDwar number. Their reply answers this customer
    // and is remembered, so the same question is never handed over twice.
    if (needsOwner) {
      const { pingOwnerForAnswer } = await import("@/lib/owner-replies.server");
      const ping = await pingOwnerForAnswer(supabase, {
        organizationId: args.organizationId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        question,
        aiRunId: run.runId,
      });
      log("owner_pinged", {
        conversation_id: args.conversationId,
        recorded: ping.recorded,
        sent: ping.sent,
      });
    }

    return { acted: true, mode: "replying", runId: run.runId, status: run.status, sent: false };
  }

  const sent = await sendServiceText(supabase, {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.waId,
    body: answer,
  });

  // Catalogue answers travel with pictures: one image per product named,
  // sent after the text so the words arrive first.
  let picturesSent = 0;
  const cardsOn = flags.has("cards");
  let cardSent = false;
  if (sent.ok && run.media.length > 0) {
    for (const item of run.media) {
      const price =
        item.price === null
          ? ""
          : ` — ${new Intl.NumberFormat("en-IN", {
              style: "currency",
              currency: item.currency || "INR",
              maximumFractionDigits: 0,
            }).format(item.price)}`;
      // Cards on? The first product's picture goes out as a branded card;
      // any failure falls back to the bare image below.
      if (cardsOn && !cardSent) {
        try {
          const { sendCardToContact } = await import("@/lib/customer-cards.server");
          const card = await sendCardToContact(supabase, {
            organizationId: args.organizationId,
            contactId: args.contactId,
            phone: args.waId,
            sender: { phoneNumberId: args.phoneNumberId, accessToken: args.accessToken },
            kind: "customer_product",
            vars: {
              name: item.title,
              price: price.replace(/^ — /, ""),
              image_url: item.imageUrl,
              one_liner: "",
            },
            caption: `${item.title}${price}`,
          });
          if (card.sent) {
            cardSent = true;
            picturesSent += 1;
            continue;
          }
        } catch {
          // fall through to the plain picture
        }
      }
      const picture = await sendServiceImage(supabase, {
        organizationId: args.organizationId,
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        conversationId: args.conversationId,
        to: args.waId,
        imageUrl: item.imageUrl,
        caption: `${item.title}${price}`,
      });
      if (picture.ok) picturesSent += 1;
      else log("picture_failed", { conversation_id: args.conversationId, error: picture.error });
    }
  }

  log(sent.ok ? "replied" : "send_failed", {
    pictures: picturesSent,
    conversation_id: args.conversationId,
    run_id: run.runId,
    error: sent.error,
  });

  if (sent.ok) {
    // Answered cleanly: this thread no longer needs a person.
    await supabase
      .from("conversations")
      .update({ needs_human: false, needs_human_reason: null, handover_state: null })
      .eq("id", args.conversationId)
      .eq("organization_id", args.organizationId);
  }

  return {
    acted: true,
    mode: "replying",
    runId: run.runId,
    status: run.status,
    sent: sent.ok,
  };
}
