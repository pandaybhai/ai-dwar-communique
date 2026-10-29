import { useEffect, type CSSProperties } from "react";
import { useRouter } from "@tanstack/react-router";
import { NEW_DESIGN_FONTS_HREF } from "@/lib/new-design";

/**
 * Batch 50: the public site's new look (landing, pricing, sign-up, log in) is
 * its own switch, `new_site`, because those pages have no workspace and so no
 * `new_design` flag. Default OFF: the current pages render exactly as before.
 *
 * - On for everyone: build with `VITE_NEW_SITE=on` (Lovable → environment).
 * - Preview without switching it on: add `?site=new` to the address (the new
 *   pages keep it on their own links while you click around).
 */
export const NEW_SITE_SWITCH = "new_site";

export const NEW_SITE_ENV: boolean = import.meta.env["VITE_NEW_SITE"] === "on";

/** Whether an address's search asks for the preview. */
export function isNewSitePreview(search: unknown): boolean {
  return (search as Record<string, unknown> | null | undefined)?.["site"] === "new";
}

export function newSiteOn(search: unknown, env: boolean = NEW_SITE_ENV): boolean {
  return env || isNewSitePreview(search);
}

/**
 * The address's search, read from the router (server and browser agree).
 * The pages re-render on navigation through their own route hooks; without a
 * router (a page rendered on its own in a test) only the env decides.
 */
function useCurrentSearch(): unknown {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  return router?.state?.location?.search;
}

/** The switch for the page being shown. */
export function useNewSite(): boolean {
  return newSiteOn(useCurrentSearch());
}

/** Search to carry on the new pages' own links while previewing. */
export function useSitePreviewSearch(): Record<string, string> {
  return !NEW_SITE_ENV && isNewSitePreview(useCurrentSearch()) ? { site: "new" } : {};
}

/**
 * The new design's fonts (Bricolage Grotesque, Instrument Sans) load after the
 * page is up, never in the head: text paints at once in the fallback face and
 * swaps when they arrive (display=swap), so the landing's first paint and its
 * mobile score don't wait for a second font request. Same file as the app.
 */
function ensureSiteFonts() {
  if (document.getElementById("nd-fonts")) return;
  const link = document.createElement("link");
  link.id = "nd-fonts";
  link.rel = "stylesheet";
  link.href = NEW_DESIGN_FONTS_HREF;
  document.head.appendChild(link);
}

/**
 * The new design's semantic tokens for a public page. The app turns them on
 * with <html data-app data-design="new">; the public site has neither, so the
 * page's wrapper carries the same mapping (docs/design/spec.md, "Tokens"),
 * server-rendered, with no flash of the old look. Palette values (--aiden,
 * --ink, --gold …) are global already.
 */
export const SITE_TOKENS = {
  colorScheme: "light",
  "--font-body": '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
  "--font-head": '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif',
  "--font-feature": "normal",
  "--radius": "0.6875rem",
  "--btn-primary": "var(--ink)",
  "--btn-primary-foreground": "var(--ink-foreground)",
  "--background": "var(--ground)",
  "--foreground": "var(--ink)",
  "--card": "var(--surface)",
  "--card-foreground": "var(--ink)",
  "--popover": "var(--surface)",
  "--popover-foreground": "var(--ink)",
  "--primary": "var(--aiden-deep)",
  "--primary-foreground": "var(--ink-foreground)",
  "--secondary": "var(--bubble-in)",
  "--secondary-foreground": "var(--ink)",
  "--muted": "var(--bubble-in)",
  "--muted-foreground": "var(--muted-ink)",
  "--faint": "var(--muted-ink)",
  "--subtle": "var(--ground-tint)",
  "--accent": "var(--ground-deep)",
  "--accent-foreground": "var(--ink)",
  "--border": "var(--line)",
  "--border-strong": "var(--line-strong)",
  "--input": "var(--line)",
  "--ring": "var(--aiden)",
  "--elev-xs": "0 1px 2px var(--shadow-ink)",
  "--elev-sm": "0 1px 2px var(--shadow-ink), 0 8px 20px -16px var(--shadow-ink)",
  "--elev-md": "0 10px 28px -20px var(--shadow-ink)",
  "--elev-lg": "0 18px 40px -16px var(--shadow-ink)",
  "--elev-xl": "0 20px 50px -30px var(--shadow-ink), 0 1px 2px var(--shadow-ink)",
  "--elev-2xl": "0 30px 60px -30px var(--shadow-ink), 0 2px 6px var(--shadow-ink)",
} as CSSProperties;

/**
 * The same tokens on <html> while a new public page is open, so menus,
 * dialogs and toasts (portals outside the wrapper) match it; put back on
 * leaving. `data-design="new"` also turns on the `nd:` variants.
 */
export function useSiteSurface(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const entries = Object.entries(SITE_TOKENS).filter(([k]) => k.startsWith("--"));
    const hadDesign = root.getAttribute("data-design");
    let applied = false;
    // Not in the page's first moments: the wrapper already carries the look,
    // so the fonts and the portal tokens wait until the page is loaded and idle.
    const cancel = afterLoadIdle(() => {
      applied = true;
      ensureSiteFonts();
      for (const [k, v] of entries) root.style.setProperty(k, String(v));
      root.setAttribute("data-design", "new");
    });
    return () => {
      cancel();
      if (!applied) return;
      for (const [k] of entries) root.style.removeProperty(k);
      if (hadDesign === null) root.removeAttribute("data-design");
      else root.setAttribute("data-design", hadDesign);
    };
  }, [on]);
}

/** Runs `fn` once the page has loaded and the browser is idle; returns a cancel. */
export function afterLoadIdle(fn: () => void): () => void {
  let done = false;
  let idle: number | null = null;
  const idleApi = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  const run = () => {
    if (done) return;
    if (idleApi.requestIdleCallback) idle = idleApi.requestIdleCallback(() => !done && (done = true, fn()), { timeout: 1500 });
    else idle = window.setTimeout(() => !done && (done = true, fn()), 200);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
  return () => {
    done = true;
    window.removeEventListener("load", run);
    if (idle !== null) {
      if (idleApi.cancelIdleCallback) idleApi.cancelIdleCallback(idle);
      window.clearTimeout(idle);
    }
  };
}
