import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, MessagesSquare } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "./contact-avatar";
import {
  contactLabel,
  initials,
  previewText,
  relativeTime,
  type ConversationRow,
  type MemberRow,
} from "./inbox-utils";

/** Row heights (px): a row with a chip line is taller. Fixed, so the list can window. */
const ROW = 68;
const ROW_WITH_META = 90;
/** Extra rows drawn above and below the visible ones, in px. */
const OVERSCAN = 600;

type RowMeta = {
  assignee: MemberRow | null;
  via: string | null;
  hasMeta: boolean;
};

const ConversationRowView = memo(function ConversationRowView({
  c,
  meta,
  selected,
  highlighted,
  onOpen,
  top,
  height,
  index,
  total,
}: {
  c: ConversationRow;
  meta: RowMeta;
  selected: boolean;
  highlighted: boolean;
  onOpen: (id: string) => void;
  top: number;
  height: number;
  index: number;
  total: number;
}) {
  const label = contactLabel(c.contact);
  const unread = (c.unread_count ?? 0) > 0;
  const outbound = c.preview?.direction === "outbound";
  return (
    <li
      aria-setsize={total}
      aria-posinset={index + 1}
      className="absolute inset-x-0 px-2"
      style={{ transform: `translateY(${top}px)`, height }}
    >
      <button
        type="button"
        data-conversation-id={c.id}
        onClick={() => onOpen(c.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group relative flex h-[calc(100%-2px)] w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-100",
          selected ? "bg-accent" : "hover:bg-accent/60",
          highlighted && !selected && "ring-1 ring-inset ring-border-strong",
        )}
      >
        {selected ? (
          <span
            className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary"
            aria-hidden="true"
          />
        ) : null}
        <span className="relative mt-0.5">
          <ContactAvatar seed={c.contact?.id ?? c.id} label={label} />
          {c.needs_human ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-warning ring-2 ring-card"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "truncate text-sm text-foreground",
                unread ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </span>
            <span
              className={cn(
                "tabular ml-auto shrink-0 text-[0.6875rem]",
                unread ? "font-semibold text-primary" : "text-faint",
              )}
            >
              {relativeTime(c.last_message_at)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[0.8125rem]",
                unread ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {outbound ? (
                <>
                  <CheckCheck className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
                  <span className="sr-only">Sent:</span>
                </>
              ) : null}
              <span className="truncate">{previewText(c)}</span>
            </span>
            {unread ? (
              <span className="tabular ml-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold text-primary-foreground">
                <span aria-hidden="true">{c.unread_count}</span>
                <span className="sr-only">{c.unread_count} unread</span>
              </span>
            ) : null}
          </span>
          {meta.hasMeta ? (
            <span className="mt-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden">
              {c.needs_human ? (
                <span className="shrink-0 rounded-full border border-warning-border bg-warning-soft px-1.5 py-px text-[0.6875rem] font-medium text-warning-soft-foreground">
                  Waiting for you
                </span>
              ) : null}
              {c.status === "closed" ? (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[0.6875rem] font-medium text-muted-foreground">
                  Closed
                </span>
              ) : null}
              {meta.via ? (
                <span className="min-w-0 shrink truncate text-[0.6875rem] text-faint">
                  via {meta.via}
                </span>
              ) : null}
              {meta.assignee ? (
                <span className="ml-auto flex min-w-0 shrink items-center gap-1 text-[0.6875rem] text-muted-foreground">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[0.5rem] font-semibold">
                    {initials(meta.assignee.full_name || meta.assignee.email || "?")}
                  </span>
                  <span className="truncate">{meta.assignee.full_name || meta.assignee.email}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
});

/**
 * Batch 39: the Inbox list, windowed — only the rows on screen (plus a margin)
 * are drawn, so 1,000+ conversations scroll smoothly.
 */
export function ConversationList({
  rows,
  members,
  activeId,
  highlightIndex,
  onOpen,
  loading,
  totalLoaded,
  viaLabel,
}: {
  rows: ConversationRow[];
  members: MemberRow[];
  activeId: string | null;
  highlightIndex: number;
  onOpen: (id: string) => void;
  loading: boolean;
  totalLoaded: number;
  /** "via <number>" for a row, when the workspace has several numbers. */
  viaLabel: (c: ConversationRow) => string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(800);
  const frame = useRef<number | null>(null);

  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);
  const metas = useMemo(
    () =>
      rows.map((c): RowMeta => {
        const assignee = c.assigned_to ? (memberById.get(c.assigned_to) ?? null) : null;
        const via = viaLabel(c);
        return {
          assignee,
          via,
          hasMeta: Boolean(c.needs_human || c.status === "closed" || assignee || via),
        };
      }),
    [rows, memberById, viaLabel],
  );
  const offsets = useMemo(() => {
    const out = [0];
    for (const m of metas) out.push(out[out.length - 1]! + (m.hasMeta ? ROW_WITH_META : ROW));
    return out;
  }, [metas]);
  const total = offsets[offsets.length - 1]!;

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
    const top = offsets[highlightIndex]!;
    const bottom = offsets[highlightIndex + 1]!;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [highlightIndex, offsets, rows.length]);

  // The first row at or above a pixel offset (binary search).
  const indexAt = (y: number) => {
    let lo = 0;
    let hi = rows.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! <= y) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };

  if (loading) {
    return (
      <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading conversations">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-3">
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
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-card shadow-xs">
          <MessagesSquare className="h-5 w-5 text-primary" aria-hidden="true" />
        </div>
        <p className="mt-4 text-sm font-semibold text-foreground">
          {totalLoaded === 0 ? "No conversations yet" : "No matches"}
        </p>
        <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
          {totalLoaded === 0
            ? "New customer messages will appear here the moment they arrive."
            : "Try a different search or filter."}
        </p>
      </div>
    );
  }

  const start = indexAt(Math.max(0, scrollTop - OVERSCAN));
  const end = Math.min(rows.length - 1, indexAt(scrollTop + viewHeight + OVERSCAN));
  const visible = [];
  for (let i = start; i <= end; i += 1) {
    const c = rows[i]!;
    visible.push(
      <ConversationRowView
        key={c.id}
        c={c}
        meta={metas[i]!}
        selected={c.id === activeId}
        highlighted={i === highlightIndex}
        onOpen={onOpen}
        top={offsets[i]!}
        height={offsets[i + 1]! - offsets[i]!}
        index={i}
        total={rows.length}
      />,
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
    >
      <ul aria-label="Conversations" className="relative" style={{ height: total }}>
        {visible}
      </ul>
    </div>
  );
}
