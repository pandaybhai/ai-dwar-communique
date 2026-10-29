import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  contactLabel,
  initials,
  previewText,
  relativeTime,
  type ConversationRow,
  type MemberRow,
} from "../inbox-utils";
import { avatarTone, isAidenChat, TONE_CLASS, type AidenMode } from "./inbox-v2";

/** One fixed row height (px), so the list can window like Batch 39's. */
export const CHAT_ROW = 68;
/** Extra rows drawn above and below the visible ones, in px. */
const OVERSCAN = 600;

/** A contact's initials on one of the five avatar tones. */
export function ToneAvatar({
  seed,
  label,
  className,
}: {
  seed: string;
  label: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold",
        TONE_CLASS[avatarTone(seed)],
        className,
      )}
    >
      {initials(label)}
    </span>
  );
}

const ChatRow = memo(function ChatRow({
  c,
  assignee,
  via,
  aiden,
  selected,
  highlighted,
  onOpen,
  index,
  total,
}: {
  c: ConversationRow;
  assignee: MemberRow | null;
  via: string | null;
  aiden: boolean;
  selected: boolean;
  highlighted: boolean;
  onOpen: (id: string) => void;
  index: number;
  total: number;
}) {
  const label = contactLabel(c.contact);
  const unread = (c.unread_count ?? 0) > 0;
  const waiting = Boolean(c.needs_human);
  const assignedTo = assignee ? assignee.full_name || assignee.email || "Team member" : null;
  return (
    <li
      aria-setsize={total}
      aria-posinset={index + 1}
      className="absolute inset-x-0 px-3"
      style={{ transform: `translateY(${index * CHAT_ROW}px)`, height: CHAT_ROW }}
    >
      <button
        type="button"
        data-conversation-id={c.id}
        onClick={() => onOpen(c.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex h-16 w-full items-center gap-3 rounded-[14px] px-2.5 text-left text-foreground transition-colors duration-200",
          "hover:bg-ground active:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-aiden",
          selected && "bg-ground",
          highlighted && !selected && "outline-1 outline-offset-[-1px] outline-border-strong",
        )}
      >
        <ToneAvatar seed={c.contact?.id ?? c.id} label={label} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <b className={cn("truncate", unread ? "font-bold" : "font-semibold")}>{label}</b>
            <span
              className={cn(
                "tabular ml-auto shrink-0 text-[0.8125rem]",
                waiting ? "font-bold text-gold-ink" : "text-muted-foreground",
              )}
            >
              {relativeTime(c.last_message_at)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                unread ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {c.preview?.direction === "outbound" ? <span className="sr-only">Sent: </span> : null}
              {previewText(c)}
            </span>
            {aiden ? (
              <span className="shrink-0 rounded-full bg-aiden-soft px-2 text-xs font-semibold leading-5 text-aiden-deep">
                Aiden
              </span>
            ) : null}
            {assignedTo ? (
              <span
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-bubble-in text-[0.625rem] font-bold text-muted-foreground"
                title={`Assigned to ${assignedTo}`}
              >
                <span aria-hidden="true">{initials(assignedTo)}</span>
                <span className="sr-only">Assigned to {assignedTo}</span>
              </span>
            ) : null}
            {unread ? (
              <span className="tabular grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-aiden-deep px-1.5 text-xs font-bold text-ink-foreground">
                <span aria-hidden="true">{c.unread_count}</span>
                <span className="sr-only">{c.unread_count} unread</span>
              </span>
            ) : null}
          </span>
          {waiting || c.status === "closed" || via ? (
            <span className="sr-only">
              {waiting ? "Waiting for you. " : ""}
              {c.status === "closed" ? "Closed. " : ""}
              {via ? `Via ${via}.` : ""}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
});

/**
 * Batch 46: the new Inbox list, windowed as Batch 39's — only the rows on
 * screen (plus a margin) are drawn, so 1,000+ chats scroll smoothly.
 */
export function ChatList({
  rows,
  members,
  activeId,
  highlightIndex,
  onOpen,
  loading,
  totalLoaded,
  viaLabel,
  aidenMode,
}: {
  rows: ConversationRow[];
  members: MemberRow[];
  activeId: string | null;
  highlightIndex: number;
  onOpen: (id: string) => void;
  loading: boolean;
  totalLoaded: number;
  viaLabel: (c: ConversationRow) => string | null;
  aidenMode: AidenMode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(800);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setScrollTop(scrollRef.current?.scrollTop ?? 0);
    });
  }, []);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // Keep the keyboard's row on screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || highlightIndex < 0 || highlightIndex >= rows.length) return;
    const top = highlightIndex * CHAT_ROW;
    const bottom = top + CHAT_ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [highlightIndex, rows.length]);

  if (loading) {
    return (
      <div
        className="flex flex-col gap-1 px-3 py-1"
        aria-busy="true"
        aria-label="Loading conversations"
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex h-16 items-center gap-3 px-2.5">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-aiden-soft text-aiden-deep">
          <MessagesSquare className="h-5 w-5" aria-hidden="true" />
        </span>
        <p className="mt-4 font-semibold text-foreground">
          {totalLoaded === 0 ? "No conversations yet" : "Nothing here"}
        </p>
        <p className="mt-1 max-w-[17rem] text-sm text-muted-foreground">
          {totalLoaded === 0
            ? "New customer messages will appear here the moment they arrive."
            : "Try another tab, a different search or filter."}
        </p>
      </div>
    );
  }

  const memberById = new Map(members.map((m) => [m.user_id, m]));
  const start = Math.max(0, Math.floor((scrollTop - OVERSCAN) / CHAT_ROW));
  const end = Math.min(rows.length - 1, Math.ceil((scrollTop + viewHeight + OVERSCAN) / CHAT_ROW));
  const aidenReplies = aidenMode === "replying";
  const visible = [];
  for (let i = start; i <= end; i += 1) {
    const c = rows[i]!;
    visible.push(
      <ChatRow
        key={c.id}
        c={c}
        assignee={c.assigned_to ? (memberById.get(c.assigned_to) ?? null) : null}
        via={viaLabel(c)}
        aiden={aidenReplies && isAidenChat(c)}
        selected={c.id === activeId}
        highlighted={i === highlightIndex}
        onOpen={onOpen}
        index={i}
        total={rows.length}
      />,
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
    >
      <ul
        aria-label="Conversations"
        className="relative"
        style={{ height: rows.length * CHAT_ROW }}
      >
        {visible}
      </ul>
    </div>
  );
}
