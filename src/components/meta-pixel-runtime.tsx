import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { pixelZone } from "@/lib/meta-events";
import {
  contactClicked,
  ensurePixel,
  pageChanged,
  readConsent,
  writeConsent,
  type Consent,
} from "@/lib/meta-pixel";

/**
 * Batch 70: the Meta Pixel's place in the page. On public pages: the cookie
 * banner (until Accept or Decline), a PageView on every page change, and
 * Contact on a click of our email / phone / WhatsApp links. On /login, the
 * onboarding and billing steps: nothing here (those steps fire their one
 * conversion themselves). On /app working pages and /admin: nothing at all.
 */
export function MetaPixelRuntime() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const zone = pixelZone(pathname);
  const [consent, setConsent] = useState<Consent | "unread">("unread");

  useEffect(() => {
    setConsent(readConsent());
  }, []);

  useEffect(() => {
    if (consent === "accepted" && zone === "public") pageChanged(pathname);
  }, [consent, pathname, zone]);

  useEffect(() => {
    if (consent !== "accepted" || zone !== "public") return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (a) contactClicked(a.getAttribute("href"), window.location.pathname);
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, [consent, zone]);

  if (zone !== "public" || consent !== null) return null;

  const choose = (value: "accepted" | "declined") => {
    writeConsent(value);
    setConsent(value);
    if (value === "accepted") ensurePixel();
  };

  return (
    <div
      role="region"
      aria-label="Cookies"
      data-testid="meta-consent-banner"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-foreground">
          We use cookies to measure our ads.{" "}
          <Link to="/privacy" className="text-primary underline underline-offset-2">
            Privacy
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => choose("declined")}
            className="min-h-10 rounded-full border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-muted"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => choose("accepted")}
            className="min-h-10 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
