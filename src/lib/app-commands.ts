import { useEffect, useRef } from "react";

/**
 * Batch 39: actions the command palette can ask a page to do — the same thing
 * the page's own button does (open the New campaign wizard, open a chat).
 * The palette navigates first; the page runs the command when it mounts, or
 * right away when it is already on screen.
 */
export type AppCommand =
  { kind: "new-campaign" } | { kind: "new-template" } | { kind: "open-conversation"; id: string };

const EVENT = "aidwar:app-command";
let pending: AppCommand | null = null;

export function runAppCommand(command: AppCommand): void {
  pending = command;
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(EVENT, { detail: command }));
}

/** Runs `handler` for commands of `kind` (once each, newest wins). */
export function useAppCommand<K extends AppCommand["kind"]>(
  kind: K,
  handler: (command: Extract<AppCommand, { kind: K }>) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const take = () => {
      if (pending?.kind !== kind) return;
      const command = pending as Extract<AppCommand, { kind: K }>;
      pending = null;
      ref.current(command);
    };
    take();
    window.addEventListener(EVENT, take);
    return () => window.removeEventListener(EVENT, take);
  }, [kind]);
}
