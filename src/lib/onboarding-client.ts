import { callApi } from "@/lib/whatsapp-client";
import type { JourneyState, LearnedItem } from "@/lib/onboarding-journey.server";
import type { SiteBrand } from "@/lib/site-peek";

/** Batch 40: the first-run journey's one API (/api/onboarding/journey). */
export const journeyApi = <T>(body: Record<string, unknown>) =>
  callApi<T>("/api/onboarding/journey", { body });

export type JourneyStateReply = {
  state: JourneyState;
  can_configure: boolean;
  owner_phone: string | null;
  learned?: LearnedItem[];
};

export type PeekReply = { ok: true; brand: SiteBrand; listing: string | null };

export type TestReply = {
  answered: boolean;
  answer: string | null;
  sources: number;
  status: string;
};

export type { JourneyState, LearnedItem, SiteBrand };

/** Sign-up attribution, kept in localStorage so the email-confirmation tab still has it. */
export const ATTRIBUTION_STORAGE_KEY = "aidwar.signup.attribution";

export function keepAttribution(attribution: Record<string, string>): void {
  if (Object.keys(attribution).length === 0) return;
  try {
    window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
  } catch {
    /* private mode — attribution is best effort, never blocks signup */
  }
}

/** Whatever the signup link carried — spent once, then cleared. */
export function takeAttribution(): Record<string, string> {
  try {
    const raw =
      window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY) ??
      window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    window.localStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
    window.sessionStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** "Save & exit" for this browser session: Home won't send them back until next visit. */
export const EXITED_KEY = (orgId: string) => `aidwar.journey.exited.${orgId}`;
/** Set by Go live; the Inbox shows its three tips once. */
export const TOUR_KEY = (orgId: string) => `aidwar.inbox-tour.${orgId}`;

export function readStorage(store: "local" | "session", key: string): string | null {
  try {
    return (store === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(store: "local" | "session", key: string, value: string | null): void {
  try {
    const s = store === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage is a convenience only */
  }
}
