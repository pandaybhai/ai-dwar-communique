import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { gapsChanged } from "@/hooks/use-pending-gaps";
import { aidwar } from "@/integrations/aidwar/client";
import { knowledgeApi } from "@/lib/employee-client";
import { cn } from "@/lib/utils";

/**
 * Batch 51: Approve / Decline on a "Needs you" item (Home's card, the Inbox's
 * gold note, the chat header). There is no new answer path: the owner writes
 * the customer's reply in their own words and it goes through the Unanswered
 * list's own request (/api/ai/knowledge "answer_gap": saved as a correction,
 * sent word for word while the 24-hour window is open, needs_human cleared,
 * logged). Nothing here writes a word of the customer's reply. Only a chat
 * whose question Aiden filed under Unanswered has an item to decide on.
 */

export type Decision = "approve" | "decline";

/** The open Unanswered item for this chat: a customer's question still pending. */
export type OpenGap = { id: string; question: string };

/** Who may decide: someone who can reply in the chat and teach Aiden (answer_gap's own check). */
export function canDecide(can: (key: string) => boolean): boolean {
  return can("inbox.reply") && can("ai.configure");
}

/**
 * The answer_gap request for a decision, exactly the Unanswered list's body
 * plus which button was pressed (for the activity log). The answer is the
 * owner's words as typed, trimmed — never anything else.
 */
export function decisionRequest(args: {
  organizationId: string;
  replyId: string;
  answer: string;
  decision: Decision;
}): Record<string, unknown> {
  return {
    organization_id: args.organizationId,
    action: "answer_gap",
    reply_id: args.replyId,
    answer: args.answer.trim(),
    decision: args.decision,
  };
}

/** The newest pending customer question for this chat (null while none, or when the read fails). */
export function useOpenGap(
  organizationId: string | null | undefined,
  conversationId: string | null | undefined,
): { gap: OpenGap | null; reload: () => void } {
  const [gap, setGap] = useState<OpenGap | null>(null);
  const load = useCallback(async () => {
    if (!organizationId || !conversationId) {
      setGap(null);
      return;
    }
    const { data, error } = await aidwar
      .from("pending_owner_replies")
      .select("id, question")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .eq("source", "customer")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setGap(error || !data ? null : (data as OpenGap));
  }, [organizationId, conversationId]);

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener("aidwar:gaps-changed", handler);
    return () => window.removeEventListener("aidwar:gaps-changed", handler);
  }, [load]);

  return { gap, reload: () => void load() };
}

/** Approve (gold, the main choice) and Decline (outline). */
export function DecisionButtons({
  onPick,
  picked,
  size,
  className,
}: {
  onPick: (d: Decision) => void;
  picked?: Decision | null;
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <span className={cn("flex flex-wrap gap-2", className)}>
      <Button
        type="button"
        variant="gold"
        size={size}
        aria-pressed={picked === "approve"}
        onClick={() => onPick("approve")}
      >
        Approve
      </Button>
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-pressed={picked === "decline"}
        onClick={() => onPick("decline")}
      >
        Decline
      </Button>
    </span>
  );
}

/**
 * The owner's words for the decision. Empty to start: the box never suggests
 * a reply. Send goes through answer_gap; the toasts are the Unanswered list's.
 */
export function DecisionForm({
  organizationId,
  gap,
  decision,
  who,
  onDone,
  onCancel,
  className,
}: {
  organizationId: string;
  gap: OpenGap;
  decision: Decision;
  who: string;
  onDone: (delivered: boolean) => void;
  onCancel: () => void;
  className?: string;
}) {
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    box.current?.focus();
  }, [decision]);

  const send = async () => {
    if (!answer.trim()) {
      toast.error("Write the answer first.");
      return;
    }
    setBusy(true);
    const { data, error } = await knowledgeApi<{ delivered?: boolean }>(
      decisionRequest({ organizationId, replyId: gap.id, answer, decision }),
    );
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      data?.delivered
        ? "Sent to the customer — and I'll remember it."
        : "Saved — customer's window has closed, they'll get it next time they write.",
    );
    setAnswer("");
    gapsChanged();
    onDone(Boolean(data?.delivered));
  };

  return (
    <div
      data-decision={decision}
      className={cn(
        "flex flex-col gap-2 rounded-[14px] border border-gold-line bg-gold-bg px-3 py-2.5 text-sm text-foreground",
        className,
      )}
    >
      <label htmlFor={id} className="font-semibold text-gold-ink">
        {decision === "approve" ? "Approve" : "Decline"}: tell {who} in your own words
      </label>
      <p className="m-0 text-muted-foreground">They asked: “{gap.question}”</p>
      <Textarea
        id={id}
        ref={box}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        rows={2}
        className="min-h-[64px] resize-y rounded-[12px] border-line bg-surface text-[0.9375rem] shadow-none md:text-[0.9375rem]"
      />
      <p className="m-0 text-[0.8125rem] text-muted-foreground">
        Sent exactly as you write it, and Aiden remembers it for next time.
      </p>
      <span className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="gold"
          disabled={busy || !answer.trim()}
          onClick={() => void send()}
        >
          {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
          Send to {who}
        </Button>
      </span>
    </div>
  );
}
