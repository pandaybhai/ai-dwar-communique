import type { LucideIcon } from "lucide-react";
import { Bot, Home, Megaphone, MessageCircle, ShoppingBag, Users } from "lucide-react";
import { isActivePath, type NavItem } from "./use-nav";

/**
 * Batch 44: the new shell's map (docs/design/spec.md, "Sections and
 * sub-tabs"). Presentation only, like GROUPS in use-nav.ts: every link here
 * comes from the items the sidebar would show (filterNavItems), so flags and
 * permissions filter the new shell exactly as they filter the sidebar. A
 * registry page this map doesn't know lands in `overflow` (avatar menu and
 * the phone's More sheet), so a new feature always shows up somewhere.
 */

export type SectionKey = "home" | "inbox" | "campaigns" | "customers" | "automate" | "shop";

export type ShellLink = {
  key: string;
  to: string;
  label: string;
  /** Search params the link sets (e.g. { tab: "segments" }). */
  search?: Record<string, string>;
};

export type SectionTab = ShellLink & {
  /**
   * A tab that opens another page (Shop → Shopify opens Settings →
   * Integrations): it never claims the active state.
   */
  jump?: boolean;
};

export type Section = {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  /** Where the section's own nav item goes: its first tab. */
  to: string;
  search?: Record<string, string>;
  tabs: SectionTab[];
  /** Pages that belong to the section without a tab of their own. */
  owns: string[];
};

export type ShellModel = {
  sections: Section[];
  /** Avatar menu (and the More sheet): Settings, Billing and wallet, Team. */
  account: ShellLink[];
  /** Analytics: Home's "See all numbers", ⌘K and the More sheet. */
  analytics: ShellLink | null;
  /** Registry pages the map doesn't place yet. */
  overflow: ShellLink[];
};

export type ShellExtras = {
  /** Shopify switched on and integrations.view: Shop gets a Shopify tab. */
  shopify: boolean;
};

type TabDef = {
  to: string;
  label: string;
  search?: Record<string, string>;
  /** The sidebar item that must be visible for this tab (default: `to`). */
  requires?: string;
  extra?: keyof ShellExtras;
  jump?: boolean;
};

