import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 71 — the cookie banner's wording and timing (copy + timing only).
 * Fakes only: a fake window (scroll, timers, storage), fbq never real.
 */

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: unknown }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
}));

import { ConsentBanner } from "@/components/consent-banner";

type Listener = () => void;

function fakeScrollWindow(scrollHeight: number, innerHeight = 800) {
  const listeners = new Map<string, Set<Listener>>();
  const win = {
    scrollY: 0,
    innerHeight,
    document: { documentElement: { scrollHeight } },
    addEventListener: (t: string, fn: Listener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: Listener) => listeners.get(t)?.delete(fn),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    scrollTo(y: number) {
      win.scrollY = y;
      for (const fn of listeners.get("scroll") ?? []) fn();
    },
    listenerCount: (t: string) => listeners.get(t)?.size ?? 0,
  };
  return win;
}

function fakeStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return { store, localStorage };
}

async function pixel() {
  vi.resetModules();
  return import("./meta-pixel");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("timing: after 30% scrolled or 6 seconds, whichever comes first", () => {
  it("not before 6 s; at 6 s it is due (a short page that can't scroll)", async () => {
    vi.useFakeTimers();
    const m = await pixel();
    const win = fakeScrollWindow(600); // shorter than the screen
    const onDue = vi.fn();
    m.scheduleBanner(win, onDue);
    vi.advanceTimersByTime(5999);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(win.listenerCount("scroll")).toBe(0);
  });

  it("29% scrolled is not enough; 30% shows it at once, before 6 s, and only once", async () => {
    vi.useFakeTimers();
    const m = await pixel();
    const win = fakeScrollWindow(10_800); // 10,000 px of room to scroll
    const onDue = vi.fn();
    m.scheduleBanner(win, onDue);
    win.scrollTo(2900);
    vi.advanceTimersByTime(1000);
    expect(onDue).not.toHaveBeenCalled();
    win.scrollTo(3000);
    expect(onDue).toHaveBeenCalledTimes(1);
    win.scrollTo(9000);
    vi.advanceTimersByTime(10_000);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("leaving the page first cancels it (nothing fires later)", async () => {
    vi.useFakeTimers();
    const m = await pixel();
    const win = fakeScrollWindow(10_800);
    const onDue = vi.fn();
    const stop = m.scheduleBanner(win, onDue);
    stop();
    win.scrollTo(9000);
    vi.advanceTimersByTime(10_000);
    expect(onDue).not.toHaveBeenCalled();
  });

  it("not on first paint; never on /signup until the form was sent; never off public pages", async () => {
    const m = await pixel();
    const base = { zone: "public" as const, consent: null, pathname: "/", signupSubmitted: false };
    expect(m.bannerVisible({ ...base, due: false })).toBe(false); // first paint
    expect(m.bannerVisible({ ...base, due: true })).toBe(true);
    expect(m.bannerVisible({ ...base, pathname: "/signup", due: true })).toBe(false); // typing
    expect(
      m.bannerVisible({ ...base, pathname: "/signup", due: false, signupSubmitted: true }),
    ).toBe(true);
    expect(m.bannerVisible({ ...base, consent: "declined", due: true })).toBe(false);
    expect(m.bannerVisible({ ...base, consent: "accepted", due: true })).toBe(false);
    expect(m.bannerVisible({ ...base, consent: "unread", due: true })).toBe(false);
    expect(m.bannerVisible({ ...base, zone: "quiet", pathname: "/login", due: true })).toBe(false);
    expect(m.bannerVisible({ ...base, zone: null, pathname: "/app/inbox", due: true })).toBe(false);
  });

  it("sign-up tells the banner once its form was sent", async () => {
    const events: string[] = [];
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) });
    const m = await pixel();
    expect(m.signupWasSubmitted()).toBe(false);
    m.signupSubmitted();
    expect(m.signupWasSubmitted()).toBe(true);
    expect(events).toEqual([m.SIGNUP_SUBMITTED_EVENT]);
  });
});

