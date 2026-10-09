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
  conversationTurns,
  suggestReply,
  type AnswerReadsAhead,
} from "@/lib/ai-tasks.server";
import { isHandOffSignal, startAnswerLookups, type ChosenProduct, type PreludeRead } from "@/lib/ai-run.server";
import { enabledFlags } from "@/lib/ai-tools.server";
import { sendServiceText } from "@/lib/service-text.server";
import type { ReplyTimer } from "@/lib/reply-timing";
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
  /** WhatsApp reply-to: the id of our message the customer replied to, if any. */
  replyToMetaId?: string | null;
  /** The webhook's reply timer: Aiden's stages and sends land on webhook_events.timing. */
  timer?: ReplyTimer;
  /**
   * Called once an answer is certain to be sent (Replying mode, the run
   * produced something to send — Batch 28; never for drafts, Aiden off or
   * a run with nothing to say): the webhook marks the message read and
   * shows the typing dots. Never awaited.
   */
  onWillReply?: () => void;
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

/**
 * One Aiden switch: ai_agents.mode decides whether Aiden replies, and every
 * save of it sets organization_ai_settings.ai_enabled to match (on unless
 * mode is off). Called after each mode write.
 */
export async function syncAiSwitch(supabase: SupabaseClient, organizationId: string, mode: string): Promise<void> {
  const { error } = await supabase
    .from("organization_ai_settings")
    .upsert({ organization_id: organizationId, ai_enabled: mode !== "off" }, { onConflict: "organization_id" });
  if (error) console.error("[ai-agent] ai_enabled sync failed", organizationId, error.message);
}

/** The workspace's agent set-up, read once per inbound message. */
export type AgentPrep = {
  agentRow: { id?: string; mode?: string } | null;
  flags: Set<string>;
  aiEnabled: boolean | null;
  /** Everything the answer run reads before thinking; only when it will reply. */
  prelude: PreludeRead | null;
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
    // Batch 17: ai_agents.mode alone says whether Aiden replies (ai_enabled is kept equal on every save).
    const replying = row?.mode === "replying" && flags.has("ai_features");
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

/** M1: the live reply's first model call gives up after this long (elsewhere 120 s). */
export const LIVE_FIRST_CALL_TIMEOUT_MS = 20_000;

type HandToPersonArgs = Pick<
  AgentInboundArgs,
  "organizationId" | "conversationId" | "contactId" | "phoneNumberId" | "accessToken" | "waId" | "later" | "onWillReply"
>;

/**
 * Put the chat in front of a person: the workspace's hand-over line to the
 * customer (its own wording, else the configured default — never text
 * written here), "Waiting for you" (needs_human) with the staff alert, and
 * — when asked — the question filed under Unanswered. Used by a genuine
 * hand-off and, since Batch 27, by a run that errored or was capped.
 */
async function handToPerson(
  supabase: SupabaseClient,
  args: HandToPersonArgs,
  opts: {
    agentId: string | null;
    reason: string;
    status: string;
    signal: string | null;
    question: string;
    runId: string | null;
    fileGap: boolean;
    onSent?: () => void;
  },
): Promise<void> {
  const { defaultAgentId, handoverMessage } = await import("@/lib/ai-tasks.server");
  const agentId = opts.agentId ?? (await defaultAgentId(supabase, args.organizationId));
  const text = await handoverMessage(supabase, agentId);

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
    // The hand-over line is a reply: the dots go with it (Batch 28).
    try {
      args.onWillReply?.();
    } catch {
      // the dots are a courtesy
    }
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

  opts.onSent?.();
  log("held_back", {
    conversation_id: args.conversationId,
    status: opts.status,
    signal: opts.signal,
    handover: handoverState,
  });

  // Anything it wouldn't answer becomes a person's job: surface the thread.
  await supabase
    .from("conversations")
    .update({
      status: "open",
      needs_human: true,
      needs_human_reason: opts.reason,
      needs_human_question: opts.question.slice(0, 500),
      needs_human_at: new Date().toISOString(),
      handover_state: handoverState,
    })
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId);

  // Tell the staff (never the business's own number) and show the chat as
  // "Waiting for you". Bookkeeping the reply doesn't wait on.
  {
    const alert = import("@/lib/handoff-alerts.server")
      .then(({ sendHandoffAlert }) =>
        sendHandoffAlert(supabase, {
          organizationId: args.organizationId,
          conversationId: args.conversationId,
          reason: opts.reason,
          question: opts.question,
        }),
      )
      .catch(() => {});
    if (args.later) args.later(alert);
    else await alert;
  }

  // File it under Unanswered. The owner is never messaged about a customer
  // question: they answer it from the dashboard whenever they like.
  if (opts.fileGap) {
    const { recordCustomerGap } = await import("@/lib/owner-replies.server");
    const recorded = await recordCustomerGap(supabase, {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      question: opts.question,
      aiRunId: opts.runId,
    });
    log("gap_filed", { conversation_id: args.conversationId, recorded });
  }
}

