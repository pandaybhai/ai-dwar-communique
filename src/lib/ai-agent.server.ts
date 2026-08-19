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
    log("held_back", {
      conversation_id: args.conversationId,
      status: run.status,
      signal: run.escalationSignal,
    });
    // Anything it wouldn't answer becomes a person's job: surface the thread.
    await supabase
      .from("conversations")
      .update({ status: "open" })
      .eq("id", args.conversationId)
      .eq("organization_id", args.organizationId);
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

  return {
    acted: true,
    mode: "replying",
    runId: run.runId,
    status: run.status,
    sent: sent.ok,
  };
}
