import { useEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signupSearchFrom } from "@/lib/start-page";
import { writeStartPrefill } from "@/lib/start-prefill";
import { fbclidForLead, fireFromServer } from "@/lib/meta-pixel";
import type { BrowserMetaEvent } from "@/lib/meta-events";
import { POLL_FOR_MS, POLL_MS, type VerifyState } from "@/lib/lead-verify";
import { funnelStore, type Funnel } from "@/lib/start-funnel";

/**
 * Batch 78: the /start card's hooks — the shared state, the hand-off to
 * /signup and the WhatsApp verification watcher (start-lead-form.tsx is the
 * card itself).
 */

/**
 * The shared card state (hero + final + sticky bar). Only the browser ever
 * changes the store, so on the server it is always step 1 (INITIAL_FUNNEL).
 */
export function useFunnel(): Funnel {
  return useSyncExternalStore(funnelStore.subscribe, funnelStore.get, funnelStore.get);
}

/** On to /signup with the details in this tab only (never in the address bar). */
export function useToSignup(): (f: Funnel) => Promise<void> {
  const navigate = useNavigate();
  return async (f: Funnel) => {
    writeStartPrefill({
      name: f.name.trim(),
      phone: f.savedPhone ?? f.phone,
      business: f.business.trim(),
    });
    await navigate({ to: "/signup", search: signupSearchFrom(window.location.search) as never });
  };
}

/**
 * The page's one verification watcher (StartPage calls it once, not each
 * card): while the verify screen shows it asks every 2 s — only while the
 * tab is visible, for at most 15 minutes — and once verified takes the
 * result (prefill + Meta's Lead, pixel after consent) and goes to /signup.
 */
export function useStartVerification(): void {
  const f = useFunnel();
  const toSignup = useToSignup();
  const watching = f.step === "verify" && f.verifyState === "waiting";
  const shownAt = f.verifyShownAt;
  const claimed = useRef(false);

  useEffect(() => {
    if (!watching) return;
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden) return;
      if (shownAt !== null && Date.now() - shownAt > POLL_FOR_MS) {
        funnelStore.set((x) => ({ ...x, verifyState: "expired" }));
        return;
      }
      try {
        const res = await fetch("/api/public/start-verify", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const out = (await res.json().catch(() => ({}))) as { state?: VerifyState };
        if (stop) return;
        if (out.state === "verified") funnelStore.set((x) => ({ ...x, verifyState: "verified" }));
        else if (out.state === "expired")
          funnelStore.set((x) => ({ ...x, verifyState: "expired" }));
      } catch {
        // a busy network: the next tick asks again
      }
    };
    const t = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [watching, shownAt]);

  useEffect(() => {
    if (f.verifyState !== "verified" || f.step !== "verify" || claimed.current) return;
    claimed.current = true;
    void (async () => {
      let next: Funnel = { ...funnelStore.get(), step: "verified" };
      try {
        const res = await fetch("/api/public/start-verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ ...fbclidForLead(), action: "claim" }),
        });
        const out = (await res.json().catch(() => ({}))) as {
          prefill?: { name: string; phone: string; business_name: string };
          meta?: BrowserMetaEvent | null;
        };
        fireFromServer(out.meta ?? null);
        if (out.prefill) {
          next = {
            ...next,
            name: out.prefill.name || next.name,
            business: out.prefill.business_name || next.business,
            savedPhone: out.prefill.phone || next.savedPhone,
          };
        }
      } catch {
        // verified all the same; sign-up has what was typed
      }
      funnelStore.set(next);
      window.setTimeout(() => void toSignup(next), 900);
    })();
  }, [f.verifyState, f.step, toSignup]);
}