/**
 * Batch 27 (H2): the webhook's answer pass threw while Aiden was answering.
 * When Aiden is replying on this chat, nobody else owns it, the window is
 * open and nothing went to the customer since their message, the chat is
 * handed to a person exactly like an errored run. Never throws.
 */
export async function stepBackAfterAgentFailure(
  supabase: SupabaseClient,
  args: HandToPersonArgs & { question: string | null; since: string },
): Promise<boolean> {
  try {
    const [prep, gate, replied] = await Promise.all([
      prepareAgentInbound(supabase, args.organizationId),
      readAgentGate(supabase, args.conversationId),
      Promise.resolve(
        supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", args.conversationId)
          .eq("direction", "outbound")
          .gte("created_at", args.since),
      ).then(({ count, error }) => (error ? 1 : (count ?? 0))),
    ]);
    if (prep.agentRow?.mode !== "replying" || !prep.flags.has("ai_features") || prep.aiEnabled === false) return false;
    if (gate?.assigned_to || gate?.needs_human === true || !isServiceWindowOpen(gate)) return false;
    if (replied > 0) return false;
    await handToPerson(supabase, args, {
      agentId: prep.agentRow?.id ?? null,
      reason: "ai_error",
      status: "error",
      signal: null,
      question: (args.question ?? "").trim(),
      runId: null,
      fileGap: Boolean((args.question ?? "").trim()),
    });
    return true;
  } catch (error) {
    console.error("[ai-agent] step_back_failed", error instanceof Error ? error.message : String(error));
    return false;
  }
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
  // The webhook's timer sees Aiden's stages too; its first send is
  // "ai_first_send" (a flow's is "send_start").
  const timer: ReplyTimer | undefined = args.timer
    ? { mark: (s) => args.timer!.mark(s === "send_start" ? "ai_first_send" : s), span: (n, ms) => args.timer!.span(n, ms) }
    : undefined;
  const prep = await (args.prepared ?? prepareAgentInbound(supabase, args.organizationId));
  const agentRow = prep.agentRow;
  const mode = agentRow?.mode ?? "off";
  if (mode !== "draft" && mode !== "replying") return { acted: false, reason: "mode_off" };

  const flags = prep.flags;
  if (!flags.has("ai_features")) return { acted: false, reason: "feature_off" };

  if (prep.aiEnabled === false) {
    // Every save keeps ai_enabled equal to mode (syncAiSwitch); a row edited
    // by hand that still disagrees is logged and nothing is sent.
    console.warn(JSON.stringify({ scope: "ai_switch_mismatch", organization_id: args.organizationId, mode }));
    return { acted: false, reason: "ai_disabled" };
  }

  // A live reply's chat read (a plain read: sends nothing, writes nothing,
  // calls no one) starts now, alongside the gate read; it is only used once
  // the gate below has passed.
  const chat = mode === "replying" && prep.prelude
    ? conversationTurns(supabase, args.organizationId, args.conversationId)
    : null;
  chat?.catch(() => {});

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
  timer?.mark("ai_gates");

  // The Cards page switch, read once and only when a picture goes out (or is
  // about to: the first card is drawn while the model writes its closing words).
  let cardsOn: Promise<boolean> | null = null;
  let cardTried = false;
  const cards = () =>
    (cardsOn ??= import("@/lib/customer-cards.server").then(({ productCardsOn }) =>
      productCardsOn(supabase, args.organizationId, flags),
    ));
  let prewarmed = false;
  const prewarmCard = (items: ChosenProduct[]) => {
    const first = items.find((p) => p.hasPhoto);
    // A product that will go as a WhatsApp catalogue card needs no picture card.
    if (prewarmed || !first || !flags.has("cards") || (flags.has("whatsapp_catalog") && first.inCatalog)) return;
    // Batch 28: the drawing writes a stored file and a usage row, so it is
    // handed to the webhook's later() (awaited before the event closes); with
    // no later() there is no request to keep it alive, and the card is simply
    // drawn when it is sent.
    if (!args.later) return;
    prewarmed = true;
    const drawing = cards()
      .then(async (on) => {
        if (!on) return;
        const [{ renderCustomerCard }, { productCardVars }] = await Promise.all([
          import("@/lib/customer-cards.server"),
          import("@/lib/product-pictures.server"),
        ]);
        await renderCustomerCard(supabase, { organizationId: args.organizationId, kind: "customer_product", vars: productCardVars(first) });
      })
      .catch(() => {});
    args.later(drawing);
  };

  if (mode === "draft") {
    const run = await suggestReply(supabase, common, args.conversationId);
    log("drafted", { conversation_id: args.conversationId, status: run.status });
    return { acted: true, mode: "draft", runId: run.runId, status: run.status };
  }

  // The gate passed: the business's material for this question and the
  // early catalogue search (the customer's own words) start now, together,
  // alongside the chat, brief and prelude reads — not one after another.
  const lookups = prep.prelude
    ? startAnswerLookups(supabase, {
        organizationId: args.organizationId,
        agentId: agentRow?.id ?? null,
        input: question,
        prelude: prep.prelude,
        conversationId: args.conversationId,
        contactId: args.contactId,
        knowledge: true,
        early: true,
      })
    : null;

  let run: Awaited<ReturnType<typeof agentAnswer>>;
  try {
    run = await agentAnswer(
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
            ...(chat ? { chat } : {}),
            ...(lookups ? { lookups } : {}),
          }
        : undefined,
      {
        ...(args.replyToMetaId ? { replyToMetaId: args.replyToMetaId } : {}),
        onProductsQueued: prewarmCard,
        // M1: a hung first model call fails over to the backup while the
        // webhook's background work (~30 s) is still alive.
        firstCallTimeoutMs: LIVE_FIRST_CALL_TIMEOUT_MS,
      },
    );
  } catch (error) {
    // Batch 27 (H2): the run threw before anything was sent — never silence.
    log("run_failed", { conversation_id: args.conversationId, error: error instanceof Error ? error.message : String(error) });
    await handToPerson(supabase, args, {
      agentId: agentRow?.id ?? null,
      reason: "ai_error",
      status: "error",
      signal: null,
      question,
      runId: null,
      fileGap: true,
    });
    return { acted: true, mode: "replying", runId: null, status: "error", sent: false };
  }
  mark("answer");
  timer?.mark("ai_run");
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
  // Pictures the model sent are an answer even without words.
  const shouldSend =
    run.status === "ok" && (answer.length > 0 || Boolean(run.parts?.some((p) => p.kind === "products")));
  // Batch 28: read receipt + typing dots only once an answer is certain to
  // go. They used to start before the model ran, so a run with nothing to
  // send (a stale button, a refusal) left the customer watching "typing…"
  // and then nothing.
  if (shouldSend) {
    try {
      args.onWillReply?.();
    } catch {
      // the dots are a courtesy
    }
  }

  // Batch 27 (H2): a run that broke (error) or hit a spending limit
  // (capped) has nothing to say, and the customer would hear nothing. It is
  // a person's job now: filed under Unanswered, "Waiting for you" with the
  // staff alert, and the same hand-over line a hand-off sends.
  if (!shouldSend && (run.status === "error" || run.status === "capped")) {
    mark("held_back");
    timing();
    await handToPerson(supabase, args, {
      agentId: (agentRow as { id?: string } | null)?.id ?? null,
      reason: run.status === "capped" ? "ai_capped" : "ai_error",
      status: run.status,
      signal: null,
      question,
      runId: run.runId,
      fileGap: true,
    });
    return { acted: true, mode: "replying", runId: run.runId, status: run.status, sent: false };
  }

  // Not knowing never hands a chat over (Batch 16): a run that produced
  // nothing to send without a hand-off signal (nothing to say, a refusal) is
  // filed for the merchant and Aiden stays on for the next message. Only a
  // customer asking for a person, the merchant's own rule or a sensitive
  // topic (isHandOffSignal) — or a flow's Assign step — puts a person on it.
  if (!shouldSend && !(run.status === "escalated" && isHandOffSignal(run.escalationSignal))) {
    mark("held_back");
    timing();
    log("not_sent_kept_on", { conversation_id: args.conversationId, status: run.status, signal: run.escalationSignal ?? null });
    if (run.status === "refused" || run.status === "escalated" || run.needsOwner) {
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

  if (!shouldSend) {
    // The customer asked for a person (or the merchant's rule says so): say
    // a person is coming, then put the thread in front of one.
    await handToPerson(supabase, args, {
      agentId: (agentRow as { id?: string } | null)?.id ?? null,
      reason: run.escalationSignal ?? run.status,
      status: run.status,
      signal: run.escalationSignal ?? null,
      question,
      runId: run.runId,
      fileGap: Boolean(run.needsOwner),
      onSent: () => {
        mark("handover_sent");
        timing();
      },
    });
    return { acted: true, mode: "replying", runId: run.runId, status: run.status, sent: false };
  }

  // What the customer gets is exactly what the model wrote, in its order:
  // its words, and the products it sent (send_products) where it put them.
  // Code adds nothing to it.
  const windowOpen = isServiceWindowOpen(convo);
  const sender = {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.waId,
  };
  let anySent = false;
  let sendError: string | null = null;
  let picturesSent = 0;
  const sendText = async (body: string, metadata?: Record<string, unknown>): Promise<boolean> => {
    const res = await sendServiceText(supabase, {
      ...sender,
      body,
      // The window was checked on the gate read above, in this same request.
      windowOpen,
      ...(metadata ? { metadata } : {}),
      ...(timer ? { timer } : {}),
    });
    if (res.ok) anySent = true;
    else sendError ??= res.error ?? "send_failed";
    return res.ok;
  };

  /** One products part: catalogue cards when the shop is on, else each product as the model captioned it. */
  const sendProducts = async (items: ChosenProduct[]): Promise<void> => {
    if (flags.has("whatsapp_catalog")) {
      const { sendCatalogProducts } = await import("@/lib/whatsapp-catalog.server");
      const result = await sendCatalogProducts(supabase, {
        ...sender,
        items: items.map((p) => ({ retailerId: p.retailerId, title: p.title, category: p.category, inCatalog: p.inCatalog })),
      });
      if (result.error) log("catalog_send_failed", { conversation_id: args.conversationId, error: result.error });
      if (result.sent > 0) {
        anySent = true;
        picturesSent += result.sent;
        return;
      }
    }
    const { sendProductPictures } = await import("@/lib/product-pictures.server");
    // With branded cards on, the first product with a photo goes as the card.
    const cardItem = items.find((p) => p.hasPhoto) ?? null;
    const withCard = Boolean(cardItem) && !cardTried && (await cards());
    cardTried ||= withCard;
    const sendOne = async (item: ChosenProduct): Promise<void> => {
      const metadata = { kind: "ai_product", product_id: item.productId };
      // No photo: its caption as a text message.
      if (!item.hasPhoto) {
        if (item.caption.trim()) await sendText(item.caption, metadata);
        return;
      }
      const shown = await sendProductPictures(supabase, {
        ...sender,
        contactId: args.contactId,
        windowOpen,
        ...(timer ? { timer } : {}),
        items: [{ ...item, metadata }],
        cards: withCard && item === cardItem,
        ...(args.later ? { background: args.later } : {}),
        onFailure: (error) => log("picture_failed", { conversation_id: args.conversationId, error }),
      });
      if (shown > 0) {
        anySent = true;
        timer?.mark("ai_first_photo");
      }
      picturesSent += shown;
    };
    // The first product goes at once; the rest go together, not one after
    // another (WhatsApp keeps no order between separate sends, so only the
    // first is guaranteed to arrive first). The words after them wait for all.
    const [first, ...rest] = items;
    if (first) await sendOne(first);
    await Promise.all(rest.map(sendOne));
  };

  if (run.parts && run.parts.length > 0) {
    for (const part of run.parts) {
      if (part.kind === "text") {
        // A text that can't go out (the window closed) stops the rest.
        if (!(await sendText(part.text))) break;
      } else {
        await sendProducts(part.items);
      }
    }
  } else {
    await sendText(answer);
  }
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

  // No send_products tool in this workspace (no catalogue): the answer's
  // products still travel as pictures after the words, as before — with
  // nothing added to the words.
  const legacyPictures = run.parts ? [] : run.media.slice(0, 3);
  let catalogSent = 0;
  if (anySent && legacyPictures.length > 0 && flags.has("whatsapp_catalog")) {
    const { sendCatalogProducts } = await import("@/lib/whatsapp-catalog.server");
    const result = await sendCatalogProducts(supabase, {
      ...sender,
      items: legacyPictures.map((p) => ({
        retailerId: p.retailerId,
        title: p.title,
        category: p.category,
        inCatalog: p.inCatalog,
      })),
    });
    if (result.sent > 0) catalogSent = result.sent;
    if (result.error) log("catalog_send_failed", { conversation_id: args.conversationId, error: result.error });
  }
  if (anySent && catalogSent === 0 && legacyPictures.length > 0) {
    const { sendProductPictures } = await import("@/lib/product-pictures.server");
    picturesSent += await sendProductPictures(supabase, {
      ...sender,
      contactId: args.contactId,
      items: legacyPictures,
      cards: await cards(),
      onFailure: (error) => log("picture_failed", { conversation_id: args.conversationId, error }),
    });
  }
  const sent = { ok: anySent, error: anySent ? null : sendError };

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
