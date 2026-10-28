import type { LucideIcon } from "lucide-react";
import { Building2, Home } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { useAutomationsCount } from "@/hooks/use-automations-count";
import { automationsNavHidden } from "@/lib/automations";
import { usePermissions } from "@/hooks/use-permissions";
import { navFeatures } from "@/lib/feature-registry";
import { FEATURE_ICONS } from "@/lib/feature-icons";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  flag: string | null;
  perm: string | null;
};

/**
 * Navigation renders from the feature registry: flag first, then permission.
 * Never add a nav item here — declare it on the feature manifest.
 */
const NAV: NavItem[] = navFeatures().map((f) => ({
  to: f.nav_path as string,
  label: f.name,
  icon: FEATURE_ICONS[f.icon],
  flag: f.flag_key,
  perm: f.nav_permission ?? null,
}));

/** Home is the app's own landing page, not a feature. */
export const HOME_ITEM: NavItem = { to: "/app", label: "Home", icon: Home, flag: null, perm: null };

/**
 * Batch 39: sidebar groups — presentation only (like FEATURE_ICONS). A
 * registry entry with a path not listed here lands in "More", so a new
 * feature always shows up.
 */
const GROUPS: Array<{ label: string; paths: string[] }> = [
  { label: "Conversations", paths: ["/app/inbox", "/app/contacts"] },
  { label: "Marketing", paths: ["/app/campaigns", "/app/templates", "/app/catalog", "/app/cards"] },
  { label: "Automation", paths: ["/app/flows", "/app/automations", "/app/employee"] },
  { label: "Insights", paths: ["/app/analytics", "/app/receipts"] },
  { label: "Workspace", paths: ["/app/settings", "/app/billing"] },
];

export type NavGroup = { label: string | null; items: NavItem[] };

/** The nav items this person may see, exactly as the sidebar always filtered them. */
export function useNavItems(): { items: NavItem[]; restricted: boolean } {
  const { isFeatureEnabled, flagsLoading, active } = useOrg();
  const automationsCount = useAutomationsCount(active?.organization.id ?? null);
  const { can, loading: permsLoading } = usePermissions();
  const status = active?.organization.plan_status;
  const restricted = status === "locked" || status === "paused";
  const items = restricted
    ? [
        ...NAV.filter((item) => item.to === "/app/inbox" && (!item.perm || permsLoading || can(item.perm))),
        { to: "/app/billing", label: "Billing", icon: FEATURE_ICONS["credit-card"] ?? Building2, flag: null, perm: null },
      ]
    : NAV.filter(
        (item) =>
          (!item.flag || flagsLoading || isFeatureEnabled(item.flag)) &&
          (!item.perm || permsLoading || can(item.perm)) &&
          // No automations at all: new replies are made in Flows (templates there).
          !(item.to === "/app/automations" && automationsNavHidden(automationsCount)),
      );
  return { items, restricted };
}

/** The visible items in their groups, Home first (not while the workspace is locked). */
export function groupNav(items: NavItem[], restricted: boolean): NavGroup[] {
  const groups: NavGroup[] = restricted ? [] : [{ label: null, items: [HOME_ITEM] }];
  const placed = new Set<string>();
  for (const g of GROUPS) {
    const inGroup = items.filter((i) => g.paths.includes(i.to));
    inGroup.forEach((i) => placed.add(i.to));
    if (inGroup.length) groups.push({ label: g.label, items: inGroup });
  }
  const rest = items.filter((i) => !placed.has(i.to));
  if (rest.length) groups.push({ label: "More", items: rest });
  return groups;
}

export function isActivePath(pathname: string, to: string): boolean {
  if (to === "/app") return pathname === "/app" || pathname === "/app/";
  return pathname === to || pathname.startsWith(`${to}/`);
}
