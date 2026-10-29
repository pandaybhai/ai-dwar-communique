import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { logActivity } from "@/lib/activity";
import { emitClientEvent } from "@/lib/events-capture";
import { callApi } from "@/lib/whatsapp-client";
import { inboxChanged } from "@/hooks/use-inbox-counts";
import { useAppCommand } from "@/lib/app-commands";
import type { TemplateSendPayload } from "@/components/templates/template-picker-dialog";
import { templateBodies, withTemplateText } from "../inbox-view";
import {
  fillTemplateText,
  latestThreadMessages,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "../inbox-utils";
import { takeoverPlan, type AidenMode } from "./inbox-v2";

type TemplateRow = { name: string; components: Array<Record<string, unknown>> | null };

/** The conversation list's columns: the classic Inbox's read, unchanged. */
export const CONVERSATION_COLUMNS =
  "id, status, assigned_to, whatsapp_account_id, last_message_at, last_customer_message_at, unread_count, needs_human, needs_human_reason, needs_human_question, needs_human_at, handover_state, contact:contacts(id, name, phone, opt_in_status), preview:messages(body, type, direction, template_name, metadata, created_at)";

/**
 * Batch 46: the new Inbox's data. The same reads, realtime channel and writes
 * as the classic InboxView (inbox-view.tsx, left untouched so the flag-off
 * Inbox stays exactly as it was); Batch 50 drops the classic copy. Adds one
 * read: Aiden's workspace mode, so the list only says "Aiden on it" when
 * Aiden replies.
 */
export function useInbox() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;

  const [userId, setUserId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aidenMode, setAidenMode] = useState<AidenMode>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
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
      .select(CONVERSATION_COLUMNS)
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
    const names = Array.from(
      new Set(
        rows
          .map((c) => (c.preview?.type === "template" && !c.preview.body?.trim() ? c.preview.template_name : null))
          .filter(Boolean) as string[],
      ),
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
    const { data } = await aidwar.from("organization_members").select("user_id").eq("organization_id", orgId);
    const ids = (data ?? []).map((r) => (r as { user_id: string }).user_id);
    if (ids.length === 0) return setMembers([]);
    const { data: profiles } = await aidwar.from("profiles").select("id, full_name, email").in("id", ids);
    setMembers(
      (profiles ?? []).map((p) => {
        const row = p as { id: string; full_name: string | null; email: string | null };
        return { user_id: row.id, full_name: row.full_name, email: row.email };
      }),
    );
  }, [orgId]);

  // Aiden's mode (the same read the flow editor makes); a failed read says nothing.
  useEffect(() => {
    if (!orgId) return;
    let live = true;
    void Promise.resolve(
      aidwar.from("ai_agents").select("mode").eq("organization_id", orgId).eq("is_default", true).maybeSingle(),
    )
      .then(({ data, error: err }) => {
        if (!live || err) return;
        const mode = (data as { mode?: string } | null)?.mode;
        setAidenMode(mode === "off" || mode === "draft" || mode === "replying" ? mode : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId]);

  useEffect(() => {
    setLoading(true);
    void loadConversations();
    void loadMembers();
  }, [loadConversations, loadMembers]);

  // ---- realtime (the classic Inbox's channel and handling) ----
  useEffect(() => {
    if (!orgId) return;
    const channel = aidwar
      .channel(`inbox:${orgId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `organization_id=eq.${orgId}` },
        (payload) => {
          const row = payload.new as MessageRow | undefined;
          void loadConversations();
          if (!row || row.conversation_id !== activeIdRef.current) return;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === row.id);
            if (idx === -1) {
              const pending =
                row.direction === "outbound"
                  ? prev.findIndex((m) => m.id.startsWith("sending-") && m.body === row.body)
                  : -1;
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
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `organization_id=eq.${orgId}` },
        () => void loadConversations(),
      )
      .subscribe();
    return () => {
      void aidwar.removeChannel(channel);
    };
  }, [orgId, loadConversations]);

  // The newest open wins (Batch 28).
  const openSeq = useRef(0);
  const openConversation = useCallback(
    async (id: string) => {
      const seq = ++openSeq.current;
      wantedIdRef.current = null;
      setActiveId(id);
      setThreadLoading(true);
      const rows = await withTemplateText(orgId, await latestThreadMessages(aidwar as never, id));
      if (seq !== openSeq.current) return;
      setMessages(rows);
      setThreadLoading(false);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)));
      await aidwar.from("conversations").update({ unread_count: 0 }).eq("id", id);
    },
    [orgId],
  );

  // ?c=<id> (Home's "Reply" links), opened once the list has it.
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

  useAppCommand("open-conversation", ({ id }) => {
    if (conversations.some((c) => c.id === id)) void openConversation(id);
    else wantedIdRef.current = id;
  });

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;

  const openRefresh = async (id: string) => {
    const rows = await withTemplateText(orgId, await latestThreadMessages(aidwar as never, id));
    if (activeIdRef.current === id) setMessages(rows);
  };

  const handleSend = async (text: string): Promise<boolean> => {
    if (!orgId || !activeConversation) return false;
    setSending(true);
    // Shown in the chat (with a clock) while it sends, as in Batch 39.
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
    const { error: sendError } = await callApi<{ message_id: string }>("/api/whatsapp/send-message", {
      body: {
        organization_id: orgId,
        conversation_id: activeConversation.id,
        message_type: "text",
        body: text,
      },
    });
    setSending(false);
    if (sendError) {
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      toast.error(sendError);
      return false;
    }
    await Promise.all([openRefresh(activeConversation.id), loadConversations()]);
    return true;
  };

  const handleSendTemplate = async (payload: TemplateSendPayload): Promise<boolean> => {
    if (!orgId || !activeConversation) return false;
    setSending(true);
    const { error: sendError } = await callApi<{ message_id: string }>("/api/whatsapp/send-message", {
      body: {
        organization_id: orgId,
        conversation_id: activeConversation.id,
        message_type: "template",
        ...payload,
      },
    });
    setSending(false);
    if (sendError) {
      toast.error(sendError);
      return false;
    }
    toast.success("Template sent.");
    await Promise.all([openRefresh(activeConversation.id), loadConversations()]);
    return true;
  };

  /** The classic assign write (and its activity + event); `said` replaces the toast. */
  const handleAssign = async (assignee: string | null, said?: string | null): Promise<boolean> => {
    if (!activeConversation || !orgId) return false;
    const { error: err } = await aidwar
      .from("conversations")
      .update({ assigned_to: assignee })
      .eq("id", activeConversation.id);
    if (err) {
      toast.error("We couldn't update the assignment. Please try again.");
      return false;
    }
    setConversations((prev) =>
      prev.map((c) => (c.id === activeConversation.id ? { ...c, assigned_to: assignee } : c)),
    );
    if (said !== null) toast.success(said ?? (assignee ? "Conversation assigned." : "Conversation unassigned."));
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
    return true;
  };

  /** The classic "Mark as handled" write; `said` replaces the toast. */
  const handleResolveNeedsHuman = async (said?: string | null): Promise<boolean> => {
    if (!activeConversation) return false;
    const { error: err } = await aidwar
      .from("conversations")
      .update({ needs_human: false, needs_human_reason: null, handover_state: null })
      .eq("id", activeConversation.id);
    if (err) {
      toast.error("We couldn't clear this. Please try again.");
      return false;
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? { ...c, needs_human: false, needs_human_reason: null, handover_state: null }
          : c,
      ),
    );
    if (said !== null) toast.success(said ?? "Marked as handled.");
    return true;
  };

  /** Take over from Aiden / hand back: only the two classic writes above (takeoverPlan). */
  const handleTakeover = async (): Promise<void> => {
    if (!activeConversation) return;
    const plan = takeoverPlan(activeConversation, userId);
    if (!plan) return;
    if (plan.action === "take_over") {
      await handleAssign(userId, "You took over. Aiden won't reply in this chat until you hand it back.");
      return;
    }
    let ok = true;
    for (const write of plan.writes) {
      if ("assigned_to" in write) ok = (await handleAssign(null, null)) && ok;
      else ok = (await handleResolveNeedsHuman(null)) && ok;
      if (!ok) return;
    }
    toast.success("Aiden is back on this chat.");
  };

  const handleToggleStatus = async () => {
    if (!activeConversation || !orgId) return;
    const next = activeConversation.status === "closed" ? "open" : "closed";
    const { error: err } = await aidwar.from("conversations").update({ status: next }).eq("id", activeConversation.id);
    if (err) {
      toast.error("We couldn't update this conversation. Please try again.");
      return;
    }
    setConversations((prev) => prev.map((c) => (c.id === activeConversation.id ? { ...c, status: next } : c)));
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

  return {
    orgId,
    userId,
    conversations,
    members,
    loading,
    error,
    aidenMode,
    activeId,
    setActiveId,
    activeConversation,
    messages,
    threadLoading,
    sending,
    openConversation,
    handleSend,
    handleSendTemplate,
    handleAssign,
    handleResolveNeedsHuman,
    handleTakeover,
    handleToggleStatus,
  };
}

export type InboxState = ReturnType<typeof useInbox>;
