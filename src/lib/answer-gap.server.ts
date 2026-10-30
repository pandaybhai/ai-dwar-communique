import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 54: answering one of Aiden's open questions (pending_owner_replies)
 * with the owner's own words — teach (saveCorrection), deliver to the
 * customer while the question is still pending and their chat is open
 * (deliverToCustomer), mark it answered, log it. Moved verbatim from
 * /api/ai/knowledge's answer_gap so the app and AiDwar MCP share one path;
 * the route's answers are unchanged. The caller checks ai.use and
 * ai.configure first (as the route does).
 */

export type AnswerGapResult =
  | { ok: true; delivered: boolean }
  | { ok: false; status: number; error: string };

export type PendingOwnerReply = {
  id: string;
  organization_id: string;
  owner_phone: string;
  conversation_id: string | null;
  contact_id: string | null;
  question: string;
  source: string;
  status: string;
  selected_at: string | null;
  created_at: string;
  reminded_at: string | null;
};

export async function readPendingOwnerReply(
  supabase: SupabaseClient,
  organizationId: string,
  replyId: string,
): Promise<PendingOwnerReply | null> {
  const { data: row } = await supabase
    .from("pending_owner_replies")
    .select("id, organization_id, owner_phone, conversation_id, contact_id, question, source, status, selected_at, created_at, reminded_at")
    .eq("id", replyId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (row as PendingOwnerReply | null) ?? null;
}

export async function answerGap(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    replyId: string;
    /** The owner's own words, as they wrote them. */
    answer: unknown;
    /** Batch 51: "approve" / "decline" from a "Needs you" item. */
    decision?: unknown;
    /** Extra details on the ai_answer_corrected entry (AiDwar MCP: source "mcp"). */
    activityDetails?: Record<string, unknown>;
  },
): Promise<AnswerGapResult> {
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  const knowledge = await import("@/lib/knowledge.server");

  const pending = await readPendingOwnerReply(supabase, input.organizationId, input.replyId);
  if (!pending) return { ok: false, status: 403, error: "That question isn't in this workspace." };

  const answer = String(input.answer ?? "").trim();
  if (!answer) return { ok: false, status: 400, error: "Write the answer first." };
  // Answers typed on the dashboard always count as answers.

  await knowledge.saveCorrection(supabase, input.organizationId, {
    question: pending.question,
    answer,
    userId: input.userId,
  });

  let delivered = false;
  if (pending.status === "pending" && pending.conversation_id) {
    try {
      const { deliverToCustomer } = await import("@/lib/owner-replies.server");
      delivered = await deliverToCustomer(supabase, pending, answer);
    } catch (sendError) {
      console.error(
        "[ai-knowledge] gap delivery failed",
        sendError instanceof Error ? sendError.message : sendError,
      );
    }
  }

  await supabase
    .from("pending_owner_replies")
    .update({
      status: "answered",
      answer,
      answered_at: new Date().toISOString(),
      selected_at: new Date().toISOString(),
    })
    .eq("id", pending.id)
    .eq("organization_id", input.organizationId);

  // Batch 51: an Approve / Decline from a "Needs you" item is the same
  // answer (the owner's own words); the log says which they chose.
  const decision = String(input.decision ?? "");
  await logServerActivity(
    supabase,
    input.organizationId,
    input.userId,
    "ai_answer_corrected",
    {
      ...(decision === "approve" || decision === "decline"
        ? { from: "needs_you", decision, conversation_id: pending.conversation_id }
        : { from: "unanswered" }),
      ...(input.activityDetails ?? {}),
    },
  );

  return { ok: true, delivered };
}
