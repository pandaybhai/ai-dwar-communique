import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isApiSource } from "@/lib/public-api-source";
import {
  AlertCircle,
  Ban,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  Download,
  FileText,
  Loader2,
  MessageSquareText,
  PanelRight,
  ClipboardList,
  Send,
  Sparkles,
  Tags,
  UserRound,
  Wand2,
  GraduationCap,
  Languages,
  HandHelping,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { usePermissions } from "@/hooks/use-permissions";
import { CorrectionDialog } from "@/components/inbox/correction-dialog";
import { FlowRunBanner } from "@/components/inbox/flow-run-banner";
import { AidenRulesBadge } from "@/components/inbox/aiden-rules-badge";
import { FlowRunHistory } from "@/components/inbox/flow-run-history";
import { SendFormButton } from "@/components/inbox/send-form-button";
import { SendCardButton } from "@/components/inbox/send-card-button";
import { aiRunApi } from "@/lib/employee-client";
import { aidwar } from "@/integrations/aidwar/client";
import { languageLabel } from "@/lib/languages";
import { describeAlertResult, handoverReasonText, type HandoffAlertResult } from "@/lib/ai-outcome";
import { aiRunFor, questionBefore, type AiRunNote, type AiRunRow } from "@/lib/inbox-ai-runs";
import { cn } from "@/lib/utils";

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
  mediaGoneNote,
  mediaSource,
  withinWindow,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "./inbox-utils";
import { ContactAvatar } from "./contact-avatar";
import { WhatsAppText } from "@/components/whatsapp-text";

function StatusTicks({ message }: { message: MessageRow }) {
  if (message.status === "failed") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex text-destructive" tabIndex={0} aria-label="Failed to send">
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
    return <CheckCheck className="h-3.5 w-3.5 text-wa-tick" aria-label="Read" />;
  if (message.status === "delivered")
    return <CheckCheck className="h-3.5 w-3.5" aria-label="Delivered" />;
  if (message.status === "sent")
    return <Check className="h-3.5 w-3.5" aria-label="Sent" />;
  return <Clock className="h-3 w-3" aria-label="Pending" />;
}

/** image / video / audio / document — never guessed from the URL alone. */
function mediaKind(message: MessageRow): "image" | "video" | "audio" | "document" {
  const mime = (message.media_mime ?? "").toLowerCase();
  const type = (message.type ?? "").toLowerCase();
  const source = mime || type;
  if (source.startsWith("image") || source === "sticker") return "image";
  if (source.startsWith("video")) return "video";
  if (source.startsWith("audio")) return "audio";
  return "document";
}

/** "PDF", "DOCX" … from the file name or type, for the document card. */
function fileTypeLabel(message: MessageRow, label: string): string {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(label)?.[1];
  if (ext) return ext.toUpperCase();
  const mime = (message.media_mime ?? "").toLowerCase();
  if (mime.includes("pdf")) return "PDF";
  return "File";
}

/** Shows the file the customer sent (see mediaSource). */
function MessageMedia({
  message,
  organizationId,
  label,
}: {
  message: MessageRow;
  organizationId: string | null;
  label: string;
}) {
  const source = mediaSource(message, organizationId);
  const fetchPath = source?.kind === "fetch" ? source.path : null;
  const directUrl = source?.kind === "url" ? source.url : null;
  const [src, setSrc] = useState<string | null>(directUrl);
  const [failed, setFailed] = useState(false);
  const gone = mediaGoneNote(message);

  useEffect(() => {
    setFailed(false);
    if (!fetchPath || gone) {
      setSrc(directUrl);
      return;
    }
    setSrc(null);
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      const { data } = await aidwar.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch(fetchPath, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        if (!cancelled) setFailed(true);
        return;
      }
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setSrc(objectUrl);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fetchPath, directUrl, gone]);

  if (gone) {
    return (
      <p className="mb-1.5 rounded-md border border-dashed border-current/25 px-3 py-2 text-xs opacity-75">
        {gone}
      </p>
    );
  }

  const kind = mediaKind(message);

  if (failed) {
    return (
      <p className="mb-1.5 rounded-md border border-dashed border-current/25 px-3 py-2 text-xs opacity-75">
        We couldn't load this file — it may have expired on WhatsApp.
      </p>
    );
  }
  if (!src) {
    return <Skeleton className={cn("mb-1.5 rounded-md", kind === "document" ? "h-14 w-60" : "h-40 w-60")} />;
  }

  if (kind === "image") {
    return (
      <img
        src={src}
        alt={label}
        loading="lazy"
        className="-mx-[5px] -mt-[2px] mb-1.5 block max-h-72 w-[calc(100%+10px)] min-w-[200px] rounded-md object-cover"
      />
    );
  }
  if (kind === "video") {
    return <video src={src} controls className="-mx-[5px] -mt-[2px] mb-1.5 max-h-72 w-[calc(100%+10px)] rounded-md" />;
  }
  if (kind === "audio") {
    return <audio src={src} controls className="mb-1.5 w-64 max-w-full" />;
  }
  return (
    <a
      href={src}
      download={label}
      className="-mx-[3px] mb-1.5 flex min-w-[220px] items-center gap-3 rounded-md bg-black/[0.045] px-3 py-2.5 text-wa-text transition-colors hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/[0.09]"
    >
      <span className="flex h-9 w-8 shrink-0 items-center justify-center rounded-[4px] bg-danger text-[0.5625rem] font-bold text-danger-foreground">
        {fileTypeLabel(message, label) === "PDF" ? "PDF" : <FileText className="h-4 w-4" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block text-[0.6875rem] text-wa-meta">{fileTypeLabel(message, label)}</span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-wa-meta" aria-hidden="true" />
    </a>
  );
}

/**
 * The AI answers of this conversation, newest first, so a merchant can improve
 * the exact reply they are looking at (matched by aiRunFor).
 */
function useAiRuns(organizationId: string | null, conversationId: string) {
  const [runs, setRuns] = useState<AiRunRow[]>([]);

  const load = useCallback(async () => {
    if (!organizationId) return;
    const { data } = await aidwar
      .from("ai_runs")
      .select("output, input_summary, sources, created_at")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("task", "agent_reply")
      .order("created_at", { ascending: false })
      .limit(60);
    setRuns((data ?? []) as AiRunRow[]);
  }, [organizationId, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return runs;
}

/**
 * Batch 28: who the staff alert for this waiting chat reached (or that nobody
 * could be). Its own read, so the Inbox list never depends on the column; a
 * failed read (e.g. 20261080 not applied yet) just shows nothing.
 */
function useHandoffAlertText(conversationId: string, waiting: boolean, waitingSince: string | null | undefined) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!waiting) return;
    let live = true;
    void Promise.resolve(
      aidwar.from("conversations").select("handoff_alert_result").eq("id", conversationId).maybeSingle(),
    )
      .then(({ data, error }) => {
        if (!live || error) return;
        const result = (data as { handoff_alert_result?: Partial<HandoffAlertResult> | null } | null)?.handoff_alert_result;
        setText(describeAlertResult(result));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversationId, waiting, waitingSince]);
  return text;
}

/** A filled-in WhatsApp form, read as "question: answer" rows. */
function FormAnswers({ name, answers }: { name: string; answers: Array<{ label: string; value: string }> }) {
  return (
    <div className="min-w-[200px]">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-wa-link">
        <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
        {name}
      </p>
      <dl className="space-y-1">
        {answers.map((a, i) => (
          <div key={`${a.label}-${i}`} className="grid grid-cols-[auto_1fr] gap-x-2">
            <dt className="text-wa-meta">{a.label}:</dt>
            <dd className="break-words font-medium">{a.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Alt text / file name for a media message without words. */
function mediaLabel(message: MessageRow): string {
  const kind = mediaKind(message);
  return kind === "image" ? "Picture" : kind === "video" ? "Video" : kind === "audio" ? "Voice note" : "Document";
}

export function Bubble({
  message,
  organizationId,
  aiRun,
  agentName,
  onTeach,
  tail = true,
  fresh = false,
}: {
  message: MessageRow;
  organizationId: string | null;
  /** The AI run behind this message, when the AI wrote it. */
  aiRun?: AiRunNote | null;
  agentName: string;
  /** Opens "Improve this answer" for the reply this message is part of. */
  onTeach?: (note: AiRunNote) => void;
  /** Batch 39: the first bubble of a run from one side carries WhatsApp's tail. */
  tail?: boolean;
  /** Batch 39: arrived while the chat was open — lands with a short animation. */
  fresh?: boolean;
}) {
  const outbound = message.direction === "outbound";
  const body = message.body?.trim() ?? "";
  const text =
    body ||
    message.template_text?.trim() ||
    (message.template_name ? `Template: ${message.template_name}` : `[${message.type}]`);
  // A picture (a card, a photo) with no words is just the picture: the
  // "[image]" stand-in is ours, the customer never saw it.
  // A file that was removed or expired still says so (Batch 32).
  const hasMedia = Boolean(message.media_url) || mediaGoneNote(message) !== null;
  const mediaOnly = hasMedia && !body && !message.template_name;
  // Batch 34: sent by the merchant's own software through the Public API.
  // "api" or "api_console" (the Try-it console, Batch 38).
  const viaApi = isApiSource(message.metadata?.["source"]);
  // Batch 35: a campaign test send from the wizard — never part of a campaign.
  const isTest = message.metadata?.["test"] === true;
  const fileName = typeof message.metadata?.["document_filename"] === "string" ? (message.metadata["document_filename"] as string) : null;
  return (
    <div className={cn("flex", outbound ? "justify-end pr-2" : "justify-start pl-2", fresh && "msg-arrive")}>
      <div className={cn("flex max-w-[85%] flex-col sm:max-w-[65%]", outbound ? "items-end" : "items-start")}>
        <div
          className={cn(
            outbound ? "wa-bubble-out" : "wa-bubble-in",
            tail && "wa-tail",
            message.status === "failed" && "ring-1 ring-danger/40",
          )}
        >
          {hasMedia ? (
            <MessageMedia message={message} organizationId={organizationId} label={fileName ?? (mediaOnly ? mediaLabel(message) : text)} />
          ) : null}
          {message.type === "form_reply" && Array.isArray(message.metadata?.["answers"]) ? (
            <FormAnswers
              name={String(message.metadata?.["form_name"] ?? "Form")}
              answers={message.metadata?.["answers"] as Array<{ label: string; value: string }>}
            />
          ) : mediaOnly ? null : (
            <p className="inline whitespace-pre-wrap break-words">
              <WhatsAppText text={text} />
            </p>
          )}
          <span className="wa-meta">
            {aiRun ? (
              <span className="inline-flex items-center" title={`Written by ${agentName}`}>
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">Written by {agentName}</span>
              </span>
            ) : null}
            {viaApi ? <span className="rounded-full border border-current/30 px-1.5 leading-[14px]">Sent via API</span> : null}
            {isTest ? <span className="rounded-full border border-current/30 px-1.5 leading-[14px]">Test</span> : null}
            <span>{clockTime(message.created_at)}</span>
            {outbound ? <StatusTicks message={message} /> : null}
          </span>
        </div>

        {aiRun ? (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2 px-1 text-[0.6875rem] text-muted-foreground">
            {aiRun.taughtOn ? (
              <span className="flex items-center gap-1">
                <GraduationCap className="h-3 w-3 text-primary" />
                {agentName} used something you taught him on {aiRun.taughtOn}.
              </span>
            ) : null}
            {onTeach ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors duration-150 hover:bg-card hover:text-foreground"
                onClick={() => onTeach(aiRun)}
              >
                <Sparkles className="h-3 w-3" />
                Improve this answer
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The textarea grows with what's typed (up to ~7 lines), and shrinks back after sending. */
function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
  }, [ref, value]);
}

function ComposerTool({
  label,
  onClick,
  disabled,
  busy,
  icon,
  text,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon: React.ReactNode;
  text?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground", text ? "w-8 px-0 @2xl:w-auto @2xl:px-2" : "w-8 px-0")}
      disabled={disabled}
      onClick={onClick}
      aria-label={text ? undefined : label}
      title={label}
    >
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {text ? <span className="hidden text-[0.8125rem] @2xl:inline">{text}</span> : null}
    </Button>
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
  wabaId,

  onBack,
  onAssign,
  onToggleStatus,
  onResolveNeedsHuman,
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
  onSend: (text: string) => Promise<boolean>;
  onSendTemplate: (payload: TemplateSendPayload) => Promise<boolean>;
  organizationId: string | null;
  /** Name of the connected number this thread arrived on, when there's more than one. */
  numberLabel?: string | null;
  /** Business account behind that number — scopes the template library. */
  wabaId?: string | null;

  onBack: () => void;
  onAssign: (userId: string | null) => void;
  onToggleStatus: () => void;
  /** Clears the "Waiting for you" flag once a person has picked the thread up (Aiden is back on it). */
  onResolveNeedsHuman?: () => void;
  /** Batch 39: the assignee picker, opened by the "a" shortcut. */
  assignOpen?: boolean;
  onAssignOpenChange?: (open: boolean) => void;
  /** Batch 39: the contact details panel beside the chat. */
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assisting, setAssisting] = useState<"suggest" | "summary" | "tags" | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [proposedTags, setProposedTags] = useState<string[] | null>(null);
  const [applyingTags, setApplyingTags] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoHeight(composerRef, draft);
  const open = withinWindow(conversation.last_customer_message_at);
  const label = contactLabel(conversation.contact);
  const { can } = usePermissions();
  const canUseAi = can("ai.use");
  // Saving an answer (knowledge "correct") needs ai.configure.
  const canTeach = can("ai.configure");
  const aiRuns = useAiRuns(organizationId, conversation.id);
  const alertText = useHandoffAlertText(conversation.id, Boolean(conversation.needs_human), conversation.needs_human_at);
  // What the customer actually writes in, from their most recent message.
  const customerLanguage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.direction === "inbound" && m.detected_language) return m.detected_language;
    }
    return null;
  }, [messages]);
  const [teaching, setTeaching] = useState<AiRunNote | null>(null);
  // Batch 39: on a narrow chat the hand-off banner shows its first lines; "More" opens the rest.
  const [bannerMore, setBannerMore] = useState(false);
  useEffect(() => setBannerMore(false), [conversation.id]);

  // Batch 28: on the newest message whenever a chat opens or grows — also
  // after its messages finish loading (the end marker only exists then), and
  // when the new chat happens to have as many messages as the last one.
  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [messages.length, lastMessageId, conversation.id, loading]);

  // Batch 39: messages already there when the chat loaded don't animate;
  // only ones that arrive while it is open do.
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

  useEffect(() => {
    setSummary(null);
    setProposedTags(null);
  }, [conversation.id]);

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
    if (kind === "suggest") {
      setDraft(text);
      toast.success("Draft ready — read it, edit it, then send.");
      requestAnimationFrame(() => composerRef.current?.focus());
    } else {
      setSummary(text);
    }
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
          .upsert(
            { contact_id: contactId, tag_id: tagId, organization_id: organizationId },
            { onConflict: "contact_id,tag_id" },
          );
      }
      toast.success("Labels added to this contact.");
      setProposedTags(null);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("aidwar:contact-tags-changed"));
    } finally {
      setApplyingTags(false);
    }
  };


  // After a teammate answers a customer by hand, offer to teach Aiden that
  // answer (the same CorrectionDialog → knowledge "correct" → saveCorrection).
  const [teachOffer, setTeachOffer] = useState<AiRunNote | null>(null);
  useEffect(() => setTeachOffer(null), [conversation.id]);

  // Batch 39: the box empties the moment Send is pressed (the message shows
  // in the chat right away); if the send fails, the words come back.
  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    const ok = await onSend(text);
    if (ok) {
      const asked = [...messages].reverse().find((m) => m.direction === "inbound" && (m.body ?? "").trim());
      if (canTeach && asked) setTeachOffer({ question: (asked.body ?? "").trim(), reply: text, taughtOn: null });
    } else {
      setDraft((current) => (current.trim() ? current : text));
    }
  };

  const aiTools = canUseAi && organizationId;
  const noMessages = messages.length === 0;

  // Day groups, so each day's label can stick to the top while you scroll it.
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
  const assignee = members.find((m) => m.user_id === conversation.assigned_to) ?? null;

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-border bg-card px-2 sm:gap-3 sm:px-4">
        <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">Back to conversations</span>
        </Button>
        <button
          type="button"
          onClick={onToggleDetails}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 pr-2 text-left transition-colors hover:bg-accent/60 @md:max-w-[15rem] @md:flex-initial"
          aria-label={`${label} — contact details`}
          disabled={!onToggleDetails}
        >
          <ContactAvatar seed={conversation.contact?.id ?? conversation.id} label={label} className="h-9 w-9 text-xs" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{label}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {conversation.contact?.phone ?? "—"}
              {fromNumber ? <span className="opacity-80"> · via {fromNumber}</span> : null}
            </span>
          </span>
        </button>

        <div className="hidden min-w-0 flex-1 items-center gap-2 overflow-hidden @md:flex">
          <AidenRulesBadge conversationId={conversation.id} />

          {customerLanguage ? (
            <Badge
              variant="outline"
              className="hidden shrink-0 rounded-full font-normal @3xl:inline-flex"
              title="Your AI employee replies in this language"
            >
              <Languages className="mr-1 h-3 w-3" />
              {customerLanguage === "hi-Latn" ? "Hinglish" : languageLabel(customerLanguage)}
            </Badge>
          ) : null}

          <Badge
            variant={conversation.status === "closed" ? "muted" : "success"}
            className="hidden shrink-0 rounded-full capitalize @2xl:inline-flex"
          >
            {conversation.status}
          </Badge>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          <Select
            value={conversation.assigned_to ?? "unassigned"}
            onValueChange={(v) => onAssign(v === "unassigned" ? null : v)}
            {...(assignOpen !== undefined ? { open: assignOpen } : {})}
            {...(onAssignOpenChange ? { onOpenChange: onAssignOpenChange } : {})}
          >
            <SelectTrigger
              className="hidden h-8 w-auto max-w-44 gap-1.5 rounded-full border-transparent bg-transparent px-2.5 shadow-none hover:bg-accent sm:flex"
              aria-label={`Assigned to ${assignee ? assignee.full_name || assignee.email || "Team member" : "nobody"} (press A)`}
            >
              {assignee ? (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[0.5625rem] font-semibold text-primary">
                  {initials(assignee.full_name || assignee.email || "?")}
                </span>
              ) : (
                <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span className="hidden truncate @2xl:inline">
                  <SelectValue placeholder="Assign" />
                </span>
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
          <Button variant="outline" size="sm" className="rounded-full" onClick={onToggleStatus} title={conversation.status === "closed" ? undefined : "Close (E)"}>
            {conversation.status === "closed" ? "Reopen" : "Close"}
          </Button>
          {conversation.contact && organizationId ? (
            <FlowRunHistory organizationId={organizationId} contactId={conversation.contact.id} conversationId={conversation.id} />
          ) : null}
          {onToggleDetails ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleDetails}
              aria-label={detailsOpen ? "Hide contact details" : "Show contact details"}
              aria-pressed={detailsOpen ?? false}
              className={cn("text-muted-foreground", detailsOpen && "bg-accent text-foreground")}
            >
              <PanelRight />
            </Button>
          ) : null}
        </div>
      </header>

      {conversation.contact && organizationId ? (
        <FlowRunBanner organizationId={organizationId} contactId={conversation.contact.id} />
      ) : null}

      {conversation.needs_human ? (
        <div
          data-shot="needs-human"
          role="status"
          className="flex shrink-0 flex-col gap-2.5 border-b border-warning-border bg-warning-soft px-4 py-3 text-xs text-warning-soft-foreground @xl:flex-row @xl:items-start @xl:gap-3"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning/25">
              <HandHelping className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-[0.8125rem] font-semibold">
                Waiting for you.{" "}
                <span className="font-medium">{handoverReasonText(conversation.needs_human_reason) ?? "I stepped back on this one."}</span>
              </p>
              {conversation.needs_human_question ? (
                <p className="break-words opacity-90">
                  They asked: “{conversation.needs_human_question}”
                </p>
              ) : null}
              <div className={cn("space-y-0.5", !bannerMore && "hidden @xl:block")}>
                {/* What the customer was told — only when Aiden tried to tell them
                    (a flow's hand-off sends the customer nothing, so it says nothing). */}
                {conversation.handover_state ? (
                  <p className="opacity-85">
                    {conversation.handover_state === "sent"
                      ? "I told them a colleague would reply here shortly."
                      : conversation.handover_state === "window_closed"
                        ? "Their 24-hour window had closed, so I couldn't tell them — send an approved template."
                        : "I couldn't get a message to them, so they're still waiting."}
                  </p>
                ) : null}
                {alertText ? <p className="opacity-85">{alertText}</p> : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-10 @xl:pl-0">
            {(conversation.handover_state || alertText) && !bannerMore ? (
              <button
                type="button"
                onClick={() => setBannerMore(true)}
                className="text-xs font-medium underline underline-offset-2 @xl:hidden"
              >
                More
              </button>
            ) : null}
            {onResolveNeedsHuman ? (
              <Button size="sm" variant="outline" className="h-8 rounded-full border-warning-border bg-card/80" onClick={onResolveNeedsHuman}>
                <Check /> Mark as handled
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {conversation.contact?.opt_in_status === "opted_out" ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger-border bg-danger-soft px-4 py-2.5 text-xs text-danger-soft-foreground">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            This contact opted out — no marketing. Service replies within the 24-hour window and
            utility or authentication templates (an order update, a code) are still fine.
          </p>
        </div>
      ) : null}



      <div className="wa-wall min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6" aria-label={`Messages with ${label}`} role="log">
        {loading ? (
          <div className="mx-auto max-w-3xl space-y-3" aria-busy="true">
            <Skeleton className="h-12 w-2/3 rounded-lg bg-wa-in/80" />
            <Skeleton className="ml-auto h-10 w-1/2 rounded-lg bg-wa-out/80" />
            <Skeleton className="h-16 w-3/5 rounded-lg bg-wa-in/80" />
          </div>
        ) : noMessages ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="rounded-xl bg-wa-in/90 px-5 py-4 shadow-sm">
              <MessageSquareText className="mx-auto h-7 w-7 text-wa-meta" />
              <p className="mt-3 text-sm font-medium text-wa-text">No messages yet</p>
              <p className="mt-1 text-xs text-wa-meta">
                Start the conversation with a message below.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col">
            {days.map((group) => (
              <section key={group.day} className="flex flex-col" aria-label={group.day}>
                <div className="sticky top-0 z-10 flex justify-center py-2">
                  <span className="rounded-lg bg-wa-in/95 px-3 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-wa-meta shadow-[0_1px_0.5px_rgb(11_20_26/0.13)] backdrop-blur">
                    {group.day}
                  </span>
                </div>
                {group.items.map((m, i) => {
                  const prev = group.items[i - 1];
                  const first = !prev || prev.direction !== m.direction;
                  const seen = seenRef.current;
                  const fresh = Boolean(seen && seen.id === conversation.id && !seen.ids.has(m.id));
                  return (
                    <div key={m.id} className={first ? "mt-2.5" : "mt-0.5"}>
                      <Bubble
                        message={m}
                        organizationId={organizationId}
                        agentName="Your AI employee"
                        aiRun={aiRunFor(m, aiRuns)}
                        tail={first}
                        fresh={fresh}
                        {...(canTeach
                          ? {
                              onTeach: (note: AiRunNote) =>
                                setTeaching({ ...note, question: note.question.trim() || questionBefore(messages, messages.indexOf(m)) }),
                            }
                          : {})}
                      />
                    </div>
                  );
                })}
              </section>
            ))}
            <div ref={bottomRef} className="h-1" />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-card px-3 pb-3 pt-2.5 sm:px-4">
        <div className="mx-auto max-w-3xl">
          {proposedTags ? (
            <div className="msg-arrive mb-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-subtle px-3.5 py-2.5">
              <Tags className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs font-medium text-muted-foreground">It suggests:</span>
              {proposedTags.map((t) => (
                <Badge key={t} variant="secondary" className="rounded-full">
                  {t}
                </Badge>
              ))}
              <div className="ml-auto flex gap-2">
                <Button
                  size="xs"
                  className="rounded-full"
                  disabled={applyingTags}
                  onClick={() => void applyTags()}
                >
                  {applyingTags ? <Loader2 className="animate-spin" /> : null}
                  Add them
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => setProposedTags(null)}
                >
                  No thanks
                </Button>
              </div>
            </div>
          ) : null}
          {summary ? (
            <div className="msg-arrive relative mb-2.5 rounded-xl border border-border bg-subtle px-3.5 py-2.5 pr-9">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                The short version
              </p>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {summary}
              </p>
              <button
                type="button"
                onClick={() => setSummary(null)}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Hide the short version"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          {teachOffer ? (
            <div className="msg-arrive mb-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-subtle px-3.5 py-2 text-xs text-muted-foreground">
              <GraduationCap className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1">Teach Aiden this answer? Next time a customer asks, Aiden can answer it.</span>
              <Button
                size="xs"
                variant="outline"
                className="rounded-full"
                onClick={() => {
                  setTeaching(teachOffer);
                  setTeachOffer(null);
                }}
              >
                Teach Aiden
              </Button>
              <Button size="xs" variant="ghost" className="rounded-full" onClick={() => setTeachOffer(null)}>
                Not now
              </Button>
            </div>
          ) : null}
          {open ? (

            <div className="rounded-2xl border border-input bg-card shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15">
              <Textarea
                id="inbox-composer"
                ref={composerRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                  if (e.key === "Escape") e.currentTarget.blur();
                }}
                placeholder="Write a message…"
                aria-label={`Message ${label}`}
                rows={1}
                className="max-h-44 min-h-11 resize-none rounded-2xl border-0 bg-transparent px-4 pb-1 pt-3 text-[0.9375rem] shadow-none hover:border-0 focus-visible:ring-0 md:text-[0.9375rem]"
              />
              <div className="flex items-center gap-0.5 px-2 pb-2">
                <SendFormButton organizationId={organizationId} conversationId={conversation.id} />
                <SendCardButton organizationId={organizationId} conversationId={conversation.id} windowOpen />
                {/* Batch 35: an approved template can go any time, not only once the window closes. */}
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
                {aiTools ? (
                  <>
                    <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
                    <ComposerTool
                      label="Draft a reply"
                      text="Draft a reply"
                      icon={<Wand2 />}
                      busy={assisting === "suggest"}
                      disabled={assisting !== null || noMessages}
                      onClick={() => void assist("suggest")}
                    />
                    <ComposerTool
                      label="Catch me up"
                      text="Catch me up"
                      icon={<Sparkles />}
                      busy={assisting === "summary"}
                      disabled={assisting !== null || noMessages}
                      onClick={() => void assist("summary")}
                    />
                    <ComposerTool
                      label="Suggest labels"
                      icon={<Tags />}
                      busy={assisting === "tags"}
                      disabled={assisting !== null || noMessages}
                      onClick={() => void proposeTags()}
                    />
                  </>
                ) : null}
                <span className="flex-1" aria-hidden="true" />
                <span className="hidden items-center gap-1 whitespace-nowrap pr-2 text-[0.6875rem] text-faint @3xl:flex" aria-hidden="true">
                  <Kbd>↵</Kbd> send · <Kbd>⇧</Kbd>
                  <Kbd>↵</Kbd> new line
                </span>
                <Button
                  size="icon-sm"
                  className="h-9 w-9 shrink-0 rounded-full"
                  disabled={!draft.trim() || sending}
                  onClick={() => void submit()}
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  <span className="sr-only">Send message</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-2xl border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Outside the 24-hour window — send a template instead.</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <SendCardButton organizationId={organizationId} conversationId={conversation.id} windowOpen={false} />
                <Button
                  size="sm"
                  className="shrink-0 rounded-full"
                  onClick={() => setPickerOpen(true)}
                >
                  <MessageSquareText className="mr-2 h-4 w-4" />
                  Send a template
                </Button>
              </div>
            </div>
          )}
          {!open && aiTools ? (
            <div className="mt-2 flex flex-wrap items-center gap-0.5">
              <ComposerTool
                label="Draft a reply"
                text="Draft a reply"
                icon={<Wand2 />}
                busy={assisting === "suggest"}
                disabled={assisting !== null || noMessages}
                onClick={() => void assist("suggest")}
              />
              <ComposerTool
                label="Catch me up"
                text="Catch me up"
                icon={<Sparkles />}
                busy={assisting === "summary"}
                disabled={assisting !== null || noMessages}
                onClick={() => void assist("summary")}
              />
              <ComposerTool
                label="Suggest labels"
                text="Suggest labels"
                icon={<Tags />}
                busy={assisting === "tags"}
                disabled={assisting !== null || noMessages}
                onClick={() => void proposeTags()}
              />
            </div>
          ) : null}
        </div>
      </div>

      <TemplatePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        organizationId={organizationId}
        wabaId={wabaId ?? null}
        sending={sending}
        onSend={onSendTemplate}
        conversationId={conversation.id}
        contactOptedOut={conversation.contact?.opt_in_status === "opted_out"}
      />

      {organizationId ? (
        <CorrectionDialog
          organizationId={organizationId}
          agentName="your AI employee"
          open={teaching !== null}
          customerQuestion={teaching?.question ?? ""}
          saidInstead={teaching?.reply ?? ""}
          onOpenChange={(open) => !open && setTeaching(null)}
        />
      ) : null}


    </div>
  );
}
