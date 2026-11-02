import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PlanBanner } from "@/components/app-shell";
import { BottomSheet, sheetRowClass } from "@/components/design-v2/bottom-sheet";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useInboxCounts } from "@/hooks/use-inbox-counts";
import { usePendingGapCount } from "@/hooks/use-pending-gaps";
import { isPlainKey, isTypingTarget, MOD_KEY } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { AidenWorkspaceIntro, DesignSwitchItem, useDesignSwitch } from "./design-switch";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { isActivePath, useNavItems } from "./use-nav";
import {
  activeSection,
  activeTab,
  buildShellModel,
  type Section,
  type SectionKey,
  type ShellLink,
  type ShellModel,
} from "./sections";
import { ShellSectionContext, type ShellSectionState } from "./section-tabs";

/**
 * Batch 44: the new design's shell (docs/design/spec.md), shown only when the
 * workspace has `new_design` on — the classic sidebar (app-shell.tsx) stays
 * as it is for everyone else. Desktop: a top bar with six sections, search
 * and the avatar menu. Phone (700px and under): wordmark and avatar on top, a
 * bottom bar Home / Inbox / Campaigns / Customers / More, and More as a
 * bottom sheet. Every link comes from the sidebar's own filtered items
 * (useNavItems → buildShellModel).
 */

/** Pages that fill the work area themselves (no page padding), as in the classic shell. */
const FULL_BLEED = ["/app/inbox"];

/** The phone's bottom bar, in order; the other sections go in More. */
const BOTTOM: SectionKey[] = ["home", "inbox", "campaigns", "customers"];

const GO: Record<string, string> = {
  h: "/app",
  i: "/app/inbox",
  c: "/app/contacts",
  m: "/app/campaigns",
  t: "/app/templates",
  s: "/app/settings",
};

function personInitials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "A";
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function linkProps(l: { to: string; search?: Record<string, string> }) {
  return { to: l.to as never, search: (l.search ?? {}) as never };
}

function Wordmark() {
  return (
    <Link
      to="/app"
      aria-label="AiDwar home"
      className="rounded-md font-display text-[1.375rem] font-extrabold tracking-[-0.5px] text-foreground"
    >
      aidwar
    </Link>
  );
}

/** The gold "waiting for you" count; a quiet emerald one for unread when nobody waits. */
function InboxCount({
  waiting,
  unread,
  compact,
}: {
  waiting: number;
  unread: number;
  compact?: boolean;
}) {
  const value = waiting > 0 ? waiting : unread;
  if (value <= 0) return null;
  const label = waiting > 0 ? `${waiting} waiting for you` : `${unread} unread`;
  return (
    <span
      className={cn(
        "tabular inline-grid place-items-center rounded-full font-bold",
        waiting > 0 ? "bg-gold text-gold-ink" : "bg-aiden-soft text-aiden-deep",
        compact
          ? "absolute right-[calc(50%-24px)] top-0 h-[18px] min-w-[18px] px-[5px] text-[0.65rem]"
          : "ml-1 h-5 min-w-5 px-1.5 text-xs",
      )}
    >
      <span aria-hidden="true">{value > 99 ? "99+" : value}</span>
      <span className="sr-only">({label})</span>
    </span>
  );
}

/* ----------------------------------------------------------- desktop bar */

/** Batch 57: the one easing family (spec.md), 350ms, for every sliding highlight. */
export const PILL_MOTION = { duration: 0.35, ease: [0.2, 0.8, 0.2, 1] } as const;

