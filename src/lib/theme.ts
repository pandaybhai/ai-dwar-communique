import { useCallback, useEffect, useState } from "react";

/**
 * The signed-in app's look (Batch 39): html[data-app] switches on the app's
 * design tokens (src/styles.css) and .dark its dark theme. Only the app sets
 * them — the marketing site and the developer portal keep their own look.
 *
 * The choice is per browser (localStorage), Light by default until every
 * screen has been reviewed in dark (Parts 2–4); "system" follows the OS.
 */
export const APP_THEME_KEY = "aidwar.theme";

export type ThemeChoice = "light" | "dark" | "system";

/** Applied in the document head before first paint, on /app pages only. */
export const APP_THEME_SCRIPT = `try{if(location.pathname==="/app"||location.pathname.indexOf("/app/")===0){var d=document.documentElement,t=localStorage.getItem("${APP_THEME_KEY}");d.setAttribute("data-app","");if(t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches))d.classList.add("dark")}}catch(e){}`;

export function readThemeChoice(): ThemeChoice {
  try {
    const t = window.localStorage.getItem(APP_THEME_KEY);
    return t === "dark" || t === "system" ? t : "light";
  } catch {
    return "light";
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  return choice === "system" ? (systemDark() ? "dark" : "light") : choice;
}

/**
 * Turns the app's tokens on while the app is mounted and off when it isn't
 * (a client-side visit to the marketing site), applying the theme choice.
 */
export function useAppSurface() {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-app", "");
    root.classList.toggle("dark", resolveTheme(readThemeChoice()) === "dark");
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if (readThemeChoice() === "system") root.classList.toggle("dark", systemDark());
    };
    media?.addEventListener?.("change", onSystem);
    return () => {
      media?.removeEventListener?.("change", onSystem);
      root.removeAttribute("data-app");
      root.classList.remove("dark");
    };
  }, []);
}

const listeners = new Set<(choice: ThemeChoice) => void>();

/** The theme choice and a setter that every subscriber (menu, palette, design page) sees. */
export function useThemeChoice(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoiceState] = useState<ThemeChoice>(() =>
    typeof window === "undefined" ? "light" : readThemeChoice(),
  );
  useEffect(() => {
    listeners.add(setChoiceState);
    return () => {
      listeners.delete(setChoiceState);
    };
  }, []);
  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      window.localStorage.setItem(APP_THEME_KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.classList.toggle("dark", resolveTheme(next) === "dark");
    window.setTimeout(() => root.classList.remove("theme-switching"), 50);
    for (const l of listeners) l(next);
  }, []);
  return [choice, setChoice];
}
