import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Ban,
  Check,
  Loader2,
  MessageSquareText,
  PanelRight,
  Plus,
  Sparkles,
  Tags,
  UserRound,
  Wand2,
  X,
  GraduationCap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePermissions } from "@/hooks/use-permissions";
import { aidwar } from "@/integrations/aidwar/client";
import { aiRunApi } from "@/lib/employee-client";
import { handoverReasonText } from "@/lib/ai-outcome";
import { aiRunFor, questionBefore, type AiRunNote } from "@/lib/inbox-ai-runs";
import { cn } from "@/lib/utils";
import { WhatsAppBubble } from "@/components/design-v2";
import { TemplatePickerDialog, type TemplateSendPayload } from "@/components/templates/template-picker-dialog";
import { CorrectionDialog } from "../correction-dialog";
import { FlowRunBanner } from "../flow-run-banner";
import { FlowRunHistory } from "../flow-run-history";
import { AidenRulesBadge } from "../aiden-rules-badge";
import { SendCardButton } from "../send-card-button";
import { SendFormButton } from "../send-form-button";
import { useAiRuns, useAutoHeight, useHandoffAlertText } from "../chat-thread";
import { contactLabel, dayLabel, initials, type ConversationRow, type MemberRow, type MessageRow } from "../inbox-utils";
import { ToneAvatar } from "./chat-list";
import { MessageItem } from "./message-item";
import { takeoverPlan, windowChip, type AidenMode } from "./inbox-v2";

/** The time, once a minute, so the window chip counts down while a chat is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** A small tool under the message box (Batch 39's ComposerTool, in the new look). */
function Tool({
  label,
  onClick,
  disabled,
  busy,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8 gap-1.5 rounded-full px-2.5 text-muted-foreground hover:text-foreground"
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {label}
    </Button>
  );
}

/** The chat's window chip: free replies left, or closed. */
export function WindowChip({ lastCustomerMessageAt, now }: { lastCustomerMessageAt: string | null; now: number }) {
  const chip = windowChip(lastCustomerMessageAt, now);
  return (
    <span
      data-window={chip.open ? (chip.closing ? "closing" : "open") : "closed"}
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-full px-2.5 py-0.5 text-[0.8125rem] font-semibold",
        chip.open && !chip.closing && "bg-aiden-soft text-aiden-deep",
        chip.open && chip.closing && "bg-gold-bg text-gold-ink",
        !chip.open && "bg-bubble-in text-muted-foreground",
      )}
    >
      {chip.text}
    </span>
  );
}

