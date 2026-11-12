import {
  META_PIXEL_ID,
  isContactHref,
  leadEventId,
  metaEventId,
  pixelZone,
  viewContentName,
  safeParams,
  type BrowserMetaEvent,
  type MetaParams,
  type MetaStandardEvent,
  type MetaCustomEvent,
  CUSTOM_EVENTS,
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

/** Batch 71: a choice (Accept or Decline) is kept this long; then the banner asks again. */
export const CONSENT_DAYS = 180;
const CONSENT_MS = CONSENT_DAYS * 864e5;

/**
 * The visitor's choice, in the same storage key as Batch 70, now with the
 * time it was made ("accepted:1731300000000"). A choice older than 180 days
 * reads as no choice (the banner asks again; the pixel waits for a new
 * Accept). A Batch 70 value without a time counts from now.
 */
export function readConsent(now: number = Date.now()): Consent {
  try {
    const raw = storage()?.getItem(CONSENT_KEY) ?? null;
    if (raw === "accepted" || raw === "declined") {
      storage()?.setItem(CONSENT_KEY, `${raw}:${now}`);
      return raw;
    }
    const m = /^(accepted|declined):(\d{10,16})$/.exec(raw ?? "");
    if (!m) return null;
    const at = Number(m[2]);
    if (!(now - at < CONSENT_MS) || at > now + 864e5) return null;
    return m[1] as "accepted" | "declined";
  } catch {
    return null;
  }
}

export function writeConsent(value: "accepted" | "declined", now: number = Date.now()): void {
  try {
    storage()?.setItem(CONSENT_KEY, `${value}:${now}`);
  } catch {
    // a blocked store just asks again next visit
  }
}

// ------------------------------------------------------------ banner timing

/** Batch 71: the banner waits for 30% of the page scrolled or 6 seconds, whichever comes first. */
export const BANNER_SCROLL_FRACTION = 0.3;
export const BANNER_DELAY_MS = 6000;

type ScrollWindow = {
  scrollY: number;
  innerHeight: number;
  document: { documentElement: { scrollHeight: number } };
  addEventListener: (t: string, fn: () => void, o?: AddEventListenerOptions) => void;
  removeEventListener: (t: string, fn: () => void, o?: AddEventListenerOptions) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

/** How far down the page the visitor is: 0 at the top, 1 at the bottom (0 when it can't scroll). */
export function scrolledFraction(
  win: Pick<ScrollWindow, "scrollY" | "innerHeight" | "document">,
): number {
  const room = win.document.documentElement.scrollHeight - win.innerHeight;
  return room > 0 ? Math.min(1, Math.max(0, win.scrollY / room)) : 0;
}

/**
 * Calls `onDue` once: when 30% of the page has been scrolled, or after 6
 * seconds, whichever comes first. Returns the clean-up.
 */
export function scheduleBanner(win: ScrollWindow, onDue: () => void): () => void {
  let done = false;
  let timer: number | null = null;
  const fire = () => {
    if (done) return;
    done = true;
    cleanup();
    onDue();
  };
  const onScroll = () => {
    if (scrolledFraction(win) >= BANNER_SCROLL_FRACTION) fire();
  };
  const cleanup = () => {
    win.removeEventListener("scroll", onScroll, { passive: true });
    if (timer !== null) win.clearTimeout(timer);
  };
  win.addEventListener("scroll", onScroll, { passive: true });
  timer = win.setTimeout(fire, BANNER_DELAY_MS);
  return () => {
    done = true;
    cleanup();
  };
}

/** Sign-up tells the banner its form was submitted (it never shows while the form is being filled). */
export const SIGNUP_SUBMITTED_EVENT = "aidwar:signup-submitted";
let signupSubmittedFlag = false;

export function signupSubmitted(): void {
  signupSubmittedFlag = true;
  try {
    window.dispatchEvent(new Event(SIGNUP_SUBMITTED_EVENT));
  } catch {
    // never breaks sign-up
  }
}

export function signupWasSubmitted(): boolean {
  return signupSubmittedFlag;
}

/**
 * Whether the banner is on screen: a public page, no choice yet, its time has
 * come (scroll / 6 s), and on /signup only once the form was submitted.
 */
export function bannerVisible(input: {
  zone: "public" | "quiet" | null;
  consent: Consent | "unread";
  due: boolean;
  pathname: string;
  signupSubmitted: boolean;
}): boolean {
  if (input.zone !== "public" || input.consent !== null) return false;
  const signup = (input.pathname.replace(/\/+$/, "") || "/") === "/signup";
  if (signup) return input.signupSubmitted;
  return input.due;
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
  event: MetaStandardEvent | MetaCustomEvent,
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
      // Batch 75: a custom event (LeadQualified) goes as trackCustom.
      const kind = (CUSTOM_EVENTS as readonly string[]).includes(event) ? "trackCustom" : "track";
      (window as MetaWindow).fbq?.(kind, event, safe, { eventID: eventId });
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

/**
 * Account created (signup): CompleteRegistration and, Batch 72, the person's
 * Lead (same id as their /start or /demo Lead: "Lead." + sha256 of the
 * number). The server sends its copies whatever the cookie choice (sign-up
 * terms); the pixel only after Accept.
 */
export function trackRegistration(userId: string, phone: string | null = null): void {
  track("CompleteRegistration", metaEventId("CompleteRegistration", userId), {}, { once: true });
  void leadEventId(phone, userId)
    .then((id) =>
      track("Lead", id, { content_name: "signup", lead_source: "signup" }, { once: true }),
    )
    .catch(() => undefined);
  try {
    void fetch("/api/public/meta-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "CompleteRegistration",
        user_id: userId,
        url: window.location.href.split("#")[0],
        ...fbclidForLead(),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // never breaks sign-up
  }
}

const FBCLID_KEY = "aidwar.fbclid";

/**
 * Batch 72: the fbclid a visitor arrived with from a Meta ad, kept in this
 * tab (sessionStorage) with the time, so the server can build fbc for its
 * Lead. Never sent anywhere else and never stored on our side.
 */
export function rememberFbclid(): void {
  try {
    const id = new URLSearchParams(window.location.search).get("fbclid");
    if (id && /^[A-Za-z0-9_-]{10,500}$/.test(id))
      window.sessionStorage.setItem(FBCLID_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // no storage, no fbc
  }
}

/** The kept fbclid for a form's request body ({} when none). */
export function fbclidForLead(): { fbclid?: string; fbclid_at?: number } {
  try {
    const raw = window.sessionStorage.getItem(FBCLID_KEY);
    const v = raw ? (JSON.parse(raw) as { id?: string; at?: number }) : null;
    return v?.id && v.at ? { fbclid: v.id, fbclid_at: v.at } : {};
  } catch {
    return {};
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
