/**
 * Batch 53: who sees the new design. In the UI the new design is called
 * "Aiden Workspace" and the old one "Classic" (Aiden's own Off /
 * Drafts / Replying switch is a different thing).
 *
 * Shipped dark: the release flag `aiden_workspace` is OFF by default (and a
 * missing row is OFF). While it is off the answer is exactly today's —
 * the workspace's `new_design` flag (only Super Admin overrides turn it on)
 * — the avatar-menu switch is hidden and nobody is moved by the unlock rule.
 * The unlock timestamps are still recorded, so switching the flag's global
 * default on applies the rule at once:
 *
 *   1. release flag off                  -> today's new_design answer
 *   2. Super Admin new_design override   -> that override
 *   3. the person's own choice           -> that choice
 *   4. workspace unlocked (Aiden was on) -> Aiden Workspace
 *   5. otherwise                         -> new_design's global default (off = Classic)
 *
 * Only the flag's global default counts as the release switch: a plan
 * change writes an override row for every registry flag, so a per-workspace
 * row can't be read as a decision about the release.
 *
 * Pure: no React, no database client.
 */

export const RELEASE_FLAG = "aiden_workspace";
export const DESIGN_SWITCHED_EVENT = "design.switched";

export type DesignName = "classic" | "aiden_workspace";

export const DESIGN_LABEL: Record<DesignName, string> = {
  classic: "Classic",
  aiden_workspace: "Aiden Workspace",
};

export type DesignInputs = {
  /** feature_flags.default_enabled for aiden_workspace; undefined = no row = off. */
  releaseOn: boolean | undefined;
  /** The workspace's resolved new_design flag, exactly as today. */
  newDesignToday: boolean;
  /** A Super Admin's decision for this workspace (null = none). */
  superAdminOverride: boolean | null;
  /** The person's own choice (null = never chose). */
  choice: DesignName | null;
  /** organizations.aiden_workspace_unlocked_at. */
  unlockedAt: string | null;
  /** feature_flags.default_enabled for new_design (false today). */
  newDesignDefault: boolean;
};

export type DesignSource = "today" | "super_admin" | "choice" | "unlocked" | "default";

export type DesignAnswer = {
  design: DesignName;
  source: DesignSource;
  /** The avatar menu shows "Try Aiden Workspace" / "Switch to Classic". */
  switchVisible: boolean;
};

export function resolveDesign(input: DesignInputs): DesignAnswer {
  if (input.releaseOn !== true) {
    return {
      design: input.newDesignToday ? "aiden_workspace" : "classic",
      source: "today",
      switchVisible: false,
    };
  }
  if (input.superAdminOverride !== null) {
    // The switch would do nothing here, so it isn't offered.
    return {
      design: input.superAdminOverride ? "aiden_workspace" : "classic",
      source: "super_admin",
      switchVisible: false,
    };
  }
  if (input.choice) return { design: input.choice, source: "choice", switchVisible: true };
  if (input.unlockedAt) return { design: "aiden_workspace", source: "unlocked", switchVisible: true };
  return {
    design: input.newDesignDefault ? "aiden_workspace" : "classic",
    source: "default",
    switchVisible: true,
  };
}

/**
 * A Super Admin override, from the workspace's new_design override row and
 * the flags a person set by hand (organization_billing_settings
 * .limits_override._manual_flags, written by setFeatureOverride). A plan
 * change writes `false` rows for every flag it doesn't list, so a `false` row
 * counts only when a person set it; an `on` row always counts.
 */
export function superAdminOverrideFrom(
  overrideRow: boolean | null,
  manualFlag: boolean | null,
): boolean | null {
  if (manualFlag !== null) return manualFlag;
  if (overrideRow === true) return true;
  return null;
}

/** Aiden's mode changes that unlock Aiden Workspace (off -> draft or replying). */
export function modeUnlocks(mode: string): boolean {
  return mode === "draft" || mode === "replying";
}

/**
 * Switching keeps the page: the address in the other design. Both designs
 * share almost every route; the few new Settings sections the classic
 * Settings doesn't have go to where Classic shows the same thing.
 */
const NEW_SETTINGS_TO_CLASSIC: Record<string, { to: string; search?: Record<string, string> }> = {
  ai_apps: { to: "/app/ai-assistants" },
  notifications: { to: "/app/employee" },
  optout: { to: "/app/settings", search: { tab: "sources" } },
  connections: { to: "/app/settings", search: { tab: "integrations" } },
  danger: { to: "/app/settings", search: { tab: "general" } },
};

export function routeInOtherDesign(
  pathname: string,
  search: Record<string, unknown>,
  to: DesignName,
): { to: string; search: Record<string, string> } {
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(search ?? {})) {
    if (v !== undefined && v !== null && typeof v !== "object") plain[k] = String(v);
  }
  const path = pathname.replace(/\/+$/, "") || "/app";
  if (!path.startsWith("/app")) return { to: "/app", search: {} };
  if (to === "classic" && path === "/app/settings") {
    const mapped = NEW_SETTINGS_TO_CLASSIC[plain["tab"] ?? ""];
    if (mapped) return { to: mapped.to, search: mapped.search ?? {} };
  }
  return { to: path, search: plain };
}

/** Super Admin counts (GET /api/admin/design). */
export type DesignCounts = {
  people: { classic: number; aiden_workspace: number };
  switches: { to_classic: number; to_aiden_workspace: number; people: number };
  unlocked_workspaces: number;
  days: number;
};

/** The first-time intro: three short steps. */
export const INTRO_STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Welcome to Aiden Workspace",
    body: "The same AiDwar, laid out around what needs you. Your data, settings and team are exactly as they were.",
  },
  {
    title: "Six places, one bar",
    body: "Home, Inbox, Campaigns, Customers, Automate and Shop. On a phone, Home to Customers sit in the bottom bar and the rest are under More.",
  },
  {
    title: "Classic is one tap away",
    body: "Open the menu with your initials and choose Switch to Classic whenever you like. We remember your choice on every device.",
  },
];
