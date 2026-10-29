/**
 * Batch 39: single-key shortcuts (j, k, r, ?, g i …) must never fire while
 * someone is typing, or while a dialog or menu has focus.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(
    el.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [cmdk-root]'),
  );
}

/** A plain key press: no Ctrl / ⌘ / Alt (Shift allowed, for "?"). */
export function isPlainKey(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
