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
import {
  agentAnswer,
  agentAnswerPrelude,
  answerReadsAhead,
  suggestReply,
  type AnswerReadsAhead,
} from "@/lib/ai-tasks.server";
import type { RunPrelude } from "@/lib/ai-run.server";
import { enabledFlags } from "@/lib/ai-tools.server";
import { sendServiceText } from "@/lib/service-text.server";
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
  /** prepareAgentInbound(), started by the webhook before the burst wait. */
  prepared?: Promise<AgentPrep>;
  /** Bookkeeping the reply doesn't wait on; the webhook awaits it before marking the event processed. */
  later?: (work: Promise<unknown>) => void;
  /** readAgentGate(), started by the webhook the moment the burst wait ended. */
  gate?: Promise<AgentGate>;
};

type AgentGate = {
  assigned_to?: string | null;
  needs_human?: boolean | null;
  last_customer_message_at?: string | null;
} | null;

/**
 * Who owns the thread and whether WhatsApp lets us answer — always read
 * after the burst wait (a teammate may have just taken over).
 */
export function readAgentGate(supabase: SupabaseClient, conversationId: string): Promise<AgentGate> {
  const read = Promise.resolve(
    supabase
      .from("conversations")
      .select("assigned_to, needs_human, handover_state, last_customer_message_at, status")
      .eq("id", conversationId)
      .maybeSingle(),
  ).then(({ data }) => (data ?? null) as AgentGate);
  read.catch(() => {});
  return read;
}

/** The workspace's agent set-up, read once per inbound message. */
export type AgentPrep = {
  agentRow: { id?: string; mode?: string } | null;
  flags: Set<string>;
  aiEnabled: boolean | null;
  /** Everything the answer run reads before thinking; only when it will reply. */
  prelude: Promise<RunPrelude> | null;
  /** The answer's earlier-failures and brief reads; only when it will reply. */
  ahead?: AnswerReadsAhead | null;
};

/**
 * The agent's set-up (mode, flags, AI switch) read together, and — when it is
 * going to reply — the answer run's own reads started straight away. The
 * webhook starts this before it waits out a message burst, so none of it
 * waits on the timer. Read-only: every check still happens in
 * runAgentOnInbound, in the same order, after the burst.
 */
