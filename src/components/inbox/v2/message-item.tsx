import { memo, type ReactNode } from "react";
import { AlertCircle, Clock, GraduationCap, Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useReducedMotion } from "motion/react";
import { AnimatedListItem } from "@/components/magicui/animated-list";
import { ProductBubble, WhatsAppBubble } from "@/components/design-v2";
import { WhatsAppText } from "@/components/whatsapp-text";
import { isApiSource } from "@/lib/public-api-source";
import type { AiRunNote } from "@/lib/inbox-ai-runs";
import { cn } from "@/lib/utils";
import { FormAnswers, MessageMedia, mediaLabel } from "../chat-thread";
import { clockTime, mediaGoneNote, mediaSource, type MessageRow } from "../inbox-utils";
import { productCaption } from "./inbox-v2";

/** A message that arrived while the chat was open slides in (AnimatedList's motion); others just show. */
export function Arrive({ fresh, children }: { fresh: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  if (!fresh || reduce) return <>{children}</>;
  return <AnimatedListItem>{children}</AnimatedListItem>;
}

/** A failed send: the reason on hover or focus (Batch 39's StatusTicks, with an image role so the label is allowed). */
function FailedMark({ detail }: { detail: string | null }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            className="inline-flex text-destructive"
            tabIndex={0}
            aria-label="Failed to send"
          >
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-words">
          {detail?.slice(0, 200) || "This message failed to send."}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function tagClass() {
  return "rounded-full border border-line px-1.5 leading-[14px]";
}

/**
 * Batch 46: one message in the new Inbox, drawn with WhatsAppBubble (Batch
 * 44): the customer's on white, ours in mint with "Aiden" (or the teammate)
 * on top, ticks, product pictures as product cards, files through the same
 * MessageMedia as Batch 32 (stored files never become public links), forms
 * as answers, templates as their filled text.
 */
export const MessageItem = memo(function MessageItem({
  message,
  organizationId,
  aiRun,
  teammate,
  onTeach,
  fresh,
}: {
  message: MessageRow;
  organizationId: string | null;
  aiRun: AiRunNote | null;
  /** The teammate who sent it, when a person did. */
  teammate: string | null;
  onTeach?: (note: AiRunNote) => void;
  fresh: boolean;
}) {
  const outbound = message.direction === "outbound";
  const body = message.body?.trim() ?? "";
  const text =
    body ||
    message.template_text?.trim() ||
    (message.template_name ? `Template: ${message.template_name}` : `[${message.type}]`);
  const hasMedia = Boolean(message.media_url) || mediaGoneNote(message) !== null;
  const mediaOnly = hasMedia && !body && !message.template_name;
  const viaApi = isApiSource(message.metadata?.["source"]);
  const isTest = message.metadata?.["test"] === true;
  const fileName =
    typeof message.metadata?.["document_filename"] === "string"
      ? (message.metadata["document_filename"] as string)
      : null;
  const sender = outbound ? (aiRun ? "Aiden" : (teammate ?? undefined)) : undefined;
  const ticks =
    message.status === "read" || message.status === "delivered" || message.status === "sent"
      ? (message.status as "read" | "delivered" | "sent")
      : undefined;
  const meta = (
    <>
      {viaApi ? <span className={tagClass()}>Sent via API</span> : null}
      {isTest ? <span className={tagClass()}>Test</span> : null}
      {outbound && message.status === "failed" ? (
        <FailedMark detail={message.error_detail} />
      ) : null}
      {outbound && message.status === "pending" ? (
        <Clock className="h-3 w-3" role="img" aria-label="Sending" />
      ) : null}
    </>
  );

  // A product Aiden sent with its picture (an outbound picture we host): the product card.
  const source = mediaSource(message, organizationId);
  const product =
    outbound &&
    message.metadata?.["kind"] === "ai_product" &&
    source?.kind === "url" &&
    !mediaGoneNote(message);

  return (
    <Arrive fresh={fresh}>
      <div
        data-message-id={message.id}
        className={cn("flex scroll-mt-16 flex-col", outbound ? "items-end" : "items-start")}
      >
        {product ? (
          <ProductBubble
            image={source.url}
            imageAlt={productCaption(body).title}
            title={productCaption(body).title || "Product"}
            {...(productCaption(body).detail ? { detail: productCaption(body).detail! } : {})}
          />
        ) : (
          <WhatsAppBubble
            from={outbound ? "out" : "in"}
            {...(sender ? { sender } : {})}
            {...(outbound && ticks ? { ticks } : {})}
            time={clockTime(message.created_at)}
            meta={meta}
            className={cn("break-words", message.status === "failed" && "ring-1 ring-danger/40")}
          >
            {hasMedia ? (
              <MessageMedia
                message={message}
                organizationId={organizationId}
                label={fileName ?? (mediaOnly ? mediaLabel(message) : text)}
              />
            ) : null}
            {message.type === "form_reply" && Array.isArray(message.metadata?.["answers"]) ? (
              <FormAnswers
                name={String(message.metadata?.["form_name"] ?? "Form")}
                answers={message.metadata?.["answers"] as Array<{ label: string; value: string }>}
              />
            ) : mediaOnly ? null : (
              <span className="block whitespace-pre-wrap">
                <WhatsAppText text={text} />
              </span>
            )}
          </WhatsAppBubble>
        )}
        {aiRun ? (
          <span className="mt-1 flex flex-wrap items-center justify-end gap-2 px-1 text-[0.8125rem] text-muted-foreground">
            {aiRun.taughtOn ? (
              <span className="flex items-center gap-1">
                <GraduationCap className="h-3.5 w-3.5 text-aiden-deep" aria-hidden="true" />
                Aiden used something you taught on {aiRun.taughtOn}.
              </span>
            ) : null}
            {onTeach ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors duration-200 hover:bg-surface hover:text-foreground active:bg-accent"
                onClick={() => onTeach(aiRun)}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Improve this answer
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </Arrive>
  );
});