export function ChatPane({
  conversation,
  messages,
  members,
  loading,
  sending,
  organizationId,
  userId,
  aidenMode,
  numberLabel: fromNumber,
  wabaId,
  onSend,
  onSendTemplate,
  onBack,
  onAssign,
  onToggleStatus,
  onResolveNeedsHuman,
  onTakeover,
  assignOpen,
  onAssignOpenChange,
  detailsOpen,
  onToggleDetails,
}: {
  conversation: ConversationRow;
  messages: MessageRow[];
  members: MemberRow[];
  loading: boolean;
  sending: boolean;
  organizationId: string | null;
  userId: string | null;
  aidenMode: AidenMode;
  numberLabel: string | null;
  wabaId: string | null;
  onSend: (text: string) => Promise<boolean>;
  onSendTemplate: (payload: TemplateSendPayload) => Promise<boolean>;
  onBack: () => void;
  onAssign: (userId: string | null) => void;
  onToggleStatus: () => void;
  onResolveNeedsHuman: () => void;
  onTakeover: () => Promise<void>;
  assignOpen: boolean;
  onAssignOpenChange: (open: boolean) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [assisting, setAssisting] = useState<"suggest" | "summary" | "tags" | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [proposedTags, setProposedTags] = useState<string[] | null>(null);
  const [applyingTags, setApplyingTags] = useState(false);
  const [taking, setTaking] = useState(false);
  const [teaching, setTeaching] = useState<AiRunNote | null>(null);
  const [teachOffer, setTeachOffer] = useState<AiRunNote | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  useAutoHeight(composerRef, draft);
  const now = useMinute();
  const chip = windowChip(conversation.last_customer_message_at, now);
  const open = chip.open;
  const label = contactLabel(conversation.contact);
  const { can } = usePermissions();
  const canUseAi = can("ai.use");
  const canTeach = can("ai.configure");
  const aiRuns = useAiRuns(organizationId, conversation.id);
  const alertText = useHandoffAlertText(conversation.id, Boolean(conversation.needs_human), conversation.needs_human_at);
  const plan = takeoverPlan(conversation, userId);
  const assignee = members.find((m) => m.user_id === conversation.assigned_to) ?? null;
  const assigneeName = assignee ? assignee.full_name || assignee.email || "Team member" : null;
  const memberName = useMemo(() => {
    const byId = new Map(members.map((m) => [m.user_id, m.full_name || m.email || "Team member"]));
    return (id: string | null | undefined) => (id ? (byId.get(id) ?? "Team member") : null);
  }, [members]);

  useEffect(() => {
    setSummary(null);
    setProposedTags(null);
    setSuggestion(null);
    setTeachOffer(null);
  }, [conversation.id]);

  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [messages.length, lastMessageId, conversation.id, loading]);

  // Messages already there when the chat loaded don't animate; new ones slide in.
  const seenRef = useRef<{ id: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (loading) {
      seenRef.current = null;
      return;
    }
    if (seenRef.current?.id !== conversation.id) {
      seenRef.current = { id: conversation.id, ids: new Set(messages.map((m) => m.id)) };
    }
  }, [loading, conversation.id, messages]);

  const assist = async (kind: "suggest" | "summary") => {
    if (!organizationId || assisting) return;
    setAssisting(kind);
    const { data, error } = await aiRunApi<{ run: { output: string; status: string } }>({
      organization_id: organizationId,
      action: kind === "suggest" ? "suggest_reply" : "summarise",
      conversation_id: conversation.id,
    });
    setAssisting(null);
    if (error) {
      toast.error(error);
      return;
    }
    const text = data?.run?.output?.trim() ?? "";
    if (!text) {
      toast.error("It had nothing useful to add here.");
      return;
    }
    if (kind === "suggest") setSuggestion(text);
    else setSummary(text);
  };

  const proposeTags = async () => {
    if (!organizationId || assisting) return;
    setAssisting("tags");
    const { data, error } = await aiRunApi<{ tags: string[] }>({
      organization_id: organizationId,
      action: "auto_tag",
      conversation_id: conversation.id,
    });
    setAssisting(null);
    if (error) {
      toast.error(error);
      return;
    }
    const tags = (data?.tags ?? []).filter(Boolean);
    if (tags.length === 0) {
      toast.error("It couldn't see a useful label for this chat yet.");
      return;
    }
    setProposedTags(tags);
  };

  // The classic composer's "Add them" (same reads and writes).
  const applyTags = async () => {
    const contactId = conversation.contact?.id;
    if (!organizationId || !contactId || !proposedTags?.length) return;
    setApplyingTags(true);
    try {
      for (const name of proposedTags) {
        const { data: existing } = await aidwar
          .from("tags")
          .select("id")
          .eq("organization_id", organizationId)
          .ilike("name", name)
          .maybeSingle();
        let tagId = (existing as { id?: string } | null)?.id ?? null;
        if (!tagId) {
          const { data: created, error } = await aidwar
            .from("tags")
            .insert({ organization_id: organizationId, name })
            .select("id")
            .single();
          if (error || !created) continue;
          tagId = (created as { id: string }).id;
        }
        await aidwar
          .from("contact_tags")
          .upsert({ contact_id: contactId, tag_id: tagId, organization_id: organizationId }, { onConflict: "contact_id,tag_id" });
      }
      toast.success("Labels added to this contact.");
      setProposedTags(null);
      window.dispatchEvent(new CustomEvent("aidwar:contact-tags-changed"));
    } finally {
      setApplyingTags(false);
    }
  };

  // The box empties the moment Send is pressed; a failed send gives the words back (Batch 39).
  const sendText = async (text: string, restore: (t: string) => void) => {
    if (!text || sending) return;
    const ok = await onSend(text);
    if (ok) {
      const asked = [...messages].reverse().find((m) => m.direction === "inbound" && (m.body ?? "").trim());
      if (canTeach && asked) setTeachOffer({ question: (asked.body ?? "").trim(), reply: text, taughtOn: null });
    } else restore(text);
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    await sendText(text, (t) => setDraft((current) => (current.trim() ? current : t)));
  };
  const sendSuggestion = async () => {
    const text = suggestion?.trim();
    if (!text || sending) return;
    setSuggestion(null);
    await sendText(text, (t) => setSuggestion(t));
  };
  const editSuggestion = () => {
    if (!suggestion) return;
    setDraft(suggestion);
    setSuggestion(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const takeover = async () => {
    setTaking(true);
    await onTakeover();
    setTaking(false);
  };

  // "/" in an empty box: the template, card and form pickers (the same buttons as the tool row).
  const toolButton = (name: string) =>
    toolsRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null;
  const [slashItems, setSlashItems] = useState<{ card: boolean; form: boolean }>({ card: false, form: false });
  const openSlash = () => {
    setSlashItems({ card: Boolean(toolButton("Send card")), form: Boolean(toolButton("Send form")) });
    setSlashOpen(true);
  };
  const pickSlash = (what: "template" | "card" | "form") => {
    setSlashOpen(false);
    // After the menu has closed and given focus back.
    setTimeout(() => {
      if (what === "template") return setPickerOpen(true);
      const button = toolButton(what === "card" ? "Send card" : "Send form");
      if (!button) return;
      button.focus();
      if (what === "card") button.click();
      else button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }, 0);
  };

  const aiTools = canUseAi && organizationId;
  const noMessages = messages.length === 0;
  const days = useMemo(() => {
    const out: Array<{ day: string; items: MessageRow[] }> = [];
    for (const m of messages) {
      const day = dayLabel(m.created_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [messages]);

  const aidenReplies = aidenMode !== "off" && aidenMode !== "draft";
  const toolRow = aiTools ? (
    <>
      <Tool
        label="Draft a reply"
        icon={<Wand2 />}
        busy={assisting === "suggest"}
        disabled={assisting !== null || noMessages}
        onClick={() => void assist("suggest")}
      />
      <Tool
        label="Catch me up"
        icon={<Sparkles />}
        busy={assisting === "summary"}
        disabled={assisting !== null || noMessages}
        onClick={() => void assist("summary")}
      />
      <Tool
        label="Suggest labels"
        icon={<Tags />}
        busy={assisting === "tags"}
        disabled={assisting !== null || noMessages}
        onClick={() => void proposeTags()}
      />
    </>
  ) : null;

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-surface">
      {/* Header: who, the 24-hour window, take over / hand back. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 wide:flex-nowrap wide:px-[18px] wide:py-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-foreground transition-colors duration-200 hover:bg-ground active:bg-accent wide:hidden"
          aria-label="Back to chats"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onToggleDetails}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-[14px] py-0.5 pr-2 text-left transition-colors duration-200 hover:bg-ground active:bg-accent wide:flex-initial"
          aria-label={`${label}, contact details`}
        >
          <ToneAvatar seed={conversation.contact?.id ?? conversation.id} label={label} />
          <span className="flex min-w-0 flex-col">
            <b className="truncate font-bold">{label}</b>
            <span className="truncate text-sm text-muted-foreground">
              {conversation.contact?.phone ?? ""}
              {fromNumber ? ` via ${fromNumber}` : ""}
            </span>
          </span>
        </button>
        <span className="order-4 flex min-w-0 basis-full items-center gap-2 wide:order-none wide:basis-auto">
          <WindowChip lastCustomerMessageAt={conversation.last_customer_message_at} now={now} />
          <span className="hidden min-w-0 @3xl:inline-flex">
            <AidenRulesBadge conversationId={conversation.id} />
          </span>
        </span>
        <span className="hidden flex-1 wide:block" aria-hidden="true" />
        <span className="flex shrink-0 items-center gap-1">
          <Select
            value={conversation.assigned_to ?? "unassigned"}
            onValueChange={(v) => onAssign(v === "unassigned" ? null : v)}
            open={assignOpen}
            onOpenChange={onAssignOpenChange}
          >
            <SelectTrigger
              className="h-9 w-9 justify-center rounded-full border-transparent bg-transparent p-0 shadow-none hover:bg-ground [&>svg:last-child]:hidden"
              aria-label={`Assigned to ${assigneeName ?? "nobody"} (press A)`}
            >
              {assignee ? (
                <span className="grid h-6 w-6 place-items-center rounded-full bg-aiden-soft text-[0.625rem] font-bold text-aiden-deep">
                  {initials(assigneeName ?? "?")}
                </span>
              ) : (
                <UserRound className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="sr-only">
                <SelectValue placeholder="Assign" />
              </span>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {m.full_name || m.email || "Team member"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {conversation.contact && organizationId ? (
            <FlowRunHistory organizationId={organizationId} contactId={conversation.contact.id} conversationId={conversation.id} />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-full"
            onClick={onToggleStatus}
            title={conversation.status === "closed" ? undefined : "Close (E)"}
          >
            {conversation.status === "closed" ? "Reopen" : "Close"}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleDetails}
            aria-label={detailsOpen ? "Hide contact details" : "Show contact details"}
            aria-pressed={detailsOpen}
            className={cn("h-9 w-9 rounded-full text-muted-foreground", detailsOpen && "bg-ground text-foreground")}
          >
            <PanelRight />
          </Button>
        </span>
        {plan && aidenReplies ? (
          <Button
            className="order-5 w-full rounded-[12px] wide:order-none wide:w-auto"
            onClick={() => void takeover()}
            disabled={taking}
            data-takeover={plan.action}
          >
            {taking ? <Loader2 className="animate-spin" /> : null}
            {plan.label}
          </Button>
        ) : !aidenReplies ? (
          <Link
            to="/app/employee"
            className="order-5 w-full rounded-full px-2 py-1 text-center text-sm font-semibold text-aiden-deep underline-offset-4 hover:underline wide:order-none wide:w-auto"
          >
            {aidenMode === "draft" ? "Aiden drafts only" : "Aiden is off"}
          </Link>
        ) : null}
      </header>

      {conversation.contact && organizationId ? (
        <FlowRunBanner organizationId={organizationId} contactId={conversation.contact.id} />
      ) : null}

      {conversation.contact?.opt_in_status === "opted_out" ? (
        <p className="m-0 flex shrink-0 items-start gap-2 border-b border-danger-border bg-danger-soft px-4 py-2.5 text-sm text-danger-soft-foreground">
          <Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          This contact opted out: no marketing. Service replies within the 24-hour window and utility or
          authentication templates (an order update, a code) are still fine.
        </p>
      ) : null}

      {/* The chat wall. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-ground bg-[radial-gradient(var(--line)_1px,transparent_1.2px)] bg-[length:20px_20px] px-3.5 py-4 wide:px-7 wide:py-5"
        aria-label={`Messages with ${label}`}
        role="log"
      >
        {loading ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-2.5" aria-busy="true">
            <Skeleton className="h-12 w-2/3 rounded-[14px] bg-surface" />
            <Skeleton className="ml-auto h-10 w-1/2 rounded-[14px] bg-bubble-out" />
            <Skeleton className="h-16 w-3/5 rounded-[14px] bg-surface" />
          </div>
        ) : noMessages ? (
          <div className="grid h-full place-items-center text-center">
            <p className="m-0 rounded-[14px] bg-surface px-5 py-4 text-sm text-muted-foreground shadow-xs">
              <b className="block text-foreground">No messages yet</b>
              Start the conversation with a message below.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
            {days.map((group) => (
              <section key={group.day} className="flex flex-col gap-2.5" aria-label={group.day}>
                <div className="sticky top-0 z-10 flex justify-center">
                  <span className="rounded-full bg-surface px-3 py-0.5 text-[0.8125rem] font-semibold text-muted-foreground shadow-xs">
                    {group.day}
                  </span>
                </div>
                {group.items.map((m) => {
                  const seen = seenRef.current;
                  const fresh = Boolean(seen && seen.id === conversation.id && !seen.ids.has(m.id));
                  return (
                    <MessageItem
                      key={m.id}
                      message={m}
                      organizationId={organizationId}
                      aiRun={aiRunFor(m, aiRuns)}
                      teammate={m.direction === "outbound" ? memberName(m.sent_by) : null}
                      fresh={fresh}
                      {...(canTeach
                        ? {
                            onTeach: (note: AiRunNote) =>
                              setTeaching({ ...note, question: note.question.trim() || questionBefore(messages, messages.indexOf(m)) }),
                          }
                        : {})}
                    />
                  );
                })}
              </section>
            ))}
            {conversation.needs_human ? (
              <WhatsAppBubble from="system" className="flex flex-col items-center gap-1" >
                <span data-shot="needs-human" className="block">
                  Aiden paused: {handoverReasonText(conversation.needs_human_reason) ?? "I stepped back on this one."}
                </span>
                {conversation.needs_human_question ? (
                  <span className="block font-medium">They asked: “{conversation.needs_human_question}”</span>
                ) : null}
                {conversation.handover_state ? (
                  <span className="block font-medium">
                    {conversation.handover_state === "sent"
                      ? "Aiden told them a colleague would reply here shortly."
                      : conversation.handover_state === "window_closed"
                        ? "Their 24-hour window had closed, so Aiden couldn't tell them. Send an approved template."
                        : "Aiden couldn't get a message to them, so they're still waiting."}
                  </span>
                ) : null}
                {alertText ? <span className="block font-medium">{alertText}</span> : null}
                <button
                  type="button"
                  onClick={onResolveNeedsHuman}
                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-[0.8125rem] font-semibold text-gold-ink transition-colors duration-200 hover:bg-gold-line active:bg-gold"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Mark as handled
                </button>
              </WhatsAppBubble>
            ) : conversation.assigned_to && aidenReplies ? (
              <WhatsAppBubble from="system">
                {conversation.assigned_to === userId ? "You" : (assigneeName ?? "A teammate")} took over. Aiden won't
                reply here until the chat is handed back.
              </WhatsAppBubble>
            ) : null}
            <div ref={bottomRef} className="h-px" />
          </div>
        )}
      </div>

      {/* Composer. */}
      <div className="flex shrink-0 flex-col gap-2.5 border-t border-line px-3 pb-3 pt-3 wide:px-4">
        {proposedTags ? (
          <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-ground px-3 py-2.5 text-sm">
            <Tags className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="font-semibold text-muted-foreground">It suggests:</span>
            {proposedTags.map((t) => (
              <span key={t} className="rounded-full bg-aiden-soft px-2.5 py-0.5 text-[0.8125rem] font-semibold text-aiden-deep">
                {t}
              </span>
            ))}
            <span className="ml-auto flex gap-2">
              <Button size="sm" className="rounded-full" disabled={applyingTags} onClick={() => void applyTags()}>
                {applyingTags ? <Loader2 className="animate-spin" /> : null}
                Add them
              </Button>
              <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setProposedTags(null)}>
                No thanks
              </Button>
            </span>
          </div>
        ) : null}
        {summary ? (
          <div className="relative rounded-[14px] border border-line bg-ground px-3.5 py-2.5 pr-10">
            <p className="m-0 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Sparkles className="h-4 w-4 text-aiden-deep" aria-hidden="true" />
              The short version
            </p>
            <p className="m-0 mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[0.9375rem]">{summary}</p>
            <button
              type="button"
              onClick={() => setSummary(null)}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-surface hover:text-foreground active:bg-accent"
              aria-label="Hide the short version"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {teachOffer ? (
          <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-ground px-3 py-2 text-sm text-muted-foreground">
            <GraduationCap className="h-4 w-4 shrink-0 text-aiden-deep" aria-hidden="true" />
            <span className="min-w-0 flex-1">Teach Aiden this answer? Next time a customer asks, Aiden can answer it.</span>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => {
                setTeaching(teachOffer);
                setTeachOffer(null);
              }}
            >
              Teach Aiden
            </Button>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setTeachOffer(null)}>
              Not now
            </Button>
          </div>
        ) : null}
        {suggestion ? (
          <div
            data-suggestion=""
            className="flex flex-wrap items-center gap-3 rounded-[14px] border border-gold-line bg-gold-bg px-3 py-2.5 text-sm text-foreground wide:flex-nowrap"
          >
            <span className="min-w-0 flex-1 basis-full wide:basis-auto">
              <b>Aiden suggests:</b> “{suggestion}”
            </span>
            <span className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" className="rounded-[11px]" onClick={editSuggestion}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="gold"
                className="rounded-[11px]"
                disabled={!open || sending}
                title={open ? undefined : "The 24-hour window is closed: send a template"}
                onClick={() => void sendSuggestion()}
              >
                Send
              </Button>
            </span>
          </div>
        ) : null}

        {open ? (
          <div className="flex items-end gap-2.5">
            <DropdownMenu open={slashOpen} onOpenChange={(o) => (o ? openSlash() : setSlashOpen(false))}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[46px] w-[46px] shrink-0 rounded-[12px]"
                  aria-label="Templates, cards and forms (/)"
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuLabel>Send</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => pickSlash("template")}>A template</DropdownMenuItem>
                {slashItems.card ? <DropdownMenuItem onSelect={() => pickSlash("card")}>A picture card</DropdownMenuItem> : null}
                {slashItems.form ? <DropdownMenuItem onSelect={() => pickSlash("form")}>A form</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <Textarea
              id="inbox-composer"
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "/" && !draft && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  e.preventDefault();
                  openSlash();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
                if (e.key === "Escape") e.currentTarget.blur();
              }}
              placeholder="Type a message, or / for templates"
              aria-label={`Message ${label}`}
              rows={1}
              className="max-h-44 min-h-[46px] flex-1 resize-none rounded-[12px] border-line bg-surface px-3.5 py-[11px] text-[0.9375rem] shadow-none md:text-[0.9375rem]"
            />
            <Button className="h-[46px] shrink-0 rounded-[12px] px-4" disabled={!draft.trim() || sending} onClick={() => void submit()}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              Send
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-[14px] border border-gold-line bg-gold-bg px-3.5 py-3 text-sm text-gold-ink wide:flex-row wide:items-center">
            <p className="m-0 flex-1 font-semibold">
              The 24-hour window is closed. Free replies open again when they write; until then, send an approved template.
            </p>
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              <SendCardButton organizationId={organizationId} conversationId={conversation.id} windowOpen={false} />
              <Button variant="gold" className="rounded-[11px]" onClick={() => setPickerOpen(true)}>
                <MessageSquareText />
                Send a template
              </Button>
            </span>
          </div>
        )}

        <div ref={toolsRef} className="-mx-1 flex flex-wrap items-center gap-0.5">
          {open ? (
            <>
              <SendFormButton organizationId={organizationId} conversationId={conversation.id} />
              <SendCardButton organizationId={organizationId} conversationId={conversation.id} windowOpen />
              {/* Batch 35: an approved template can go any time. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Send a template"
                title="Send a template"
                onClick={() => setPickerOpen(true)}
              >
                <MessageSquareText className="h-4 w-4" />
              </Button>
              {toolRow ? <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" /> : null}
            </>
          ) : null}
          {toolRow}
        </div>
      </div>

      <TemplatePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        organizationId={organizationId}
        wabaId={wabaId}
        sending={sending}
        onSend={onSendTemplate}
        conversationId={conversation.id}
        contactOptedOut={conversation.contact?.opt_in_status === "opted_out"}
      />

      {organizationId ? (
        <CorrectionDialog
          organizationId={organizationId}
          agentName="Aiden"
          open={teaching !== null}
          customerQuestion={teaching?.question ?? ""}
          saidInstead={teaching?.reply ?? ""}
          onOpenChange={(o) => !o && setTeaching(null)}
        />
      ) : null}
    </div>
  );
}
