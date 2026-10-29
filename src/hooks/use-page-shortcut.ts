import { useEffect, useRef } from "react";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";

/**
 * Batch 41: one single-key shortcut for a page's main action ("N" for a new
 * campaign). Never fires while typing or with a dialog/menu focused, and only
 * while `enabled` (the same permission the action's button checks).
 */
export function usePageShortcut(key: string, run: () => void, enabled = true) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPlainKey(e) || e.shiftKey) return;
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      runRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, enabled]);
}
