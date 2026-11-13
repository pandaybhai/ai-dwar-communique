import { checkStartForm } from "@/lib/start-page";
import type { VerifyState } from "@/lib/lead-verify";
import type { Customers, Sells } from "@/lib/start-qualify";

/**
 * Batch 78: the /start card — three taps, not a form. Step 1 "What do you
 * sell?", step 2 "How many customers?" (one tap each = picked and on to the
 * next), step 3 name, business name and WhatsApp number, then the WhatsApp
 * verification. Nothing is saved before step 3. Pure, so it is tested
 * without a browser; the hero card, the final card and the sticky bar share
 * one store, so the visitor carries on wherever they left off.
 */

export type FunnelStep = "sells" | "customers" | "details" | "verify" | "verified";

export type IssuedVerify = { wa_link: string; message: string; expires_at: string };

export type Funnel = {
  step: FunnelStep;
  sells: Sells | null;
  customers: Customers | null;
  name: string;
  business: string;
  phone: string;
  /** E.164, once step 3 is sent. */
  savedPhone: string | null;
  verify: IssuedVerify | null;
  verifyState: VerifyState;
  /** When the verify screen first showed (the 60 s "continue without" link counts from here). */
  verifyShownAt: number | null;
  /** The card the visitor is using ("hero" | "final"): only it moves focus. */
  active: string | null;
};

export const INITIAL_FUNNEL: Funnel = {
  step: "sells",
  sells: null,
  customers: null,
  name: "",
  business: "",
  phone: "",
  savedPhone: null,
  verify: null,
  verifyState: "none",
  verifyShownAt: null,
  active: null,
};

/** Tap on a "What do you sell?" card: picked, and on to step 2. */
export function pickSells(f: Funnel, sells: Sells): Funnel {
  return { ...f, sells, step: "customers" };
}

/** Tap on a "How many customers?" card: picked, and on to step 3. */
export function pickCustomers(f: Funnel, customers: Customers): Funnel {
  return { ...f, customers, step: "details" };
}

/** The small Back link: one step back, every answer kept. */
export function back(f: Funnel): Funnel {
  if (f.step === "customers") return { ...f, step: "sells" };
  if (f.step === "details") return { ...f, step: "customers" };
  return f;
}

/** 1/3, 2/3, 3/3 for the thin progress bar (the verify screens count as 3). */
export function progressOf(step: FunnelStep): 1 | 2 | 3 {
  return step === "sells" ? 1 : step === "customers" ? 2 : 3;
}

/** After step 3 is sent: the verify screen, or (no code) straight on to /signup. */
export function afterDetailsSent(
  f: Funnel,
  phone: string,
  verify: IssuedVerify | null,
  now: number,
): Funnel {
  return verify
    ? {
        ...f,
        savedPhone: phone,
        verify,
        step: "verify",
        verifyState: "waiting",
        verifyShownAt: now,
      }
    : { ...f, savedPhone: phone, verify: null, step: "verified", verifyState: "none" };
}

/** Step 3's own check (the server checks again): all three are needed. */
export function checkDetails(input: {
  name: string;
  business: string;
  phone: string;
}):
  | { ok: true; name: string; business: string; phone: string }
  | { ok: false; field: "name" | "business" | "phone"; error: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) return { ok: false, field: "name", error: "Please enter your name." };
  const business = input.business.trim().replace(/\s+/g, " ");
  if (business.length < 2) {
    return { ok: false, field: "business", error: "Please enter your business name." };
  }
  const checked = checkStartForm({ name, phone: input.phone });
  if (!checked.ok) return { ok: false, field: "phone", error: checked.error };
  return { ok: true, name, business, phone: checked.phone };
}

/* ---------------------------------------------------------------- store --- */

type Listener = () => void;

export function createFunnelStore(initial: Funnel = INITIAL_FUNNEL) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: (): Funnel => state,
    set(next: Funnel | ((f: Funnel) => Funnel)): void {
      state = typeof next === "function" ? next(state) : next;
      for (const l of listeners) l();
    },
    subscribe(l: Listener): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** The one /start page store (hero card, final card, sticky bar). */
export const funnelStore = createFunnelStore();
