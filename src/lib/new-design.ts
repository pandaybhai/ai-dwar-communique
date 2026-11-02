import { useEffect } from "react";
import { useOrg } from "@/lib/org-context";
import { readThemeChoice, resolveTheme } from "@/lib/theme";
import { RELEASE_FLAG, resolveDesign, type DesignAnswer } from "@/lib/aiden-workspace";

/**
 * Batch 44: the new design (docs/design/spec.md) is rolled out per workspace
 * behind the `new_design` feature flag. This is the one switch: off — and
 * while the flag row doesn't exist, or the flags are still loading on a first
 * visit — the app is the Batch 39 to 41 look and sidebar exactly as before.
 */
export const NEW_DESIGN_FLAG = "new_design";

const cacheKey = (organizationId: string) => `aidwar.new_design.${organizationId}`;

/** The last answer for this workspace, so a reload doesn't flash the other look. */
function readCached(organizationId: string | null): boolean {
  if (!organizationId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(cacheKey(organizationId)) === "1";
  } catch {
    return false;
  }
}

function writeCached(organizationId: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(cacheKey(organizationId), "1");
    else window.localStorage.removeItem(cacheKey(organizationId));
  } catch {
    // Private mode: the flag is read again on the next visit.
  }
}

/**
 * The design this member sees, with why and whether the avatar-menu switch
 * shows (Batch 53, src/lib/aiden-workspace.ts). While the release flag
 * `aiden_workspace` is off — its global default, a missing row = off — this
 * is exactly the Batch 44 answer: `new_design` for the workspace.
 */
export function useDesignAnswer(): DesignAnswer {
  const org = useOrg() as Partial<ReturnType<typeof useOrg>> | undefined;
  const organizationId = org?.active?.organization.id ?? null;
  const loading = org?.flagsLoading !== false;
  const today = !loading && org?.isFeatureEnabled?.(NEW_DESIGN_FLAG) === true;
  const releaseOn = !loading && org?.flagDefaults?.[RELEASE_FLAG] === true;
  const prefs = org?.designPrefs ?? null;
  const prefsPending = releaseOn && (org?.designPrefsLoading !== false || !prefs);

  const answer: DesignAnswer = loading || prefsPending
    ? {
        design: readCached(organizationId) ? "aiden_workspace" : "classic",
        source: "today",
        switchVisible: false,
      }
    : resolveDesign({
        releaseOn,
        newDesignToday: today,
        superAdminOverride: prefs?.superAdminOverride ?? null,
        choice: prefs?.choice ?? null,
        unlockedAt: prefs?.unlockedAt ?? null,
        newDesignDefault: org?.flagDefaults?.[NEW_DESIGN_FLAG] === true,
      });
  const settled = !loading && !prefsPending;
  const on = answer.design === "aiden_workspace";

  useEffect(() => {
    if (settled && organizationId) writeCached(organizationId, on);
  }, [settled, organizationId, on]);

  return answer;
}

/** True only when this member sees the new design (Aiden Workspace). */
export function useNewDesign(): boolean {
  return useDesignAnswer().design === "aiden_workspace";
}

/** Bricolage Grotesque (display) and Instrument Sans (body), from Google Fonts. */
export const NEW_DESIGN_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600;700&display=swap";

/** The fonts load only for a workspace that sees the new design. */
function ensureFonts() {
  if (document.getElementById("nd-fonts")) return;
  const link = document.createElement("link");
  link.id = "nd-fonts";
  link.rel = "stylesheet";
  link.href = NEW_DESIGN_FONTS_HREF;
  document.head.appendChild(link);
}

/**
 * Turns the new design's tokens on (`<html data-design="new">`) while `on`.
 * Light only until Batch 50 decides dark: the dark class is lifted while the
 * new design shows and put back from the theme choice when it goes.
 */
export function useDesignSurface(on: boolean, settled = true) {
  useEffect(() => {
    const root = document.documentElement;
    if (!on) {
      // Batch 58: the pre-paint script guessed Aiden Workspace from this
      // browser's cache, and the answer settled on Classic: put Classic's
      // surface back exactly as the script would have left it.
      if (settled) undoBootDesignGuess(root, resolveTheme(readThemeChoice()) === "dark");
      return;
    }
    root.removeAttribute("data-design-boot");
    ensureFonts();
    root.setAttribute("data-design", "new");
    root.classList.remove("dark");
    return () => {
      root.removeAttribute("data-design");
      if (root.hasAttribute("data-app")) {
        root.classList.toggle("dark", resolveTheme(readThemeChoice()) === "dark");
      }
    };
  }, [on, settled]);
}

type SurfaceRoot = {
  hasAttribute: (name: string) => boolean;
  removeAttribute: (name: string) => void;
  classList: { toggle: (name: string, force?: boolean) => unknown };
};

/**
 * Batch 58: the pre-paint script (APP_THEME_SCRIPT) put Aiden Workspace's
 * surface on from this browser's cache, and the settled answer is Classic:
 * Classic's surface back, exactly as that script draws it without the cache
 * (no data-design, the theme's dark class). Nothing when it guessed nothing.
 */
export function undoBootDesignGuess(root: SurfaceRoot, dark: boolean): boolean {
  if (!root.hasAttribute("data-design-boot")) return false;
  root.removeAttribute("data-design-boot");
  root.removeAttribute("data-design");
  if (root.hasAttribute("data-app")) root.classList.toggle("dark", dark);
  return true;
}

/**
 * Batch 58: true once the design answer no longer comes from this browser's
 * cache — the workspaces, the flags (and, with the release flag on, the
 * member's design prefs) are read. useDesignSurface undoes the pre-paint
 * guess only then.
 */
export function useDesignSettled(): boolean {
  const org = useOrg() as Partial<ReturnType<typeof useOrg>> | undefined;
  if (org?.loading !== false) return false;
  if (!org?.active) return true;
  if (org.flagsLoading !== false) return false;
  const releaseOn = org.flagDefaults?.[RELEASE_FLAG] === true;
  return !releaseOn || (org.designPrefsLoading === false && Boolean(org.designPrefs));
}
