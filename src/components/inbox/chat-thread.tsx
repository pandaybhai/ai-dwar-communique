import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Ban,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  MessageSquareText,
  Send,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  TemplatePickerDialog,
  type TemplateSendPayload,
} from "@/components/templates/template-picker-dialog";
import {
  clockTime,
  contactLabel,
  dayLabel,
  initials,
  withinWindow,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "./inbox-utils";

function StatusTicks({ message }: { message: MessageRow }) {
  if (message.status === "failed") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs break-words">
            {message.error_detail?.slice(0, 200) || "This message failed to send."}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (message.status === "read")
    return <CheckCheck className="h-3.5 w-3.5 text-sky-500" aria-label="Read" />;
  if (message.status === "delivered")
    return <CheckCheck className="h-3.5 w-3.5 text-muted-foreground" aria-label="Delivered" />;
  if (message.status === "sent")
    return <Check className="h-3.5 w-3.5 text-muted-foreground" aria-label="Sent" />;
  return <Clock className="h-3 w-3 text-muted-foreground" aria-label="Pending" />;
}

function Bubble({ message }: { message: MessageRow }) {
  const outbound = message.direction === "outbound";
  const text =
    message.body?.trim() ||
    (message.template_name ? `Template: ${message.template_name}` : `[${message.type}]`);
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "animate-in fade-in slide-in-from-bottom-1 max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm duration-200 sm:max-w-[68%]",
          outbound
            ? "rounded-br-md bg-primary/12 text-foreground"
            : "rounded-bl-md border border-border/70 bg-card text-foreground",
        ].join(" ")}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">{text}</p>
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
          <span>{clockTime(message.created_at)}</span>
          {outbound ? <StatusTicks message={message} /> : null}
        </div>
      </div>
    </div>
  );
}

export function ChatThread({
  conversation,
  messages,
  members,
  loading,
  sending,
  onSend,
  onSendTemplate,
  organizationId,
  numberLabel: fromNumber,
  onBack,
  onAssign,
  onToggleStatus,
}: {
  conversation: ConversationRow;
  messages: MessageRow[];
  members: MemberRow[];
  loading: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
  onSendTemplate: (payload: TemplateSendPayload) => Promise<boolean>;
  organizationId: string | null;
  /** Name of the connected number this thread arrived on, when there's more than one. */
  numberLabel?: string | null;
  onBack: () => void;
  onAssign: (userId: string | null) => void;
  onToggleStatus: () => void;

}) {
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const open = withinWindow(conversation.last_customer_message_at);
  const label = contactLabel(conversation.contact);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conversation.id]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const ok = await onSend(text);
    if (ok) setDraft("");
  };

  let lastDay = "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border/70 bg-card px-4 py-3">
        <Button variant="ghost" size="icon" className="rounded-full lg:hidden" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">Back to conversations</span>
        </Button>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {initials(label)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {conversation.contact?.phone ?? "—"}
          </p>
        </div>
        <Badge
          variant="secondary"
          className={
            conversation.status === "closed"
              ? "rounded-full"
              : "rounded-full bg-primary/10 text-primary"
          }
        >
          {conversation.status}
        </Badge>
        <Select
          value={conversation.assigned_to ?? "unassigned"}
          onValueChange={(v) => onAssign(v === "unassigned" ? null : v)}
        >
          <SelectTrigger className="hidden w-44 rounded-full sm:flex">
            <UserRound className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue placeholder="Assign" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.full_name || m.email || "Team member"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="rounded-full" onClick={onToggleStatus}>
          {conversation.status === "closed" ? "Reopen" : "Close"}
        </Button>
      </header>

      {conversation.contact?.opt_in_status === "opted_out" ? (
        <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            This contact opted out — only service replies within the 24-hour window are
            appropriate. Please don’t send marketing or templates.
          </p>
        </div>
      ) : null}



      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-4 py-5">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-2/3 rounded-2xl" />
            <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
            <Skeleton className="h-16 w-3/5 rounded-2xl" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MessageSquareText className="h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium text-foreground">No messages yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Start the conversation with a message below.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {messages.map((m) => {
              const day = dayLabel(m.created_at);
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <div key={m.id} className="flex flex-col gap-2">
                  {showDay ? (
                    <div className="my-2 flex justify-center">
                      <span className="rounded-full bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                        {day}
                      </span>
                    </div>
                  ) : null}
                  <Bubble message={m} />
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border/70 bg-card px-4 py-3">
        {open ? (
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Write a message…"
              rows={1}
              className="max-h-32 min-h-11 resize-none rounded-2xl"
            />
            <Button
              className="h-11 w-11 shrink-0 rounded-full p-0"
              disabled={!draft.trim() || sending}
              onClick={() => void submit()}
            >
              <Send className="h-4 w-4" />
              <span className="sr-only">Send message</span>
            </Button>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 sm:flex-row sm:items-center sm:justify-between dark:text-amber-400">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Outside the 24-hour window — send a template instead.</p>
            </div>
            <Button
              size="sm"
              className="shrink-0 rounded-full"
              onClick={() => setPickerOpen(true)}
            >
              <MessageSquareText className="mr-2 h-4 w-4" />
              Send a template
            </Button>
          </div>
        )}
      </div>

      <TemplatePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        organizationId={organizationId}
        sending={sending}
        onSend={onSendTemplate}
      />
    </div>
  );
}
