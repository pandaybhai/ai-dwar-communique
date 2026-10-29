import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox, Search, X } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { logActivity } from "@/lib/activity";
import { emitClientEvent } from "@/lib/events-capture";
import { callApi } from "@/lib/whatsapp-client";
import { subscribeInboxChanges } from "@/lib/inbox-realtime";
import { assignConversation, sendInboxText } from "@/lib/inbox-actions";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { inboxChanged } from "@/hooks/use-inbox-counts";
import { useAppCommand } from "@/lib/app-commands";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { numberLabel } from "@/lib/whatsapp-numbers";

import { ChatThread } from "./chat-thread";
import { ContactPanel } from "./contact-panel";
import { ConversationList } from "./conversation-list";
import {
  fillTemplateText,
  templateBodyOf,
  latestThreadMessages,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "./inbox-utils";

type Filter = "all" | "needs_human" | "open" | "closed" | "mine";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_human", label: "Waiting for you" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "mine", label: "Assigned to me" },
];

/** Batch 39: quick filters on top of the tabs (on the loaded list, nothing new is read). */
type QuickFilter = "unread" | "unassigned";

const DETAILS_KEY = "aidwar.inbox_details";

function readDetailsOpen(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) !== "0";
  } catch {
    return true;
  }
}

type TemplateRow = { name: string; components: Array<Record<string, unknown>> | null };

/** name → the template's body text and sample values (first row per name wins). */
export function templateBodies(rows: TemplateRow[]): Map<string, { text: string; samples: Record<string, string> }> {
  const bodies = new Map<string, { text: string; samples: Record<string, string> }>();
  for (const t of rows) {
    const body = templateBodyOf(t.components);
    if (body && !bodies.has(t.name)) bodies.set(t.name, body);
  }
  return bodies;
}

/**
 * Template messages are stored without a body: give each one the template's
 * own text, filled with the values it was sent with — or, for one sent before
 * those were stored, the template's sample values or "...". Display only; a
 * failed read leaves the thread as it was.
 */
export async function withTemplateText(orgId: string | null | undefined, messages: MessageRow[]): Promise<MessageRow[]> {
  const names = Array.from(
    new Set(messages.filter((m) => m.type === "template" && !m.body?.trim() && m.template_name).map((m) => m.template_name!)),
  );
  if (!orgId || names.length === 0) return messages;
  try {
    const { data } = await aidwar.from("message_templates").select("name, components").eq("organization_id", orgId).in("name", names);
    const bodies = templateBodies((data ?? []) as TemplateRow[]);
    return messages.map((m) => {
      const tpl = m.type === "template" && !m.body?.trim() && m.template_name ? bodies.get(m.template_name) : undefined;
      return tpl ? { ...m, template_text: fillTemplateText(tpl.text, m.metadata, tpl.samples) } : m;
    });
  } catch {
    return messages;
  }
}