function SectionNav({
  model,
  current,
  inbox,
}: {
  model: ShellModel;
  current: Section | null;
  inbox: { waiting: number; unread: number };
}) {
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-0.5">
      {model.sections.map((s) => {
        const on = current?.key === s.key;
        return (
          <Link
            key={s.key}
            {...linkProps(s)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center rounded-full px-3.5 py-2 text-[0.9375rem] font-semibold transition-[color,transform] duration-200 active:scale-[0.97]",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on ? (
              // Batch 57: the white pill slides from the last section to this one.
              <motion.span
                layoutId="nd-nav-pill"
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-surface shadow-xs"
                transition={PILL_MOTION}
              />
            ) : null}
            <span className="relative inline-flex items-center">
              {s.label}
              {s.key === "inbox" ? (
                <InboxCount waiting={inbox.waiting} unread={inbox.unread} />
              ) : null}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function AccountMenu({ model }: { model: ShellModel }) {
  const { profile, active, memberships, setActiveOrg, isSuperAdmin } = useOrg();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const name = profile?.full_name?.trim() || profile?.email || "Your account";

  async function signOut() {
    setSigningOut(true);
    await aidwar.auth.signOut();
    navigate({ to: "/login", replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // Starts with the initials it shows, so voice control matches what is seen.
          aria-label={`${personInitials(name)} (${name}), account menu`}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gold text-[0.8125rem] font-bold text-gold-ink transition-[box-shadow] duration-200 hover:shadow-sm data-[state=open]:shadow-sm"
        >
          {personInitials(name)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-60 rounded-[14px] p-2">
        <DropdownMenuLabel className="px-2.5 py-2">
          <span className="block truncate text-sm font-bold text-foreground">
            {active?.organization.name ?? name}
          </span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{name}</span>
        </DropdownMenuLabel>
        {model.account.map((l) => (
          <DropdownMenuItem key={l.key} asChild className="rounded-lg px-2.5 py-2 text-[0.9375rem]">
            <Link {...linkProps(l)}>{l.label}</Link>
          </DropdownMenuItem>
        ))}
        {model.overflow.map((l) => (
          <DropdownMenuItem key={l.key} asChild className="rounded-lg px-2.5 py-2 text-[0.9375rem]">
            <Link {...linkProps(l)}>{l.label}</Link>
          </DropdownMenuItem>
        ))}
        {memberships.length > 1 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="rounded-lg px-2.5 py-2 text-[0.9375rem]">
              Switch workspace
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-60 rounded-[14px] p-2">
              {memberships.map((m) => (
                <DropdownMenuItem
                  key={m.organization.id}
                  onSelect={() => setActiveOrg(m.organization.id)}
                  className="rounded-lg px-2.5 py-2"
                >
                  <span className="min-w-0 flex-1 truncate">{m.organization.name}</span>
                  {m.organization.id === active?.organization.id ? (
                    <Check className="h-4 w-4 text-aiden-deep" aria-label="Current workspace" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {isSuperAdmin ? (
          <DropdownMenuItem asChild className="rounded-lg px-2.5 py-2 text-[0.9375rem]">
            <Link to="/admin/organizations">Super Admin</Link>
          </DropdownMenuItem>
        ) : null}
        <DesignSwitchItem
          current="aiden_workspace"
          icon={false}
          className="rounded-lg px-2.5 py-2 text-[0.9375rem]"
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={signOut}
          disabled={signingOut}
          className="rounded-lg px-2.5 py-2 text-[0.9375rem]"
        >
          {signingOut ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({
  model,
  current,
  inbox,
  onSearch,
}: {
  model: ShellModel;
  current: Section | null;
  inbox: { waiting: number; unread: number };
  onSearch: () => void;
}) {
  return (
    <header className="app-topbar shrink-0 bg-background">
      <div className="mx-auto flex max-w-[1232px] flex-wrap items-center gap-x-5 gap-y-2 px-[max(16px,env(safe-area-inset-left))] py-4 wide:py-5">
        <Wordmark />
        <div className="hidden wide:block">
          <SectionNav model={model} current={current} inbox={inbox} />
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onSearch}
          className="hidden items-center gap-2.5 rounded-[12px] border border-line bg-surface px-3 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground wide:flex"
        >
          Search or jump
          <Kbd aria-hidden="true">{MOD_KEY === "⌘" ? "⌘K" : `${MOD_KEY} K`}</Kbd>
          <span className="sr-only">({MOD_KEY} K)</span>
        </button>
        <AccountMenu model={model} />
      </div>
    </header>
  );
}

/* --------------------------------------------------------------- phone */

const ICONS: Record<string, ReactNode> = {
  home: <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" />,
  inbox: <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12Z" />,
  campaigns: (
    <>
      <path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1Z" />
      <path d="M17 8a5 5 0 0 1 0 8" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
};

function BarIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-6 w-6 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]"
    >
      {ICONS[name]}
    </svg>
  );
}

const barItem =
  "relative flex flex-col items-center gap-0.5 rounded-[12px] py-1.5 text-[0.72rem] font-semibold transition-[background-color,color,transform] duration-200 active:scale-[0.96]";

function BottomBar({
  model,
  current,
  inbox,
  moreOpen,
  onMore,
}: {
  model: ShellModel;
  current: Section | null;
  inbox: { waiting: number; unread: number };
  moreOpen: boolean;
  onMore: () => void;
}) {
  const tabs = BOTTOM.flatMap((k) => model.sections.filter((s) => s.key === k));
  return (
    <nav
      aria-label="Main"
      className="nd-bottom-bar fixed inset-x-0 bottom-0 z-30 grid gap-1 border-t border-line bg-surface pt-2 shadow-[0_-10px_30px_-20px_var(--shadow-ink)] pb-[calc(8px+env(safe-area-inset-bottom))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] wide:hidden"
      style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}
    >
      {tabs.map((s) => {
        const on = current?.key === s.key;
        return (
          <Link
            key={s.key}
            {...linkProps(s)}
            aria-current={on ? "page" : undefined}
            className={cn(barItem, on ? "bg-aiden-soft text-aiden-deep" : "text-muted-foreground")}
          >
            <BarIcon name={s.key} />
            {s.label}
            {s.key === "inbox" ? (
              <InboxCount waiting={inbox.waiting} unread={inbox.unread} compact />
            ) : null}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        aria-expanded={moreOpen}
        aria-haspopup="dialog"
        className={cn(
          barItem,
          current && !BOTTOM.includes(current.key)
            ? "bg-aiden-soft text-aiden-deep"
            : "text-muted-foreground",
        )}
      >
        <BarIcon name="more" />
        More
      </button>
    </nav>
  );
}

function MoreSheet({
  model,
  open,
  onOpenChange,
}: {
  model: ShellModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rest = model.sections.filter((s) => !BOTTOM.includes(s.key));
  const close = () => onOpenChange(false);
  const links: ShellLink[] = [
    ...(model.assistants ? [model.assistants] : []),
    ...(model.analytics ? [model.analytics] : []),
    ...model.account,
    ...model.overflow,
  ];
  const sw = useDesignSwitch("aiden_workspace");
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title="More"
      description="Everything else in your workspace."
    >
      {rest.map((s) => (
        <Link key={s.key} {...linkProps(s)} onClick={close} className={sheetRowClass}>
          <span className="flex min-w-0 flex-col">
            <span>{s.label}</span>
            <span className="truncate text-sm text-muted-foreground">
              {s.tabs.map((t) => t.label).join(", ")}
            </span>
          </span>
        </Link>
      ))}
      {links.map((l) => (
        <Link key={l.key} {...linkProps(l)} onClick={close} className={sheetRowClass}>
          {l.label}
        </Link>
      ))}
      {sw.visible ? (
        // Batch 57 (approved preview): Classic is one tap away on a phone too —
        // the avatar menu's own switch (same run, same remembered choice).
        <button
          type="button"
          onClick={() => {
            close();
            void sw.run();
          }}
          className={cn(sheetRowClass, "mt-1 border-t border-line pt-4 text-muted-foreground")}
        >
          {sw.label}
        </button>
      ) : null}
    </BottomSheet>
  );
}

/* ----------------------------------------------------------------- shell */

export function NewAppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const navigate = useNavigate();
  const { active } = useOrg();
  const { can } = usePermissions();
  const { enabled: shopifyOn } = useFeatureFlag("shopify");
  const orgId = active?.organization.id ?? null;
  const inbox = useInboxCounts(orgId);
  const gapCount = usePendingGapCount(orgId);
  const { items, restricted } = useNavItems();
  const model = useMemo(
    () => buildShellModel(items, restricted, { shopify: shopifyOn && can("integrations.view") }),
    [items, restricted, shopifyOn, can],
  );
  const current = activeSection(model, pathname, search);
  const sectionState: ShellSectionState = {
    section: current,
    activeTab: current ? activeTab(current, pathname, search) : null,
    counts: gapCount > 0 ? { "/app/employee": gapCount } : {},
  };
  const fullBleed = FULL_BLEED.some((p) => isActivePath(pathname, p));
  const mainRef = useRef<HTMLElement | null>(null);

  // Each page starts at its top (the work area scrolls, not the window).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    setMoreOpen(false);
  }, [pathname]);

  // ⌘K anywhere; ? and g-then-a-letter only when not typing (as the classic shell).
  const goPrefix = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.defaultPrevented || !isPlainKey(e) || isTypingTarget(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      const key = e.key.toLowerCase();
      if (goPrefix.current && Date.now() - goPrefix.current < 1200 && GO[key]) {
        goPrefix.current = 0;
        const to = GO[key]!;
        const allowed = to === "/app" ? !restricted : items.some((i) => i.to === to);
        if (allowed) {
          e.preventDefault();
          void navigate({ to: to as never });
        }
        return;
      }
      goPrefix.current = key === "g" ? Date.now() : 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, restricted, navigate]);

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      {/* Batch 57: every motion component follows the person's reduced-motion setting. */}
      <MotionConfig reducedMotion="user">
        <ShellSectionContext.Provider value={sectionState}>
          <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-lg"
            >
              Skip to content
            </a>
            <TopBar
              model={model}
              current={current}
              inbox={inbox}
              onSearch={() => setPaletteOpen(true)}
            />
            <PlanBanner />
            <main
              id="main"
              ref={mainRef}
              tabIndex={-1}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus:outline-none",
                fullBleed
                  ? "flex flex-col pb-[calc(env(safe-area-inset-bottom)+4.5rem)] wide:pb-0"
                  : "pb-[calc(env(safe-area-inset-bottom)+6rem)] wide:pb-12",
              )}
            >
              <div
                key={pathname}
                className={cn(
                  "nd-view-enter",
                  fullBleed
                    ? "flex min-h-0 flex-1 flex-col"
                    : "mx-auto w-full max-w-[1232px] px-[max(16px,env(safe-area-inset-left))] pt-2 wide:pt-3",
                )}
              >
                {children}
              </div>
            </main>
            <BottomBar
              model={model}
              current={current}
              inbox={inbox}
              moreOpen={moreOpen}
              onMore={() => setMoreOpen(true)}
            />
            <MoreSheet model={model} open={moreOpen} onOpenChange={setMoreOpen} />
            <CommandPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              items={items}
              restricted={restricted}
              onToggleSidebar={() => undefined}
              onShowShortcuts={() => setShortcutsOpen(true)}
              design="new"
              sectionLabel={(to) =>
                model.sections.find((s) => s.tabs.some((t) => t.to === to))?.label ?? null
              }
            />
            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
            <AidenWorkspaceIntro />
          </div>
        </ShellSectionContext.Provider>
      </MotionConfig>
    </TooltipProvider>
  );
}
