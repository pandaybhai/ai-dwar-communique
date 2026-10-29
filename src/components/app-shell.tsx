import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Check,
  ChevronsUpDown,
  Keyboard,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { usePendingGapCount } from "@/hooks/use-pending-gaps";
import { useInboxCounts } from "@/hooks/use-inbox-counts";
import { cn } from "@/lib/utils";
import { isPlainKey, isTypingTarget, MOD_KEY } from "@/lib/keyboard";
import { useThemeChoice, type ThemeChoice } from "@/lib/theme";
import { CommandPalette } from "@/components/shell/command-palette";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import { groupNav, HOME_ITEM, isActivePath, useNavItems, type NavGroup, type NavItem } from "@/components/shell/use-nav";

const SIDEBAR_KEY = "aidwar.sidebar_collapsed";

/** Pages that fill the whole work area themselves (no page padding). */
const FULL_BLEED = ["/app/inbox"];

function orgInitials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-800 text-[0.6875rem] font-bold text-white shadow-xs",
        className,
      )}
    >
      {orgInitials(name)}
    </span>
  );
}

function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-lg font-bold tracking-tight text-foreground", className)}>
      Ai<span className="text-primary">Dwar</span>
    </span>
  );
}

/* ------------------------------------------------------------------ sidebar */

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { memberships, active, setActiveOrg } = useOrg();
  if (!active) return null;
  const org = active.organization;
  const body = (
    <>
      <OrgAvatar name={org.name} />
      {!collapsed ? (
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-semibold text-foreground">{org.name}</span>
          <span className="block truncate text-[0.6875rem] capitalize text-muted-foreground">{active.role}</span>
        </span>
      ) : null}
    </>
  );
  if (memberships.length < 2) {
    return (
      <div className={cn("flex h-11 items-center gap-2.5 rounded-lg px-1.5", collapsed && "justify-center px-0")} title={org.name}>
        {body}
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-11 w-full items-center gap-2.5 rounded-lg px-1.5 transition-colors hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? <span className="sr-only">{org.name}</span> : null}
          {body}
          <span className="sr-only">: switch workspace</span>
          {!collapsed ? <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="type-label text-faint">Your workspaces</DropdownMenuLabel>
        {memberships.map((m) => (
          <DropdownMenuItem key={m.organization.id} onSelect={() => setActiveOrg(m.organization.id)} className="gap-2.5">
            <OrgAvatar name={m.organization.name} className="h-6 w-6 rounded-md text-[0.625rem]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{m.organization.name}</span>
              <span className="block text-[0.6875rem] capitalize text-muted-foreground">{m.role}</span>
            </span>
            {m.organization.id === org.id ? <Check className="h-4 w-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CountBadge({ value, tone, label }: { value: number; tone: "primary" | "warning"; label: string }) {
  if (value <= 0) return null;
  return (
    <span
      title={label}
      className={cn(
        "tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[0.6875rem] font-semibold leading-none",
        tone === "primary" ? "bg-primary text-primary-foreground" : "bg-warning-soft text-warning-soft-foreground ring-1 ring-inset ring-warning-border",
      )}
    >
      <span aria-hidden="true">{value > 99 ? "99+" : value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function NavRow({
  item,
  active,
  collapsed,
  badges,
  dot,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  badges: ReactNode;
  dot: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const link = (
    <Link
      to={item.to as never}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-150",
        collapsed && "h-9 justify-center px-0",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-foreground",
      )}
    >
      <item.icon
        className={cn("h-4 w-4 shrink-0 transition-colors", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")}
        aria-hidden="true"
      />
      {collapsed ? (
        <>
          <span className="sr-only">{item.label}</span>
          {dot ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" aria-hidden="true" /> : null}
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {badges}
        </>
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function NavGroups({
  groups,
  collapsed,
  onNavigate,
}: {
  groups: NavGroup[];
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const gapCount = usePendingGapCount(orgId);
  const inbox = useInboxCounts(orgId);
  return (
    <nav aria-label="Main" className="space-y-4">
      {groups.map((g, gi) => (
        <div key={g.label ?? `group-${gi}`}>
          {g.label ? (
            collapsed ? (
              <div className="mx-2 mb-2 h-px bg-sidebar-border" aria-hidden="true" />
            ) : (
              <p className="type-label mb-1 px-2 text-faint">{g.label}</p>
            )
          ) : null}
          <div className="space-y-0.5">
            {g.items.map((item) => {
              const isInbox = item.to === "/app/inbox";
              const badges = isInbox ? (
                <span className="flex items-center gap-1">
                  <CountBadge value={inbox.waiting} tone="warning" label={`${inbox.waiting} waiting for you`} />
                  <CountBadge value={inbox.unread} tone="primary" label={`${inbox.unread} with unread messages`} />
                </span>
              ) : item.to === "/app/employee" && gapCount > 0 ? (
                <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-semibold text-success-soft-foreground">{gapCount}</span>
              ) : null;
              const dot = isInbox ? inbox.waiting + inbox.unread > 0 : item.to === "/app/employee" && gapCount > 0;
              return (
                <NavRow
                  key={item.to}
                  item={item}
                  active={isActivePath(pathname, item.to)}
                  collapsed={collapsed}
                  badges={badges}
                  dot={dot}
                  onNavigate={onNavigate}
                />
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function SidebarBody({
  groups,
  collapsed,
  onNavigate,
  onToggle,
  onShortcuts,
}: {
  groups: NavGroup[];
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
  onToggle?: () => void;
  onShortcuts: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-14 shrink-0 items-center px-2.5", collapsed && "justify-center px-2")}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 pt-2", collapsed && "px-2")}>
        <NavGroups groups={groups} collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      <div className={cn("flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2.5 py-2", collapsed && "flex-col px-2")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onShortcuts} aria-label="Keyboard shortcuts" className="text-muted-foreground">
              <Keyboard />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"}>
            Keyboard shortcuts <Kbd className="ml-1 border-transparent bg-background/15 text-background shadow-none">?</Kbd>
          </TooltipContent>
        </Tooltip>
        {!collapsed ? <Wordmark className="ml-1 flex-1 text-sm" /> : null}
        {onToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggle}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="text-muted-foreground"
              >
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side={collapsed ? "right" : "top"}>
              {collapsed ? "Expand" : "Collapse"} <Kbd className="ml-1 border-transparent bg-background/15 text-background shadow-none">[</Kbd>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ top bar */

const THEMES: Array<[ThemeChoice, string, typeof Sun]> = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
  ["system", "System", Monitor],
];

function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const { profile, active, isSuperAdmin } = useOrg();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [theme, setTheme] = useThemeChoice();
  const name = profile?.full_name?.trim() || profile?.email || "Your account";
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

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
          className="flex h-9 items-center gap-2 rounded-full p-0.5 pr-0.5 transition-colors hover:bg-accent data-[state=open]:bg-accent sm:pr-2.5"
        >
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-success-soft text-xs font-semibold text-success-soft-foreground">
            {initials || "A"}
          </span>
          <span className="sr-only">Account: </span>
          <span className="sr-only sm:not-sr-only sm:max-w-[9rem] sm:truncate sm:text-sm sm:font-medium sm:text-foreground">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
          {profile?.email ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">{profile.email}</span>
          ) : null}
          {active ? (
            <span className="mt-1 block text-xs font-normal capitalize text-muted-foreground">
              {active.role} · {active.organization.name}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/app/settings">
            <Settings className="h-4 w-4" /> Settings
          </Link>
        </DropdownMenuItem>
        {isSuperAdmin ? (
          <DropdownMenuItem asChild>
            <Link to="/admin/organizations">
              <ShieldCheck className="mr-2 h-4 w-4" /> Super Admin
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            {theme === "dark" ? <Moon className="h-4 w-4" /> : theme === "system" ? <Monitor className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
              {THEMES.map(([value, label, Icon]) => (
                <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                  <Icon className="h-4 w-4" /> {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onShortcuts}>
          <Keyboard className="h-4 w-4" /> Keyboard shortcuts
          <Kbd className="ml-auto">?</Kbd>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} disabled={signingOut}>
          {signingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({
  current,
  onMenu,
  onSearch,
  onShortcuts,
}: {
  current: { group: string | null; label: string } | null;
  onMenu: () => void;
  onSearch: () => void;
  onShortcuts: () => void;
}) {
  return (
    <header className="app-topbar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:px-4 lg:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={onMenu}>
        <Menu className="h-5 w-5" />
      </Button>
      <Link to="/app" className="lg:hidden" aria-label="AiDwar home">
        <Wordmark />
      </Link>
      {current ? (
        <p className="hidden min-w-0 items-center gap-1.5 text-sm lg:flex">
          {current.group ? (
            <>
              <span className="text-muted-foreground">{current.group}</span>
              <span className="text-faint" aria-hidden="true">
                /
              </span>
            </>
          ) : null}
          <span className="truncate font-medium text-foreground">{current.label}</span>
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-9 w-72 items-center gap-2 rounded-lg border border-input bg-card px-3 text-sm text-faint shadow-xs transition-colors hover:border-border-strong hover:text-muted-foreground md:flex xl:w-80"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <span className="flex items-center gap-0.5" aria-hidden="true">
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>K</Kbd>
          </span>
          <span className="sr-only">({MOD_KEY} K)</span>
        </button>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search" onClick={onSearch}>
          <Search className="h-5 w-5" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="hidden text-muted-foreground sm:inline-flex" aria-label="Keyboard shortcuts" onClick={onShortcuts}>
              <Keyboard />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyboard shortcuts</TooltipContent>
        </Tooltip>
        <UserMenu onShortcuts={onShortcuts} />
      </div>
    </header>
  );
}

/* ------------------------------------------------------------- plan banner */

/** "X days left" for a workspace on trial with no plan; a lock notice when locked. */
function PlanBanner() {
  const { active } = useOrg();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const org = active?.organization;
  if (!org || pathname.startsWith("/app/billing")) return null;

  if (org.plan_status === "locked" || org.plan_status === "paused") {
    return (
      <div className="shrink-0 border-b border-danger-border bg-danger-soft px-4 py-2 text-sm text-foreground sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <span className="font-semibold">This workspace is paused.</span>{" "}
            {org.plan_status === "paused"
              ? "Pay the open invoice to switch everything back on."
              : "Reactivate to switch everything back on."}
          </span>
          <Button asChild size="sm" className="rounded-full">
            <Link to="/app/billing">Reactivate</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (org.plan_version_id || org.plan_status !== "trial") return null;
  const days = org.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(org.trial_ends_at).getTime() - Date.now()) / 864e5))
    : null;
  return (
    <div className="shrink-0 border-b border-success-border bg-success-soft px-4 py-2 text-sm text-foreground sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-semibold">
            {days === null
              ? "You're on a free trial."
              : days === 0
                ? "Your free trial ends today."
                : `${days} day${days === 1 ? "" : "s"} left in your free trial.`}
          </span>{" "}
          Pick a plan and everything carries over.
        </span>
        <Button asChild size="sm" className="rounded-full">
          <Link to="/app/billing">Choose plan</Link>
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- mobile tab bar */

const TAB_PATHS = ["/app", "/app/inbox", "/app/campaigns", "/app/contacts"];

function MobileTabBar({ items, restricted, onMore }: { items: NavItem[]; restricted: boolean; onMore: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { active } = useOrg();
  const inbox = useInboxCounts(active?.organization.id ?? null);
  const all = restricted ? items : [HOME_ITEM, ...items];
  const tabs = TAB_PATHS.flatMap((p) => all.filter((i) => i.to === p)).slice(0, 4);
  return (
    <nav
      aria-label="Quick navigation"
      className="mobile-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around px-2">
        {tabs.map((t) => {
          const on = isActivePath(pathname, t.to);
          const count = t.to === "/app/inbox" ? inbox.waiting + inbox.unread : 0;
          return (
            <Link
              key={t.to}
              to={t.to as never}
              aria-current={on ? "page" : undefined}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium transition-colors",
                on ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className="relative">
                <t.icon className="h-5 w-5" aria-hidden="true" />
                {count > 0 ? (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold text-primary-foreground ring-2 ring-background">
                    {count > 99 ? "99+" : count}
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate">{t.to === "/app/inbox" ? "Inbox" : t.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          className="flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium text-muted-foreground"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          More
        </button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------- shell */

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => (typeof window === "undefined" ? false : readCollapsed()));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { items, restricted } = useNavItems();
  const groups = groupNav(items, restricted);
  const mainRef = useRef<HTMLElement | null>(null);
  const fullBleed = FULL_BLEED.some((p) => isActivePath(pathname, p));

  const current = (() => {
    for (const g of groups) {
      const hit = g.items.find((i) => isActivePath(pathname, i.to));
      if (hit) return { group: g.label, label: hit.label };
    }
    return pathname.startsWith("/app/design") ? { group: null, label: "Design system" } : null;
  })();

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1");
      } catch {
        // Private mode: lasts for this page.
      }
      return !c;
    });
  }, []);

  // Each page starts at its top (the work area scrolls, not the window).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  // ⌘K anywhere; single keys only when not typing.
  const goPrefix = useRef<number>(0);
  useEffect(() => {
    const GO: Record<string, string> = {
      h: "/app",
      i: "/app/inbox",
      c: "/app/contacts",
      m: "/app/campaigns",
      t: "/app/templates",
      s: "/app/settings",
    };
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
      if (e.key === "[") {
        e.preventDefault();
        toggleSidebar();
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
  }, [items, restricted, navigate, toggleSidebar]);

  const showShortcuts = () => setShortcutsOpen(true);

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-lg"
        >
          Skip to content
        </a>
        <aside
          aria-label="Sidebar"
          className={cn(
            "hidden shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-300 ease-in-out lg:block",
            collapsed ? "w-[60px]" : "w-60",
          )}
        >
          <SidebarBody groups={groups} collapsed={collapsed} onToggle={toggleSidebar} onShortcuts={showShortcuts} />
        </aside>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-72 bg-sidebar p-0 [&>button:last-child]:hidden">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Every page of your workspace.</SheetDescription>
            <SidebarBody
              groups={groups}
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
              onShortcuts={() => {
                setMobileOpen(false);
                showShortcuts();
              }}
            />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar current={current} onMenu={() => setMobileOpen(true)} onSearch={() => setPaletteOpen(true)} onShortcuts={showShortcuts} />
          <PlanBanner />
          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            className={cn(
              "relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus:outline-none",
              fullBleed ? "flex flex-col pb-[calc(env(safe-area-inset-bottom)+3.75rem)] lg:pb-0" : "px-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] pt-6 sm:px-6 lg:px-10 lg:pb-12 lg:pt-8",
            )}
          >
            <div key={pathname} className={cn("page-enter", fullBleed && "flex min-h-0 flex-1 flex-col")}>
              {children}
            </div>
          </main>
          <MobileTabBar items={items} restricted={restricted} onMore={() => setMobileOpen(true)} />
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          items={items}
          restricted={restricted}
          onToggleSidebar={toggleSidebar}
          onShowShortcuts={showShortcuts}
        />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </TooltipProvider>
  );
}