export function InboxView() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;

  const [userId, setUserId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [numberFilter, setNumberFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Set<QuickFilter>>(() => new Set());
  const { numbers } = useWhatsAppNumbers();
  // Batch 39: keyboard row (j/k), the assignee picker (a), the details panel.
  const [highlight, setHighlight] = useState(0);
  // The keyboard row is outlined only once j/k is used (not on touch or click).
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(() => (typeof window === "undefined" ? true : readDetailsOpen()));
  const [detailsSheet, setDetailsSheet] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);


  const [activeId, setActiveId] = useState<string | null>(null);

  // /app/inbox?c=<conversation id> opens that thread once it has loaded
  // (Home's "Reply" links land here) — see the effect after openConversation.
  const wantedIdRef = useRef<string | null | undefined>(undefined);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    void aidwar.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const loadConversations = useCallback(async () => {
    if (!orgId) return;
    const { data, error: err } = await aidwar
      .from("conversations")
      .select(
        "id, status, assigned_to, whatsapp_account_id, last_message_at, last_customer_message_at, unread_count, needs_human, needs_human_reason, needs_human_question, needs_human_at, handover_state, contact:contacts(id, name, phone, opt_in_status), preview:messages(body, type, direction, template_name, metadata, created_at)",
      )
      .eq("organization_id", orgId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" })
      .limit(200);

    if (err) {
      setError("We couldn't load your conversations. Please refresh.");
      setLoading(false);
      return;
    }

    const rows = ((data ?? []) as unknown[]).map((raw) => {
      const r = raw as Record<string, unknown>;
      const contact = Array.isArray(r["contact"]) ? r["contact"][0] : r["contact"];
      const preview = Array.isArray(r["preview"]) ? r["preview"][0] : r["preview"];
      return { ...r, contact: contact ?? null, preview: preview ?? null } as ConversationRow;
    });
    // Template sends are stored without a body: show the template's own text.
    const names = Array.from(
      new Set(rows.map((c) => (c.preview?.type === "template" && !c.preview.body?.trim() ? c.preview.template_name : null)).filter(Boolean) as string[]),
    );
    if (names.length) {
      const { data: tpls } = await aidwar
        .from("message_templates")
        .select("name, components")
        .eq("organization_id", orgId)
        .in("name", names);
      const bodies = templateBodies((tpls ?? []) as TemplateRow[]);
      for (const c of rows) {
        const name = c.preview?.template_name;
        const tpl = name ? bodies.get(name) : undefined;
        if (c.preview && tpl && !c.preview.body?.trim())
          c.preview = { ...c.preview, body: fillTemplateText(tpl.text, c.preview.metadata, tpl.samples) };
      }
    }
    setError(null);
    setConversations(rows);
    setLoading(false);
    inboxChanged();
  }, [orgId]);

  const loadMembers = useCallback(async () => {
    if (!orgId) return;
    const { data } = await aidwar
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgId);
    const ids = (data ?? []).map((r) => (r as { user_id: string }).user_id);
    if (ids.length === 0) return setMembers([]);
    const { data: profiles } = await aidwar
      .from("profiles")
      .select("id, full_name, email")
      .in("id", ids);
    setMembers(
      (profiles ?? []).map((p) => {
        const row = p as { id: string; full_name: string | null; email: string | null };
        return { user_id: row.id, full_name: row.full_name, email: row.email };
      }),
    );
  }, [orgId]);

  useEffect(() => {
    setLoading(true);
    void loadConversations();
    void loadMembers();
  }, [loadConversations, loadMembers]);

  // ---- realtime ----
  useEffect(() => {
    if (!orgId) return;
    return subscribeInboxChanges(`inbox:${orgId}`, orgId, {
      onMessage: (payload) => {
        const row = payload.new as MessageRow | undefined;
        void loadConversations();
        if (!row || row.conversation_id !== activeIdRef.current) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === row.id);
          if (idx === -1) {
            // Batch 39: the real row of a message shown while it was sending takes its place.
            const pending = row.direction === "outbound" ? prev.findIndex((m) => m.id.startsWith("sending-") && m.body === row.body) : -1;
            if (pending !== -1) {
              const next = [...prev];
              next[pending] = row;
              return next;
            }
            return [...prev, row];
          }
          const next = [...prev];
          next[idx] = { ...next[idx]!, ...row };
          return next;
        });
      },
      onConversation: () => void loadConversations(),
    });
  }, [orgId, loadConversations]);

  // Batch 28: the newest open wins. A slower earlier open (or the ?c= link
  // resolving late) used to overwrite the chat just clicked — the "first
  // click is ignored" after the list loads.
  const openSeq = useRef(0);
  const openConversation = useCallback(async (id: string) => {
    const seq = ++openSeq.current;
    wantedIdRef.current = null; // a click beats the ?c= link
    setActiveId(id);
    setThreadLoading(true);
    const rows = await withTemplateText(orgId, await latestThreadMessages(aidwar as never, id));
    if (seq !== openSeq.current) return;
    setMessages(rows);
    setThreadLoading(false);

    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)),
    );
    await aidwar.from("conversations").update({ unread_count: 0 }).eq("id", id);
  }, [orgId]);

  // ?c=<id>: opened like a click (messages loaded) once the list has it —
  // unless someone already clicked a chat.
  useEffect(() => {
    if (wantedIdRef.current === undefined) {
      wantedIdRef.current = new URLSearchParams(window.location.search).get("c");
    }
    const wanted = wantedIdRef.current;
    if (wanted && conversations.some((c) => c.id === wanted)) {
      wantedIdRef.current = null;
      if (activeIdRef.current === null) void openConversation(wanted);
    }
  }, [conversations, openConversation]);

  // Batch 39: the command palette's "jump to a chat" (the ?c= link covers a fresh Inbox).
  useAppCommand("open-conversation", ({ id }) => {
    if (conversations.some((c) => c.id === id)) void openConversation(id);
    else wantedIdRef.current = id;
  });

  const numberById = useMemo(
    () => new Map(numbers.map((n) => [n.id, n])),
    [numbers],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (filter === "needs_human" && !c.needs_human) return false;
      if (filter === "open" && c.status !== "open") return false;
      if (filter === "closed" && c.status !== "closed") return false;
      if (filter === "mine" && c.assigned_to !== userId) return false;
      if (numberFilter !== "all" && c.whatsapp_account_id !== numberFilter) return false;
      if (quick.has("unread") && !((c.unread_count ?? 0) > 0)) return false;
      if (quick.has("unassigned") && c.assigned_to) return false;
      if (!q) return true;
      const name = (c.contact?.name ?? "").toLowerCase();
      const phone = (c.contact?.phone ?? "").toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [conversations, filter, numberFilter, search, userId, quick]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;


  const handleSend = async (text: string): Promise<boolean> => {
    if (!orgId || !activeConversation) return false;
    setSending(true);
    // Batch 39: the message shows in the chat (with a clock) while it sends.
    const pendingId = `sending-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: pendingId,
        conversation_id: activeConversation.id,
        direction: "outbound",
        type: "text",
        body: text,
        media_url: null,
        media_mime: null,
        template_name: null,
        status: "pending",
        error_detail: null,
        sent_by: userId,
        created_at: new Date().toISOString(),
      },
    ]);
    const { error: sendError } = await sendInboxText(orgId, activeConversation.id, text);
    setSending(false);
    if (sendError) {
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      toast.error(sendError);
      return false;
    }
    await Promise.all([openRefresh(activeConversation.id), loadConversations()]);
    return true;
  };

  const handleSendTemplate = async (payload: {
    template_name: string;
    template_language: string;
    template_components: Array<Record<string, unknown>>;
  }): Promise<boolean> => {
    if (!orgId || !activeConversation) return false;
    setSending(true);
    const { error: sendError } = await callApi<{ message_id: string }>(
      "/api/whatsapp/send-message",
      {
        body: {
          organization_id: orgId,
          conversation_id: activeConversation.id,
          message_type: "template",
          ...payload,
        },
      },
    );
    setSending(false);
    if (sendError) {
      toast.error(sendError);
      return false;
    }
    toast.success("Template sent.");
    await Promise.all([openRefresh(activeConversation.id), loadConversations()]);
    return true;
  };

  const openRefresh = async (id: string) => {
    const rows = await withTemplateText(orgId, await latestThreadMessages(aidwar as never, id));
    if (activeIdRef.current === id) setMessages(rows);
  };

  const handleAssign = async (assignee: string | null) => {
    if (!activeConversation || !orgId) return;
    const saved = await assignConversation(orgId, activeConversation, assignee);
    if (!saved) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === activeConversation.id ? { ...c, assigned_to: assignee } : c)),
    );
  };

  const handleResolveNeedsHuman = async () => {
    if (!activeConversation) return;
    const { error: err } = await aidwar
      .from("conversations")
      .update({ needs_human: false, needs_human_reason: null, handover_state: null })
      .eq("id", activeConversation.id);
    if (err) {
      toast.error("We couldn't clear this. Please try again.");
      return;
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? { ...c, needs_human: false, needs_human_reason: null, handover_state: null }
          : c,
      ),
    );
    toast.success("Marked as handled.");
  };

  const handleToggleStatus = async () => {
    if (!activeConversation || !orgId) return;
    const next = activeConversation.status === "closed" ? "open" : "closed";
    const { error: err } = await aidwar
      .from("conversations")
      .update({ status: next })
      .eq("id", activeConversation.id);
    if (err) {
      toast.error("We couldn't update this conversation. Please try again.");
      return;
    }
    setConversations((prev) =>
      prev.map((c) => (c.id === activeConversation.id ? { ...c, status: next } : c)),
    );
    toast.success(next === "closed" ? "Conversation closed." : "Conversation reopened.");
    if (next === "closed") {
      void logActivity("conversation_closed", orgId, { conversation_id: activeConversation.id });
      emitClientEvent("conversation.closed", orgId, {
        entityType: "conversation",
        entityId: activeConversation.id,
        whatsappAccountId: activeConversation.whatsapp_account_id ?? null,
      });
    }
  };

  // Batch 39: the keyboard row follows the open chat and stays inside the list.
  useEffect(() => {
    const i = activeId ? filtered.findIndex((c) => c.id === activeId) : -1;
    setHighlight((h) => (i !== -1 ? i : Math.min(Math.max(h, 0), Math.max(filtered.length - 1, 0))));
  }, [activeId, filtered]);

  // On a phone the tab bar steps aside while a chat is open.
  useEffect(() => {
    const root = document.documentElement;
    if (activeId) root.setAttribute("data-chat-open", "");
    else root.removeAttribute("data-chat-open");
    return () => root.removeAttribute("data-chat-open");
  }, [activeId]);

  const toggleDetails = useCallback(() => {
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setDetailsOpen((open) => {
        try {
          window.localStorage.setItem(DETAILS_KEY, open ? "0" : "1");
        } catch {
          // Private mode: lasts for this page.
        }
        return !open;
      });
    } else {
      setDetailsSheet((open) => !open);
    }
  }, []);

  // j / k / Enter / r / e / a / "/" — never while typing or in a menu.
  const keyState = useRef({ filtered, highlight, activeConversation });
  keyState.current = { filtered, highlight, activeConversation };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPlainKey(e) || isTypingTarget(e.target)) return;
      const { filtered: list, highlight: h, activeConversation: conv } = keyState.current;
      const key = e.key;
      if (key === "j" || key === "k") {
        if (!list.length) return;
        e.preventDefault();
        setKeyboardNav(true);
        setHighlight(Math.min(list.length - 1, Math.max(0, h + (key === "j" ? 1 : -1))));
      } else if (key === "Enter") {
        const target = list[h];
        const el = e.target as HTMLElement | null;
        if (!target || (el && el.closest("button, a, [role=button]"))) return;
        e.preventDefault();
        void openConversation(target.id);
      } else if (key === "r") {
        const box = document.getElementById("inbox-composer");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      } else if (key === "e") {
        if (conv && conv.status !== "closed") {
          e.preventDefault();
          void handleToggleStatus();
        }
      } else if (key === "a") {
        if (conv) {
          e.preventDefault();
          setAssignOpen(true);
        }
      } else if (key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const viaLabel = useCallback(
    (c: ConversationRow) =>
      numbers.length > 1 && c.whatsapp_account_id ? numberLabel(numberById.get(c.whatsapp_account_id)) : null,
    [numbers.length, numberById],
  );

  if (error) return <div className="p-4 sm:p-6"><ErrorState message={error} /></div>;

  const waitingCount = conversations.filter((c) => c.needs_human).length;
  const toggleQuick = (q: QuickFilter) =>
    setQuick((prev) => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  const activeNumberLabel =
    numbers.length > 1 && activeConversation?.whatsapp_account_id
      ? numberLabel(numberById.get(activeConversation.whatsapp_account_id))
      : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-card">
      {/* Conversation list */}
      <aside
        aria-label="Conversations"
        className={cn(
          "flex w-full min-w-0 flex-col border-r border-border bg-card lg:w-[22rem] lg:shrink-0 xl:w-[24.5rem]",
          activeId ? "hidden lg:flex" : "flex",
        )}
      >
        <div className="shrink-0 space-y-3 px-4 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <h1 className="type-title text-foreground">Inbox</h1>
            {!loading ? (
              <span className="tabular rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {filtered.length}
              </span>
            ) : null}
            {numbers.length > 1 ? (
              <Select value={numberFilter} onValueChange={setNumberFilter}>
                <SelectTrigger className="ml-auto h-8 w-auto max-w-[11rem] rounded-full text-xs" aria-label="Number">
                  <SelectValue placeholder="All numbers" />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="all">All numbers</SelectItem>
                  {numbers.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {numberLabel(n)}
                      {n.is_default ? " · Default" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (search) setSearch("");
                  else e.currentTarget.blur();
                }
                if (e.key === "Enter" && filtered[0]) {
                  e.preventDefault();
                  void openConversation(filtered[0].id);
                  e.currentTarget.blur();
                }
              }}
              placeholder="Search name or phone"
              aria-label="Search name or phone"
              className="h-9 rounded-lg bg-subtle pl-9 pr-9 shadow-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <Kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">/</Kbd>
            )}
          </div>
        </div>

        <div className="shrink-0 border-b border-border px-2">
          <div
            role="group"
            aria-label="Show"
            className="-mb-px flex gap-0.5 overflow-x-auto px-2 [scrollbar-width:none] max-lg:[mask-image:linear-gradient(to_right,black_88%,transparent)]"
          >
            {FILTERS.map((f) => {
              const on = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5 pb-2.5 pt-1 text-[0.8125rem] font-medium transition-colors",
                    on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                  {f.key === "needs_human" && waitingCount > 0 ? (
                    <span className="tabular rounded-full bg-warning-soft px-1.5 text-[0.6875rem] font-semibold text-warning-soft-foreground">
                      {waitingCount}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-primary transition-opacity",
                      on ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 px-4 py-2" role="group" aria-label="Quick filters">
          {(
            [
              ["unread", "Unread"],
              ["unassigned", "Unassigned"],
            ] as Array<[QuickFilter, string]>
          ).map(([key, text]) => {
            const on = quick.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => toggleQuick(key)}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors",
                  on
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                {text}
              </button>
            );
          })}
          <span className="ml-auto hidden items-center gap-1 text-[0.6875rem] text-faint xl:flex" aria-hidden="true">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> to move
          </span>
        </div>

        <ConversationList
          rows={filtered}
          members={members}
          activeId={activeId}
          highlightIndex={keyboardNav ? highlight : -1}
          onOpen={(id) => {
            setKeyboardNav(false);
            void openConversation(id);
          }}
          loading={loading}
          totalLoaded={conversations.length}
          viaLabel={viaLabel}
        />
      </aside>

      {/* Thread */}
      <section aria-label="Conversation" className={cn("min-w-0 flex-1", activeId ? "flex" : "hidden lg:flex")}>
        {activeConversation ? (
          <div className="flex w-full min-w-0">
            <div className="min-w-0 flex-1">
              <ChatThread
                conversation={activeConversation}
                messages={messages}
                members={members}
                loading={threadLoading}
                sending={sending}
                onSend={handleSend}
                onSendTemplate={handleSendTemplate}
                organizationId={orgId}
                wabaId={
                  activeConversation.whatsapp_account_id
                    ? (numberById.get(activeConversation.whatsapp_account_id)?.waba_id ?? null)
                    : null
                }

                numberLabel={activeNumberLabel}

                onBack={() => setActiveId(null)}
                onAssign={(id) => void handleAssign(id)}
                onToggleStatus={() => void handleToggleStatus()}
                onResolveNeedsHuman={() => void handleResolveNeedsHuman()}
                assignOpen={assignOpen}
                onAssignOpenChange={setAssignOpen}
                detailsOpen={detailsOpen}
                onToggleDetails={toggleDetails}
              />
            </div>
            {detailsOpen ? (
              <aside aria-label="Contact details" className="hidden w-[18.5rem] shrink-0 border-l border-border xl:block">
                <ContactPanel
                  conversation={activeConversation}
                  members={members}
                  messages={messages}
                  organizationId={orgId}
                  numberLabel={activeNumberLabel}
                  onClose={toggleDetails}
                />
              </aside>
            ) : null}
            <Sheet open={detailsSheet} onOpenChange={setDetailsSheet}>
              <SheetContent side="right" className="w-[22rem] max-w-[90vw] p-0 [&>button:last-child]:hidden">
                <SheetTitle className="sr-only">Contact details</SheetTitle>
                <SheetDescription className="sr-only">Who this customer is and where the conversation stands.</SheetDescription>
                <ContactPanel
                  conversation={activeConversation}
                  members={members}
                  messages={messages}
                  organizationId={orgId}
                  numberLabel={activeNumberLabel}
                  onClose={() => setDetailsSheet(false)}
                />
              </SheetContent>
            </Sheet>
          </div>
        ) : (
          <div className="wa-wall flex w-full items-center justify-center p-8">
            <div className="max-w-sm rounded-2xl border border-border bg-card/95 shadow-sm backdrop-blur">
              <EmptyState
                variant="plain"
                icon={Inbox}
                title="Pick a conversation"
                description="Select a chat on the left to read the full thread and reply with your team."
              />
              <p className={cn("-mt-6 items-center justify-center gap-1.5 pb-6 text-xs text-faint", conversations.length ? "flex" : "hidden")}>
                <Kbd>J</Kbd>
                <Kbd>K</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>/</Kbd> search
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
