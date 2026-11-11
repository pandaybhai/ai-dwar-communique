import {
  META_PIXEL_ID,
  isContactHref,
  metaEventId,
  pixelZone,
  viewContentName,
  safeParams,
  type BrowserMetaEvent,
  type MetaParams,
  type MetaStandardEvent,
} from "@/lib/meta-events";

/**
 * Batch 70: the Meta Pixel in the browser, for AiDwar's own ads.
 *
 *  - Loads only after the visitor pressed Accept on the cookie banner (stored
 *    in this browser); Decline means it never loads. Never on /admin or an
 *    /app working page (pixelZone); never before the page has painted.
 *  - autoConfig is off (Meta never reads the page), no automatic advanced
 *    matching, and no parameter but value, currency, predicted_ltv and a page
 *    name ever leaves (safeParams). Customer matching is the server's job
 *    (meta-capi.server.ts), for AiDwar's own sign-ups only.
 *  - Every event carries an event id the server sends too (dedup); money
 *    events fire once per payment, even after a reload.
 *  - Debug: localStorage "aidwar.meta_debug" = "1" (or VITE_META_PIXEL_DEBUG=1)
 *    logs events to the console instead of loading the pixel.
 */

export const CONSENT_KEY = "aidwar.meta_consent";
export const DEBUG_KEY = "aidwar.meta_debug";
const FIRED_KEY = "aidwar.meta_fired";
const SCRIPT_SRC = "https://connect.facebook.net/en_US/fbevents.js";

export type Consent = "accepted" | "declined" | null;

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[][];
  push?: Fbq;
  loaded?: boolean;
  version?: string;
};
type MetaWindow = Window & { fbq?: Fbq; _fbq?: Fbq };

const storage = () => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readConsent(): Consent {
  try {
    const v = storage()?.getItem(CONSENT_KEY);
    return v === "accepted" || v === "declined" ? v : null;
  } catch {
    return null;
  }
}

export function writeConsent(value: "accepted" | "declined"): void {
  try {
    storage()?.setItem(CONSENT_KEY, value);
  } catch {
    // a blocked store just asks again next visit
  }
}