export function prepareAgentInbound(
  supabase: SupabaseClient,
  organizationId: string,
  /** When given, the answer's chat-independent reads start too (they finish during the burst wait). */
  conversationId?: string,
): Promise<AgentPrep> {
  const prep = Promise.all([
    supabase.from("ai_agents").select("id, mode").eq("organization_id", organizationId).eq("is_default", true).maybeSingle(),
    enabledFlags(supabase, organizationId),
    supabase.from("organization_ai_settings").select("ai_enabled").eq("organization_id", organizationId).maybeSingle(),
  ]).then(([{ data: agentRow }, flags, { data: settings }]) => {
    const row = (agentRow ?? null) as { id?: string; mode?: string } | null;
    const aiEnabled = (settings as { ai_enabled?: boolean } | null)?.ai_enabled ?? null;
    const replying = row?.mode === "replying" && flags.has("ai_features") && aiEnabled !== false;
    return {
      agentRow: row,
      flags,
      aiEnabled,
      prelude: replying ? agentAnswerPrelude(supabase, organizationId, row?.id ?? null) : null,
      ahead:
        replying && conversationId
          ? answerReadsAhead(supabase, organizationId, conversationId, Promise.resolve(row?.id ?? null))
          : null,
    };
  });
  prep.catch(() => {});
  return prep;
}

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

  const started = Date.now();
  const stages: Record<string, number> = {};
  const mark = (stage: string) => {
    stages[stage] = Date.now() - started;
  };
  const prep = await (args.prepared ?? prepareAgentInbound(supabase, args.organizationId));
  const agentRow = prep.agentRow;
  const mode = agentRow?.mode ?? "off";
  if (mode !== "draft" && mode !== "replying") return { acted: false, reason: "mode_off" };

  const flags = prep.flags;
  if (!flags.has("ai_features")) return { acted: false, reason: "feature_off" };

  if (prep.aiEnabled === false) {
    return { acted: false, reason: "ai_disabled" };
  }

  // Read fresh, after the burst wait: a teammate may have just taken over.
  const convo = await (args.gate ?? readAgentGate(supabase, args.conversationId));
  mark("gates");

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

  const run = await agentAnswer(
    supabase,
    common,
    args.conversationId,
    question,
    prep.prelude
      ? {
          agentId: agentRow?.id ?? null,
          prelude: prep.prelude,
          ...(args.later ? { deferUsage: args.later } : {}),
          ...(prep.ahead ? { ahead: prep.ahead } : {}),
        }
      : undefined,
  );
  mark("answer");
  const timing = () =>
    console.log(
      JSON.stringify({
        scope: "ai_timing",
        conversation_id: args.conversationId,
        run_id: run.runId,
        run_latency_ms: run.latencyMs,
        stages,
      }),
    );
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

    mark("handover_sent");
    timing();
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

    // File it under Unanswered. The owner is never messaged about a customer
    // question: they answer it from the dashboard whenever they like.
    if (needsOwner || run.needsOwner) {
      const { recordCustomerGap } = await import("@/lib/owner-replies.server");
      const recorded = await recordCustomerGap(supabase, {
        organizationId: args.organizationId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        question,
        aiRunId: run.runId,
      });
      log("gap_filed", { conversation_id: args.conversationId, recorded });
    }

    return { acted: true, mode: "replying", runId: run.runId, status: run.status, sent: false };
  }

  // A discovery answer ends with an easy way to keep looking.
  const pictures = run.media.slice(0, 3);
  const body =
    pictures.length > 0 && !/different budget or style/i.test(answer)
      ? `${answer}\n\nWant a different budget or style?`
      : answer;

  const sent = await sendServiceText(supabase, {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.waId,
    body,
    // The window was checked on the gate read above, in this same request.
    windowOpen: isServiceWindowOpen(convo),
  });
  mark("sent");
  timing();

  // The customer got a helpful reply; part of it needed the business's own
  // facts. That question waits under Unanswered — the owner is not messaged.
  if (run.needsOwner) {
    const { recordCustomerGap } = await import("@/lib/owner-replies.server");
    const recorded = await recordCustomerGap(supabase, {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      question,
      aiRunId: run.runId,
    });
    log("gap_filed", { conversation_id: args.conversationId, recorded });
  }

  // Products that live in the number's WhatsApp catalogue go out as real
  // catalogue cards the customer can add to a cart; everything else still
  // travels as pictures.
  let catalogSent = 0;
  if (sent.ok && pictures.length > 0 && flags.has("whatsapp_catalog")) {
    const { sendCatalogProducts } = await import("@/lib/whatsapp-catalog.server");
    const result = await sendCatalogProducts(supabase, {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      phoneNumberId: args.phoneNumberId,
      accessToken: args.accessToken,
      to: args.waId,
      items: pictures.map((p) => ({
        retailerId: p.retailerId,
        title: p.title,
        category: p.category,
        inCatalog: p.inCatalog,
      })),
    });
    if (result.sent > 0) catalogSent = result.sent;
    if (result.error) log("catalog_send_failed", { conversation_id: args.conversationId, error: result.error });
  }

  // Catalogue answers travel with pictures: one image per product named,
  // sent after the text so the words arrive first.
  let picturesSent = 0;
  if (sent.ok && catalogSent === 0 && pictures.length > 0) {
    const { sendProductPictures } = await import("@/lib/product-pictures.server");
    // The Cards page switch; without the cards flag nothing extra is read.
    const { productCardsOn } = await import("@/lib/customer-cards.server");
    const cards = await productCardsOn(supabase, args.organizationId, flags);
    picturesSent = await sendProductPictures(supabase, {
      organizationId: args.organizationId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      to: args.waId,
      phoneNumberId: args.phoneNumberId,
      accessToken: args.accessToken,
      items: pictures,
      cards,
      onFailure: (error) => log("picture_failed", { conversation_id: args.conversationId, error }),
    });
  }

  // The model chose a published form: it goes out after the words, once.
  if (sent.ok && flags.has("wa_forms")) {
    const pick = run.toolCalls.find(
      (c) => c.tool === "send_form" && c.ok && typeof c.args?.["form_id"] === "string",
    );
    if (pick) {
      const { sendFormMessage } = await import("@/lib/wa-forms.server");
      const formSent = await sendFormMessage(supabase, {
        organizationId: args.organizationId,
        conversationId: args.conversationId,
        formId: String(pick.args!["form_id"]),
        source: "ai",
      });
      if (!formSent.ok) log("form_send_failed", { conversation_id: args.conversationId, error: formSent.error });
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