const SECTION_DEFS: Array<{
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  tabs: TabDef[];
  owns?: string[];
}> = [
  { key: "home", label: "Home", icon: Home, tabs: [], owns: ["/app/analytics"] },
  {
    key: "inbox",
    label: "Inbox",
    icon: MessageCircle,
    tabs: [{ to: "/app/inbox", label: "Inbox" }],
  },
  {
    key: "campaigns",
    label: "Campaigns",
    icon: Megaphone,
    tabs: [
      { to: "/app/campaigns", label: "Campaigns" },
      { to: "/app/templates", label: "Templates" },
      { to: "/app/cards", label: "Cards" },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    icon: Users,
    tabs: [
      { to: "/app/contacts", label: "Contacts" },
      { to: "/app/contacts", label: "Segments", search: { tab: "segments" } },
      { to: "/app/receipts", label: "Sales from chats" },
    ],
  },
  {
    key: "automate",
    label: "Automate",
    icon: Bot,
    tabs: [
      { to: "/app/employee", label: "Aiden" },
      { to: "/app/flows", label: "Flows" },
      { to: "/app/automations", label: "Automations" },
    ],
  },
  {
    key: "shop",
    label: "Shop",
    icon: ShoppingBag,
    tabs: [
      { to: "/app/catalog", label: "Catalogue" },
      { to: "/app/catalog/collections", label: "Collections", requires: "/app/catalog" },
      {
        to: "/app/settings",
        label: "Shopify",
        search: { tab: "integrations" },
        extra: "shopify",
        jump: true,
      },
    ],
  },
];

const ACCOUNT_DEFS: Array<TabDef & { key: string }> = [
  { key: "settings", to: "/app/settings", label: "Settings" },
  { key: "billing", to: "/app/billing", label: "Billing and wallet" },
  { key: "team", to: "/app/settings", label: "Team", search: { tab: "team" } },
];

const linkKey = (to: string, search?: Record<string, string>) =>
  search ? `${to}?${new URLSearchParams(search).toString()}` : to;

/** The new shell's sections, account links and overflow for these sidebar items. */
export function buildShellModel(
  items: NavItem[],
  restricted: boolean,
  extras: ShellExtras = { shopify: false },
): ShellModel {
  const visible = new Set(items.map((i) => i.to));
  const placed = new Set<string>();
  const sections: Section[] = [];

  for (const def of SECTION_DEFS) {
    const tabs: SectionTab[] = def.tabs
      .filter((t) => visible.has(t.requires ?? t.to) && (!t.extra || extras[t.extra]))
      .map((t) => ({
        key: linkKey(t.to, t.search),
        to: t.to,
        label: t.label,
        ...(t.search ? { search: t.search } : {}),
        ...(t.jump ? { jump: true } : {}),
      }));
    for (const t of tabs) if (!t.jump) placed.add(t.to);
    if (def.key === "home") {
      // Home is the app's own page; a locked workspace has none.
      if (restricted) continue;
      sections.push({
        key: "home",
        label: def.label,
        icon: def.icon,
        to: "/app",
        tabs: [],
        owns: def.owns ?? [],
      });
      continue;
    }
    const first = tabs.find((t) => !t.jump);
    if (!first) continue;
    sections.push({
      key: def.key,
      label: def.label,
      icon: def.icon,
      to: first.to,
      ...(first.search ? { search: first.search } : {}),
      tabs,
      owns: def.owns ?? [],
    });
  }

  const account: ShellLink[] = ACCOUNT_DEFS.filter((d) => visible.has(d.to)).map((d) => ({
    key: d.key,
    to: d.to,
    label: d.label,
    ...(d.search ? { search: d.search } : {}),
  }));
  for (const a of account) placed.add(a.to);

  const analyticsItem = items.find((i) => i.to === "/app/analytics");
  const analytics: ShellLink | null = analyticsItem
    ? { key: "/app/analytics", to: "/app/analytics", label: "All numbers" }
    : null;
  if (analytics) placed.add(analytics.to);

  const overflow: ShellLink[] = items
    .filter((i) => !placed.has(i.to))
    .map((i) => ({ key: i.to, to: i.to, label: i.label }));

  return { sections, account, analytics, overflow };
}

/** Every address the new shell offers (menu, sub-tab, avatar menu, More sheet). */
export function reachablePaths(model: ShellModel): Set<string> {
  const out = new Set<string>();
  for (const s of model.sections) {
    out.add(s.to);
    for (const t of s.tabs) out.add(t.to);
  }
  for (const a of model.account) out.add(a.to);
  if (model.analytics) out.add(model.analytics.to);
  for (const o of model.overflow) out.add(o.to);
  return out;
}

function searchMatches(
  want: Record<string, string> | undefined,
  search: Record<string, unknown>,
): boolean {
  if (!want) return true;
  return Object.entries(want).every(([k, v]) => String(search[k] ?? "") === v);
}

/** The tab this address shows: a tab with matching search beats a plain one, then the longest path. */
export function activeTab(
  section: Section,
  pathname: string,
  search: Record<string, unknown>,
): SectionTab | null {
  const hits = section.tabs.filter(
    (t) => !t.jump && isActivePath(pathname, t.to) && searchMatches(t.search, search),
  );
  hits.sort(
    (a, b) => Number(Boolean(b.search)) - Number(Boolean(a.search)) || b.to.length - a.to.length,
  );
  return hits[0] ?? null;
}

/** The section this address belongs to, if any (Settings and Billing belong to none). */
export function activeSection(
  model: ShellModel,
  pathname: string,
  search: Record<string, unknown> = {},
): Section | null {
  for (const s of model.sections) {
    if (s.key === "home") {
      if (isActivePath(pathname, "/app") || s.owns.some((p) => isActivePath(pathname, p))) return s;
      continue;
    }
    if (activeTab(s, pathname, search) || s.owns.some((p) => isActivePath(pathname, p))) return s;
  }
  return null;
}
