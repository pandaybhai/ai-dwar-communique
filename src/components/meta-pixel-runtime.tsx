import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ConsentBanner } from "@/components/consent-banner";
import { pixelZone } from "@/lib/meta-events";
import {
  SIGNUP_SUBMITTED_EVENT,
  bannerVisible,
  contactClicked,
  ensurePixel,
  pageChanged,
  readConsent,
  rememberFbclid,
  scheduleBanner,
  signupWasSubmitted,
  writeConsent,
  type Consent,
} from "@/lib/meta-pixel";

/**
 * Batch 70: the Meta Pixel's place in the page. On public pages: the cookie
 * banner (until Accept or Decline), a PageView on every page change, and
 * Contact on a click of our email / phone / WhatsApp links. On /login, the
 * onboarding and billing steps: nothing here (those steps fire their one
 * conversion themselves). On /app working pages and /admin: nothing at all.
 *
 * Batch 71: the banner is not shown on first paint. It comes after 30% of the
 * page is scrolled or after 6 seconds, whichever is first, and on /signup only
 * once the form was submitted (never while it is being filled in).
 */
export function MetaPixelRuntime() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const zone = pixelZone(pathname);
  const [consent, setConsent] = useState<Consent | "unread">("unread");

  const [due, setDue] = useState(false);
  const [signupDone, setSignupDone] = useState(false);

  useEffect(() => {
    // Batch 72: an ad click's fbclid, kept for the server's Lead (fbc) only.
    rememberFbclid();
    setConsent(readConsent());
    setSignupDone(signupWasSubmitted());
    const onSignup = () => setSignupDone(true);
    window.addEventListener(SIGNUP_SUBMITTED_EVENT, onSignup);
    return () => window.removeEventListener(SIGNUP_SUBMITTED_EVENT, onSignup);
  }, []);

  // Once a public page has been read for a moment (scrolled 30% or 6 s).
  const waiting = zone === "public" && consent === null && !due;
  useEffect(() => {
    if (!waiting) return;
    return scheduleBanner(window, () => setDue(true));
  }, [waiting]);

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

  if (!bannerVisible({ zone, consent, due, pathname, signupSubmitted: signupDone })) return null;

  const choose = (value: "accepted" | "declined") => {
    writeConsent(value);
    setConsent(value);
    if (value === "accepted") ensurePixel();
  };

  return <ConsentBanner onChoose={choose} />;
}