describe("the choice: remembered 180 days (same key), Decline never loads the pixel", () => {
  const DAY = 864e5;
  const T0 = Date.parse("2026-11-11T10:00:00Z");

  it("either choice is kept for 180 days, then the banner asks again", async () => {
    const { store, localStorage } = fakeStorage();
    vi.stubGlobal("window", { localStorage, location: { pathname: "/" } });
    const m = await pixel();
    m.writeConsent("declined", T0);
    expect(store.get(m.CONSENT_KEY)).toBe(`declined:${T0}`);
    expect(m.readConsent(T0 + 179 * DAY)).toBe("declined");
    expect(m.readConsent(T0 + 181 * DAY)).toBeNull();
    m.writeConsent("accepted", T0);
    expect(m.readConsent(T0 + 179 * DAY)).toBe("accepted");
    expect(m.readConsent(T0 + 181 * DAY)).toBeNull();
  });

  it("a Batch 70 choice (no date) is kept and counts its 180 days from now", async () => {
    const { store, localStorage } = fakeStorage();
    vi.stubGlobal("window", { localStorage, location: { pathname: "/" } });
    const m = await pixel();
    store.set(m.CONSENT_KEY, "accepted");
    expect(m.readConsent(T0)).toBe("accepted");
    expect(store.get(m.CONSENT_KEY)).toBe(`accepted:${T0}`);
    expect(m.readConsent(T0 + 181 * DAY)).toBeNull();
  });

  it("Decline: fbq never loads; Accept: it does", async () => {
    const { localStorage } = fakeStorage();
    const scripts: string[] = [];
    const win: Record<string, unknown> = {
      localStorage,
      location: { pathname: "/pricing", href: "https://aidwar.in/pricing" },
      addEventListener: () => undefined,
      requestIdleCallback: (cb: () => void) => cb(),
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      readyState: "complete",
      head: { appendChild: (el: { src: string }) => scripts.push(el.src) },
      createElement: () => ({ async: false, src: "" }),
      querySelector: () => null,
    });
    vi.stubGlobal("fetch", async () => new Response("{}"));
    const m = await pixel();
    m.writeConsent("declined");
    m.pageChanged("/pricing");
    expect(m.ensurePixel()).toBe(false);
    expect(win["fbq"]).toBeUndefined();
    expect(scripts).toEqual([]);
    m.writeConsent("accepted");
    expect(m.ensurePixel()).toBe(true);
    expect(typeof win["fbq"]).toBe("function");
    expect(scripts).toEqual(["https://connect.facebook.net/en_US/fbevents.js"]);
  });
});

describe("the words and the buttons", () => {
  const html = renderToStaticMarkup(<ConsentBanner onChoose={() => undefined} />);
  const button = (testId: string) =>
    new RegExp(`<button[^>]*data-testid="${testId}"[^>]*class="([^"]*)"`).exec(html)?.[1] ?? "";

  it("the new copy and the Privacy link", () => {
    expect(html).toContain("We use cookies to show you relevant offers and improve AiDwar.");
    expect(html).toMatch(/<a href="\/privacy"[^>]*>Privacy<\/a>/);
    expect(html).not.toContain("measure our ads");
  });

  it("Accept is filled in the brand colour; Decline is a plain text button of the same size and tap target, fully visible", () => {
    const accept = button("consent-accept");
    const decline = button("consent-decline");
    expect(accept).toMatch(/\bbg-primary\b/);
    expect(accept).toMatch(/\btext-primary-foreground\b/);
    for (const size of [
      "min-h-11",
      "min-w-28",
      "flex-1",
      "px-5",
      "text-sm",
      "font-semibold",
      "rounded-full",
      "sm:flex-none",
    ]) {
      expect(accept.split(/\s+/), size).toContain(size);
      expect(decline.split(/\s+/), size).toContain(size);
    }
    // Plain text, full-strength colour: no fill, no border, never hidden, greyed or disabled.
    expect(decline).toMatch(/\btext-foreground\b/);
    expect(decline).not.toMatch(
      /\bbg-(?!muted)|\bborder\b|opacity|text-muted|hidden|sr-only|invisible/,
    );
    expect(html).not.toMatch(/disabled/);
    // Decline first, Accept second, both in one row (each half the width on a phone).
    expect(html.indexOf("consent-decline")).toBeLessThan(html.indexOf("consent-accept"));
  });
});
