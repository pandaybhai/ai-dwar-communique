import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Ban,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  MessageSquareText,
  Paperclip,
  Send,
  Sparkles,
  Tags,
  UserRound,
  Wand2,
  GraduationCap,
  ThumbsDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { usePermissions } from "@/hooks/use-permissions";
import { CorrectionDialog } from "@/components/inbox/correction-dialog";
import { aiRunApi } from "@/lib/employee-client";
import { aidwar } from "@/integrations/aidwar/client";

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

/**
 * Shows the file the customer sent. Inbound media lives behind Meta's API as an
 * opaque id, so we fetch it through our own authenticated route and hand the
 * browser a blob — a customer's photo is never a public link.
 */
function MessageMedia({
  message,
  organizationId,
  label,
}: {
  message: MessageRow;
  organizationId: string | null;
  label: string;
}) {
  const raw = message.media_url ?? "";
  const isMetaRef = raw.startsWith("meta:");
  const [src, setSrc] = useState<string | null>(isMetaRef ? null : raw);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isMetaRef) {
      setSrc(raw);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      const { data } = await aidwar.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const query = organizationId ? `?organization_id=${organizationId}` : "";
      const res = await fetch(
        `/api/whatsapp/media/${encodeURIComponent(raw.slice(5))}${query}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
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
  }, [raw, isMetaRef, organizationId]);

  const kind = mediaKind(message);

  if (failed) {
    return (
      <p className="mb-1.5 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        We couldn't load this file — it may have expired on WhatsApp.
      </p>
    );
  }
  if (!src) {
    return <Skeleton className="mb-1.5 h-32 w-48 rounded-xl" />;
  }

  if (kind === "image") {
    return (
      <img
        src={src}
        alt={label}
        loading="lazy"
        className="mb-1.5 max-h-56 w-full rounded-xl object-cover"
      />
    );
  }
  if (kind === "video") {
    return <video src={src} controls className="mb-1.5 max-h-56 w-full rounded-xl" />;
  }
  if (kind === "audio") {
    return <audio src={src} controls className="mb-1.5 w-full" />;
  }
  return (
    <a
      href={src}
      download={label}
      className="mb-1.5 flex items-center gap-2 rounded-xl border border-border/70 px-3 py-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
    >
      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </a>
  );
}

/** What we can say about an AI-written reply: what was asked, what taught it. */
type AiRunNote = { question: string; taughtOn: string | null };

/**
 * Matches AI answers to the messages they produced, so a merchant can correct
 * the exact reply they are looking at.
 */
function useAiRuns(organizationId: string | null, conversationId: string) {
  const [runs, setRuns] = useState<
    { output: string; input_summary: string | null; sources: unknown; created_at: string }[]
  >([]);

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
    setRuns((data ?? []) as typeof runs);
  }, [organizationId, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return useMemo(() => {
    const byOutput = new Map<string, AiRunNote>();
    for (const run of runs) {
      const key = (run.output ?? "").trim();
      if (!key || byOutput.has(key)) continue;
      const sources = Array.isArray(run.sources)
        ? (run.sources as Array<{ sourceType?: string }>)
        : [];
      const taught = sources.some((s) => s?.sourceType === "manual_qa");
      byOutput.set(key, {
        question: run.input_summary ?? "",
        taughtOn: taught
          ? new Date(run.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long" })
          : null,
      });
    }
    return byOutput;
  }, [runs]);
}

function Bubble({
  message,
  organizationId,
  aiRun,
  agentName,
  onTeach,
}: {
  message: MessageRow;
  organizationId: string | null;
  /** The AI run behind this message, when the AI wrote it. */
  aiRun?: AiRunNote | null;
  agentName: string;
  onTeach?: (question: string, said: string) => void;
}) {
  const outbound = message.direction === "outbound";
  const text =
    message.body?.trim() ||
    (message.template_name ? `Template: ${message.template_name}` : `[${message.type}]`);
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[80%] sm:max-w-[68%]">
        <div
          className={[
            "animate-in fade-in slide-in-from-bottom-1 rounded-2xl px-3.5 py-2 text-sm shadow-sm duration-200",
            outbound
              ? "rounded-br-md bg-primary/12 text-foreground"
              : "rounded-bl-md border border-border/70 bg-card text-foreground",
          ].join(" ")}
        >
          {message.media_url ? (
            <MessageMedia message={message} organizationId={organizationId} label={text} />
          ) : null}
          <p className="whitespace-pre-wrap break-words leading-relaxed">{text}</p>
          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
            <span>{clockTime(message.created_at)}</span>
            {outbound ? <StatusTicks message={message} /> : null}
          </div>
        </div>

        {aiRun ? (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-[11px] text-muted-foreground">
            {aiRun.taughtOn ? (
              <span className="flex items-center gap-1">
                <GraduationCap className="h-3 w-3 text-primary" />
                {agentName} used something you taught him on {aiRun.taughtOn}.
              </span>
            ) : null}
            {onTeach ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors duration-200 hover:bg-muted hover:text-foreground"
                onClick={() => onTeach(aiRun.question, message.body ?? "")}
              >
                <ThumbsDown className="h-3 w-3" />
                Not right
              </button>
            ) : null}
          </div>
        ) : null}
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
  wabaId,

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
  /** Business account behind that number — scopes the template library. */
  wabaId?: string | null;

  onBack: () => void;
  onAssign: (userId: string | null) => void;
  onToggleStatus: () => void;

}) {
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assisting, setAssisting] = useState<"suggest" | "summary" | "tags" | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [proposedTags, setProposedTags] = useState<string[] | null>(null);
  const [applyingTags, setApplyingTags] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const open = withinWindow(conversation.last_customer_message_at);
  const label = contactLabel(conversation.contact);
  const { can } = usePermissions();
  const canUseAi = can("ai.use");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conversation.id]);

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
    } finally {
      setApplyingTags(false);
    }
  };


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
            {fromNumber ? <span className="opacity-70"> · via {fromNumber}</span> : null}
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
                  <Bubble message={m} organizationId={organizationId} />
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border/70 bg-card px-4 py-3">
        {canUseAi && organizationId ? (
          <div className="mx-auto mb-3 max-w-3xl space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={assisting !== null || messages.length === 0}
                onClick={() => void assist("suggest")}
              >
                {assisting === "suggest" ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="mr-2 h-3.5 w-3.5" />
                )}
                Draft a reply
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                disabled={assisting !== null || messages.length === 0}
                onClick={() => void assist("summary")}
              >
                {assisting === "summary" ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-3.5 w-3.5" />
                )}
                Catch me up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                disabled={assisting !== null || messages.length === 0}
                onClick={() => void proposeTags()}
              >
                {assisting === "tags" ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Tags className="mr-2 h-3.5 w-3.5" />
                )}
                Suggest labels
              </Button>
            </div>
            {proposedTags ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5">
                <span className="text-xs font-medium text-muted-foreground">It suggests:</span>
                {proposedTags.map((t) => (
                  <Badge key={t} variant="secondary" className="rounded-full">
                    {t}
                  </Badge>
                ))}
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    className="rounded-full"
                    disabled={applyingTags}
                    onClick={() => void applyTags()}
                  >
                    {applyingTags ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    Add them
                  </Button>
                  <Button
                    size="sm"
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
              <div className="rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5">
                <p className="text-xs font-medium text-muted-foreground">The short version</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {summary}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
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
        wabaId={wabaId ?? null}
        sending={sending}
        onSend={onSendTemplate}
      />

    </div>
  );
}
