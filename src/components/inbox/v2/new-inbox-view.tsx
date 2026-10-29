import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { ErrorState } from "@/components/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";
import { numberLabel } from "@/lib/whatsapp-numbers";
import { cn } from "@/lib/utils";
import type { ConversationRow } from "../inbox-utils";
import { ChatList } from "./chat-list";
import { ChatPane } from "./chat-pane";
import { CustomerPanel } from "./customer-panel";
import {
  MORE_VIEWS,
  TABS,
  filterChats,
  initialView,
  phonePane,
  tabLabel,
  type InboxView,
  type QuickFilter,
} from "./inbox-v2";
import { useInbox } from "./use-inbox";

/** The details panel's open/closed choice, shared with the classic Inbox. */
const DETAILS_KEY = "aidwar.inbox_details";
const PHONE = "(max-width: 700px)";
const PANEL_INLINE = "(min-width: 1280px)";

function readDetailsOpen(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** True while a media query matches (false on the server). */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setOn(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return on;
}

const pill =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden";

/**
 * Batch 46: the Inbox in the new design (docs/design/preview.html #inbox):
 * chat list | chat | customer panel. Only rendered with `new_design` on; the
 * classic InboxView is unchanged and still renders with it off.
 */
export function NewInboxView() {
  const inbox = useInbox();
  const {
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
  } = inbox;
  const { numbers } = useWhatsAppNumbers();
  const [view, setView] = useState<InboxView | null>(null);
  const [numberFilter, setNumberFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Set<QuickFilter>>(() => new Set());
  const [highlight, setHighlight] = useState(0);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(() =>
    typeof window === "undefined" ? true : readDetailsOpen(),
  );
  const [detailsSheet, setDetailsSheet] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const isPhone = useMedia(PHONE);
  const panelInline = useMedia(PANEL_INLINE);
  const roomy = useMedia("(min-width: 1001px)");

  // The first view: the waiting chats if any, else all (decided once, when the list arrives).
  useEffect(() => {
    if (view === null && !loading) setView(initialView(conversations));
  }, [view, loading, conversations]);
  const current: InboxView = view ?? "all";

  const filtered = useMemo(
    () =>
      filterChats(conversations, { view: current, userId, numberId: numberFilter, quick, search }),
    [conversations, current, userId, numberFilter, quick, search],
  );
  const waitingCount = conversations.filter((c) => c.needs_human).length;
  const numberById = useMemo(() => new Map(numbers.map((n) => [n.id, n])), [numbers]);
  const viaLabel = useCallback(
    (c: ConversationRow) =>
      numbers.length > 1 && c.whatsapp_account_id
        ? numberLabel(numberById.get(c.whatsapp_account_id))
        : null,
    [numbers.length, numberById],
  );
  const activeNumberLabel =
    numbers.length > 1 && activeConversation?.whatsapp_account_id
      ? numberLabel(numberById.get(activeConversation.whatsapp_account_id))
      : null;

  useEffect(() => {
    const i = activeId ? filtered.findIndex((c) => c.id === activeId) : -1;
    setHighlight((h) =>
      i !== -1 ? i : Math.min(Math.max(h, 0), Math.max(filtered.length - 1, 0)),
    );
  }, [activeId, filtered]);

  // On a phone an open chat is the whole screen: both bars step aside.
  useEffect(() => {
    const root = document.documentElement;
    if (activeId && isPhone) root.setAttribute("data-chat-open", "");
    else root.removeAttribute("data-chat-open");
    return () => root.removeAttribute("data-chat-open");
  }, [activeId, isPhone]);

  const toggleDetails = useCallback(() => {
    if (window.matchMedia(PANEL_INLINE).matches) {
      setDetailsOpen((o) => {
        try {
          window.localStorage.setItem(DETAILS_KEY, o ? "0" : "1");
        } catch {
          // Private mode: lasts for this page.
        }
        return !o;
      });
    } else setDetailsSheet((o) => !o);
  }, []);

  // j / k / Enter / r / e / a / "/": the classic Inbox's keys, never while typing or in a menu.
  const keyState = useRef({ filtered, highlight, activeConversation, inbox });
  keyState.current = { filtered, highlight, activeConversation, inbox };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPlainKey(e) || isTypingTarget(e.target)) return;
      const { filtered: list, highlight: h, activeConversation: conv, inbox: s } = keyState.current;
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
        void s.openConversation(target.id);
      } else if (key === "r") {
        const box = document.getElementById("inbox-composer");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      } else if (key === "e") {
        if (conv && conv.status !== "closed") {
          e.preventDefault();
          void s.handleToggleStatus();
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
  }, []);

  if (error) {
    return (
      <div className="p-4">
        <ErrorState message={error} />
      </div>
    );
  }

  const pane = phonePane(activeId);
  const toggleQuick = (q: QuickFilter) =>
    setQuick((prev) => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  const showInline = Boolean(activeConversation) && detailsOpen && panelInline;
  // The preview's columns: 300 | chat | 260 (panel from 1280px), 280 | chat to 1000px, one pane on a phone.
  const columns = isPhone
    ? "minmax(0,1fr)"
    : showInline
      ? "minmax(0,300px) minmax(0,1fr) minmax(0,260px)"
      : `minmax(0,${roomy ? 300 : 280}px) minmax(0,1fr)`;

  return (
    <div
      data-pane={pane}
      className={cn(
        "flex min-h-0 flex-1 flex-col px-[max(16px,env(safe-area-inset-left))] pb-3 wide:pb-6",
        pane === "chat" && "phone:p-0",
      )}
    >
      <h1 className="sr-only">Inbox</h1>
      <div
        className={cn(
          "mx-auto grid min-h-0 w-full max-w-[1200px] flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[18px] border border-line bg-surface shadow-xl wide:rounded-[22px]",
          pane === "chat" && "phone:rounded-none phone:border-0 phone:shadow-none",
        )}
        style={{ gridTemplateColumns: columns }}
      >
        {/* Chat list */}
        <section
          aria-label="Chats"
          className={cn(
            "flex min-h-0 min-w-0 flex-col border-line wide:border-r",
            pane === "chat" ? "phone:hidden" : "flex",
          )}
        >
          <div className="flex shrink-0 flex-col gap-2.5 px-3 pb-2 pt-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
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
                className="h-10 w-full rounded-[12px] border border-line bg-ground pl-9 pr-9 text-[0.9375rem] text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-aiden"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-surface hover:text-foreground active:bg-accent"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <Kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                  /
                </Kbd>
              )}
            </div>
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
              {TABS.map((t) => {
                const on = current === t;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={on}
                    data-tab={t}
                    onClick={() => setView(t)}
                    className={cn(
                      pill,
                      on
                        ? "bg-aiden-soft text-aiden-deep"
                        : "text-muted-foreground hover:bg-ground hover:text-foreground active:bg-accent",
                    )}
                  >
                    {tabLabel(t, aidenMode)}
                    {t === "waiting" && waitingCount > 0 ? (
                      <span className="tabular rounded-full bg-gold px-1.5 text-xs font-bold leading-5 text-gold-ink">
                        {waitingCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Quick filters"
            >
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
                      "h-7 rounded-full border px-2.5 text-[0.8125rem] font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden active:bg-accent",
                      on
                        ? "border-transparent bg-aiden-soft text-aiden-deep"
                        : "border-line text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {text}
                  </button>
                );
              })}
              <Select
                value={TABS.includes(current as never) ? "tab" : current}
                onValueChange={(v) => v !== "tab" && setView(v as InboxView)}
              >
                <SelectTrigger
                  className="ml-auto h-7 w-auto gap-1 rounded-full border-line px-2.5 text-[0.8125rem] font-semibold text-muted-foreground shadow-none"
                  aria-label="More filters"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="tab" className="hidden">
                    More filters
                  </SelectItem>
                  {MORE_VIEWS.map((v) => (
                    <SelectItem key={v.key} value={v.key}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {numbers.length > 1 ? (
                <Select value={numberFilter} onValueChange={setNumberFilter}>
                  <SelectTrigger
                    className="h-7 w-auto max-w-[10rem] rounded-full border-line px-2.5 text-[0.8125rem] font-semibold text-muted-foreground shadow-none"
                    aria-label="Number"
                  >
                    <SelectValue placeholder="All numbers" />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="all">All numbers</SelectItem>
                    {numbers.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {numberLabel(n)}
                        {n.is_default ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          </div>
          <ChatList
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
            aidenMode={aidenMode}
          />
        </section>

        {/* Chat */}
        <section
          aria-label={activeConversation ? "Chat" : "No chat open"}
          className={cn("min-h-0 min-w-0 flex-col", pane === "chat" ? "flex" : "hidden wide:flex")}
        >
          {activeConversation ? (
            <ChatPane
              conversation={activeConversation}
              messages={messages}
              members={members}
              loading={threadLoading}
              sending={sending}
              organizationId={orgId}
              userId={userId}
              aidenMode={aidenMode}
              numberLabel={activeNumberLabel}
              wabaId={
                activeConversation.whatsapp_account_id
                  ? (numberById.get(activeConversation.whatsapp_account_id)?.waba_id ?? null)
                  : null
              }
              onSend={inbox.handleSend}
              onSendTemplate={inbox.handleSendTemplate}
              onBack={() => setActiveId(null)}
              onAssign={(id) => void inbox.handleAssign(id)}
              onToggleStatus={() => void inbox.handleToggleStatus()}
              onResolveNeedsHuman={() => void inbox.handleResolveNeedsHuman()}
              onTakeover={inbox.handleTakeover}
              assignOpen={assignOpen}
              onAssignOpenChange={setAssignOpen}
              onToggleDetails={toggleDetails}
              compact={isPhone}
            />
          ) : (
            <div className="grid h-full place-items-center bg-ground bg-[radial-gradient(var(--line)_1px,transparent_1.2px)] bg-[length:20px_20px] p-8">
              <div className="max-w-xs rounded-[18px] border border-line bg-surface px-6 py-6 text-center shadow-md">
                <h2 className="m-0 font-display text-xl font-semibold">
                  {conversations.length ? "Pick a chat" : "Your chats land here"}
                </h2>
                <p className="m-0 mt-1.5 text-[0.9375rem] text-muted-foreground">
                  {conversations.length
                    ? "Open a chat on the left to read it and reply. Aiden keeps answering the rest."
                    : "When a customer writes to your WhatsApp number, the chat shows up here and Aiden can answer it."}
                </p>
                {conversations.length ? (
                  <p
                    className="m-0 mt-3 flex items-center justify-center gap-1 text-[0.8125rem] text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Kbd>J</Kbd>
                    <Kbd>K</Kbd> move, <Kbd>↵</Kbd> open, <Kbd>/</Kbd> search
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </section>

        {/* Customer panel: inline from 1280px. */}
        {showInline && activeConversation ? (
          <aside aria-label="Contact details" className="min-h-0 min-w-0 border-l border-line">
            <CustomerPanel
              conversation={activeConversation}
              members={members}
              messages={messages}
              organizationId={orgId}
              numberLabel={activeNumberLabel}
              onClose={toggleDetails}
            />
          </aside>
        ) : null}
      </div>

      {activeConversation ? (
        <Sheet open={detailsSheet && !panelInline} onOpenChange={setDetailsSheet}>
          <SheetContent
            side="right"
            className="w-[22rem] max-w-[90vw] p-0 [&>button:last-child]:hidden"
          >
            <SheetTitle className="sr-only">Contact details</SheetTitle>
            <SheetDescription className="sr-only">
              Who this customer is and where the chat stands.
            </SheetDescription>
            <CustomerPanel
              conversation={activeConversation}
              members={members}
              messages={messages}
              organizationId={orgId}
              numberLabel={activeNumberLabel}
              onClose={() => setDetailsSheet(false)}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
