import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox, MessagesSquare, Search } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { logActivity } from "@/lib/activity";
import { emitClientEvent } from "@/lib/events-capture";
import { callApi } from "@/lib/whatsapp-client";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  contactLabel,
  initials,
  previewText,
  relativeTime,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "./inbox-utils";

type Filter = "all" | "needs_human" | "open" | "closed" | "mine";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_human", label: "Needs you" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "mine", label: "Assigned to me" },
];

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
  const { numbers } = useWhatsAppNumbers();


  const [activeId, setActiveId] = useState<string | null>(null);
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
        "id, status, assigned_to, whatsapp_account_id, last_message_at, last_customer_message_at, unread_count, needs_human, needs_human_reason, needs_human_question, needs_human_at, handover_state, contact:contacts(id, name, phone, opt_in_status), preview:messages(body, type, direction, created_at)",
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
    setError(null);
    setConversations(rows);
    setLoading(false);
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
    const channel = aidwar
      .channel(`inbox:${orgId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${orgId}`,
        },
        (payload) => {
          const row = payload.new as MessageRow | undefined;
          void loadConversations();
          if (!row || row.conversation_id !== activeIdRef.current) return;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === row.id);
            if (idx === -1) return [...prev, row];
            const next = [...prev];
            next[idx] = { ...next[idx]!, ...row };
            return next;
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `organization_id=eq.${orgId}`,
        },
        () => void loadConversations(),
      )
      .subscribe();

    return () => {
      void aidwar.removeChannel(channel);
    };
  }, [orgId, loadConversations]);

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setThreadLoading(true);
    const { data } = await aidwar
      .from("messages")
      .select(
        "id, conversation_id, direction, type, body, media_url, media_mime, template_name, status, error_detail, sent_by, detected_language, created_at",
      )
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .limit(500);
    setMessages((data ?? []) as unknown as MessageRow[]);
    setThreadLoading(false);

    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)),
    );
    await aidwar.from("conversations").update({ unread_count: 0 }).eq("id", id);
  }, []);

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
      if (!q) return true;
      const name = (c.contact?.name ?? "").toLowerCase();
      const phone = (c.contact?.phone ?? "").toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [conversations, filter, numberFilter, search, userId]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;


  const handleSend = async (text: string): Promise<boolean> => {
    if (!orgId || !activeConversation) return false;
    setSending(true);
    const { error: sendError } = await callApi<{ message_id: string }>(
      "/api/whatsapp/send-message",
      {
        body: {
          organization_id: orgId,
          conversation_id: activeConversation.id,
          message_type: "text",
          body: text,
        },
      },
    );
    setSending(false);
    if (sendError) {
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
    const { data } = await aidwar
      .from("messages")
      .select(
        "id, conversation_id, direction, type, body, media_url, media_mime, template_name, status, error_detail, sent_by, detected_language, created_at",
      )
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .limit(500);
    setMessages((data ?? []) as unknown as MessageRow[]);
  };

  const handleAssign = async (assignee: string | null) => {
    if (!activeConversation || !orgId) return;
    const { error: err } = await aidwar
      .from("conversations")
      .update({ assigned_to: assignee })
      .eq("id", activeConversation.id);
    if (err) {
      toast.error("We couldn't update the assignment. Please try again.");
      return;
    }
    setConversations((prev) =>
      prev.map((c) => (c.id === activeConversation.id ? { ...c, assigned_to: assignee } : c)),
    );
    toast.success(assignee ? "Conversation assigned." : "Conversation unassigned.");
    void logActivity("conversation_assigned", orgId, {
      conversation_id: activeConversation.id,
      assigned_to: assignee,
    });
    emitClientEvent("conversation.assigned", orgId, {
      entityType: "conversation",
      entityId: activeConversation.id,
      whatsappAccountId: activeConversation.whatsapp_account_id ?? null,
      properties: { assigned_to: assignee },
    });
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

  if (error) return <ErrorState message={error} />;

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[520px] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      {/* Conversation list */}
      <aside
        className={[
          "flex w-full min-w-0 flex-col border-r border-border/70 lg:w-[22rem] lg:shrink-0",
          activeId ? "hidden lg:flex" : "flex",
        ].join(" ")}
      >
        <div className="space-y-3 border-b border-border/70 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone"
              className="rounded-full pl-9"
            />
          </div>
          {numbers.length > 1 ? (
            <Select value={numberFilter} onValueChange={setNumberFilter}>
              <SelectTrigger className="rounded-full">
                <SelectValue placeholder="All numbers" />
              </SelectTrigger>
              <SelectContent>
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
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={[
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200",
                  filter === f.key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70",
                ].join(" ")}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>


        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-44" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center">
              <MessagesSquare className="mx-auto h-7 w-7 text-muted-foreground/60" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {conversations.length === 0 ? "No conversations yet" : "No matches"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {conversations.length === 0
                  ? "New customer messages will appear here the moment they arrive."
                  : "Try a different search or filter."}
              </p>
            </div>
          ) : (
            <ul>
              {filtered.map((c) => {
                const label = contactLabel(c.contact);
                const assignee = members.find((m) => m.user_id === c.assigned_to);
                const selected = c.id === activeId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => void openConversation(c.id)}
                      className={[
                        "flex w-full items-center gap-3 border-b border-border/50 px-4 py-3 text-left transition-colors duration-200",
                        selected ? "bg-primary/5" : "hover:bg-muted/50",
                      ].join(" ")}
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {initials(label)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">{label}</p>
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                            {relativeTime(c.last_message_at)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <p className="truncate text-xs text-muted-foreground">
                            {previewText(c)}
                          </p>
                          {c.needs_human ? (
                            <Badge
                              variant="secondary"
                              className="ml-auto h-5 shrink-0 rounded-full px-2 text-[10px]"
                            >
                              Needs you
                            </Badge>
                          ) : null}
                          {(c.unread_count ?? 0) > 0 ? (
                            <Badge className="ml-auto h-5 shrink-0 rounded-full px-2 text-[10px]">
                              {c.unread_count}
                            </Badge>
                          ) : null}
                        </div>
                        {numbers.length > 1 && c.whatsapp_account_id ? (
                          <p className="mt-1 truncate text-[11px] text-muted-foreground/80">
                            via {numberLabel(numberById.get(c.whatsapp_account_id))}
                          </p>
                        ) : null}
                        {assignee ? (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground">
                              {initials(assignee.full_name || assignee.email || "?")}
                            </span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {assignee.full_name || assignee.email}
                            </span>
                          </div>
                        ) : null}

                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className={["min-w-0 flex-1", activeId ? "flex" : "hidden lg:flex"].join(" ")}>
        {activeConversation ? (
          <div className="w-full">
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

              numberLabel={
                numbers.length > 1 && activeConversation.whatsapp_account_id
                  ? numberLabel(numberById.get(activeConversation.whatsapp_account_id))
                  : null
              }

              onBack={() => setActiveId(null)}
              onAssign={(id) => void handleAssign(id)}
              onToggleStatus={() => void handleToggleStatus()}
              onResolveNeedsHuman={() => void handleResolveNeedsHuman()}
            />
          </div>
        ) : (
          <div className="flex w-full items-center justify-center bg-muted/30 p-8">
            <div className="max-w-sm">
              <EmptyState
                icon={Inbox}
                title="Pick a conversation"
                description="Select a chat on the left to read the full thread and reply with your team."
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