export function debugMode(): boolean {
  try {
    if ((import.meta as { env?: Record<string, string> }).env?.["VITE_META_PIXEL_DEBUG"] === "1")
      return true;
    return storage()?.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

const currentPath = () => (typeof window === "undefined" ? "" : window.location.pathname);

/** May the pixel run here and now? Consent accepted and an allowed page. */
export function pixelAllowed(pathname: string = currentPath()): boolean {
  return readConsent() === "accepted" && pixelZone(pathname) !== null;
}

let loading = false;

/** Installs fbq (Meta's own stub, as the base code does) and loads the script once, after paint. */
export function ensurePixel(): boolean {
  if (typeof window === "undefined" || !pixelAllowed()) return false;
  if (debugMode()) return true;
  const w = window as MetaWindow;
  if (!w.fbq) {
    const fbq: Fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue!.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    w.fbq = fbq;
    if (!w._fbq) w._fbq = fbq;
    // Meta never scrapes the page; no automatic advanced matching (no 3rd argument).
    fbq("set", "autoConfig", false, META_PIXEL_ID);
    fbq("init", META_PIXEL_ID);
  }
  if (!loading && !document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
    loading = true;
    const add = () => {
      const s = document.createElement("script");
      s.async = true;
      s.src = SCRIPT_SRC;
      document.head.appendChild(s);
    };
    // After the first paint: once the page has loaded, when the browser is idle.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void })
      .requestIdleCallback;
    const later = () => (idle ? idle(add) : setTimeout(add, 1));
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
  }
  return true;
}

function firedSet(): Set<string> {
  try {
    const raw = storage()?.getItem(FIRED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function markFired(id: string): void {
  try {
    const set = [...firedSet(), id].slice(-200);
    storage()?.setItem(FIRED_KEY, JSON.stringify(set));
  } catch {
    // a reload may fire it again; Meta still dedups by event id
  }
}

/**
 * One event. `once`: never again for this event id in this browser (money
 * events, sign-up, trial). Returns whether it went (or was logged in debug).
 */
export function track(
  event: MetaStandardEvent,
  eventId: string,
  params: Record<string, unknown> = {},
  options: { once?: boolean } = {},
): boolean {
  try {
    if (!pixelAllowed()) return false;
    if (options.once && firedSet().has(eventId)) return false;
    const safe: MetaParams = safeParams(params);
    if (debugMode()) {
      console.info("[meta-pixel]", event, { eventID: eventId, ...safe });
    } else {
      if (!ensurePixel()) return false;
      (window as MetaWindow).fbq?.("track", event, safe, { eventID: eventId });
    }
    if (options.once) markFired(eventId);
    return true;
  } catch {
    return false;
  }
}

/** What the server said to fire (InitiateCheckout, StartTrial, Subscribe, Purchase). */
export function fireFromServer(meta: BrowserMetaEvent | null | undefined): boolean {
  if (!meta || typeof meta !== "object" || !meta.event || !meta.event_id) return false;
  return track(meta.event, meta.event_id, meta.params ?? {}, { once: true });
}

export function randomEventId(event: MetaStandardEvent): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return metaEventId(event, uuid);
}

/**
 * The server copy of a browser-only event (ViewContent, Contact), with the
 * same id. Only after consent, only from an allowed page; never awaited by
 * the page.
 */
export function relayToServer(body: Record<string, unknown>): void {
  try {
    if (!pixelAllowed() || debugMode()) return;
    void fetch("/api/public/meta-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, consent: true, url: window.location.href.split("#")[0] }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // measurement never breaks the page
  }
}

/** Account created (signup): the server sends its copy whatever the cookie choice (sign-up terms). */
export function trackRegistration(userId: string): void {
  const eventId = metaEventId("CompleteRegistration", userId);
  track("CompleteRegistration", eventId, {}, { once: true });
  try {
    void fetch("/api/public/meta-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "CompleteRegistration",
        user_id: userId,
        url: window.location.href.split("#")[0],
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // never breaks sign-up
  }
}

/**
 * A payment our server confirmed paid: Subscribe (plan) or Purchase (credits),
 * once per payment. The server already sent its copy when it settled.
 */
export async function trackPaidPayment(paymentId: string): Promise<void> {
  try {
    if (!pixelAllowed()) return;
    const res = await fetch("/api/public/meta-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "payment", payment_id: paymentId }),
    });
    const body = (await res.json().catch(() => ({}))) as { meta?: BrowserMetaEvent | null };
    fireFromServer(body.meta ?? null);
  } catch {
    // never breaks the billing page
  }
}

/**
 * A public page was shown (first load or an in-app navigation): PageView, and
 * ViewContent on the pricing, developers and demo pages (with its server copy).
 */
export function pageChanged(pathname: string): void {
  if (pixelZone(pathname) !== "public" || !pixelAllowed(pathname)) return;
  track("PageView", randomEventId("PageView"));
  const name = viewContentName(pathname);
  if (name) {
    const id = randomEventId("ViewContent");
    if (track("ViewContent", id, { content_name: name }))
      relayToServer({ event: "ViewContent", event_id: id, content_name: name });
  }
}

/** A click on our email / phone / WhatsApp link on a public page: Contact. */
export function contactClicked(href: string | null | undefined, pathname: string): void {
  if (pixelZone(pathname) !== "public" || !isContactHref(href)) return;
  const id = randomEventId("Contact");
  if (track("Contact", id)) relayToServer({ event: "Contact", event_id: id });
}

/**
 * A trial workspace was just created (onboarding): the server sends its copy
 * (sign-up terms) and answers what the pixel fires. Never awaited by setup.
 */
export function trackStartTrial(organizationId: string): void {
  // The plan they came for (pricing → /signup?plan=), read now: the sign-up
  // attribution is taken (and removed) by setup a moment later.
  let plan: string | null = null;
  try {
    const raw =
      window.localStorage.getItem("aidwar.signup.attribution") ??
      window.sessionStorage.getItem("aidwar.signup.attribution");
    const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    plan =
      (typeof stored["plan"] === "string" ? (stored["plan"] as string) : null) ??
      new URLSearchParams(window.location.search).get("plan");
  } catch {
    plan = null;
  }
  void (async () => {
    try {
      const { callApi } = await import("@/lib/whatsapp-client");
      const { data } = await callApi<{ meta?: BrowserMetaEvent | null }>("/api/public/meta-event", {
        body: {
          event: "StartTrial",
          organization_id: organizationId,
          plan,
          url: window.location.href.split("#")[0],
        },
      });
      fireFromServer(data?.meta ?? null);
    } catch {
      // never breaks setup
    }
  })();
}
