import { Suspense, lazy, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { HERO, faq, stickyVisible } from "@/lib/page-999";
import { P999_CSS } from "@/components/p999/p999-css";
import { MagneticCta, Reveal, useParallax, usePlaying } from "@/components/p999/p999-motion";
import {
  Faq,
  FinalCta,
  Footer,
  Guarantee,
  LiveIn10,
  MetaNote,
  Proof,
  SectionHead,
  StickyBar,
  WhatYouGet,
} from "@/components/p999/sections-999";

/**
 * Batch 80: /999 — AiDwar Basic, ₹999/month, pay Meta directly. One job: the
 * buyer pays ₹999 in a one-screen checkout without leaving the page.
 *
 * Performance is part of the effect: the hero (headline, button) is plain
 * server-rendered text with CSS-only motion; the live demo, the calculator
 * and the checkout sheet are their own lazy chunks — the demo and the
 * calculator load after the hero paints, the checkout is fetched while the
 * page is idle (and again on the first hover/touch of a button) so it opens
 * at once. No site navigation: the logo is not a link; the footer is
 * Privacy · Terms · Refunds · ©.
 */

const loadDemo = () => import("@/components/p999/demo-999");
const loadCalc = () => import("@/components/p999/calculator-999");
const loadCheckout = () => import("@/components/p999/checkout-999");
const Demo999 = lazy(loadDemo);
const Calculator999 = lazy(loadCalc);
const Checkout999 = lazy(loadCheckout);

/** Warms the checkout chunk and the payment SDK's code (no network to Cashfree yet). */
let warmed = false;
function warmCheckout(): void {
  if (warmed) return;
  warmed = true;
  void loadCheckout().catch(() => {
    warmed = false;
  });
  void import("@cashfreepayments/cashfree-js").catch(() => undefined);
  void import("motion/react").catch(() => undefined);
}

function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

/** The headline, word by word (CSS only; reduced motion shows it at once). */
function Headline() {
  const words = HERO.headline.split(" ");
  const accentFrom = words.length - 2; // "on WhatsApp."
  return (
    <h1 className="p9-h1 text-[3rem] font-extrabold text-white min-[400px]:text-[3.35rem] sm:text-[4.5rem] lg:text-[5.25rem]">
      {words.map((w, i) => (
        <span key={`${w}-${i}`}>
          <span
            className={i >= accentFrom ? "p9-word p9-shine" : "p9-word"}
            style={{ ["--i" as string]: i }}
          >
            {w}
          </span>
          {i < words.length - 1 ? " " : null}
        </span>
      ))}
    </h1>
  );
}

function DemoFallback() {
  return (
    <div aria-hidden="true" className="w-full">
      <div className="flex gap-2 overflow-hidden">
        {[88, 74, 104, 118].map((w) => (
          <span
            key={w}
            className="h-[38px] flex-none rounded-full bg-white/[0.06]"
            style={{ width: w }}
          />
        ))}
      </div>
      <div className="mx-auto mt-6 h-[479px] w-full max-w-[300px] rounded-[2.6rem] bg-white/[0.04]" />
      <div className="mt-6 h-[20px]" />
    </div>
  );
}

export function Page999({
  rates,
  aidenLink,
  returningPaymentId,
}: {
  rates: { marketing: number; utility: number; effective_from: string | null };
  aidenLink: string | null;
  returningPaymentId: string | null;
}) {
  const heroCta = useRef<HTMLDivElement | null>(null);
  const finalCta = useRef<HTMLDivElement | null>(null);
  const heroVisible = useVisible(heroCta);
  const finalVisible = useVisible(finalCta);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { ref: heroRef, play } = usePlaying<HTMLElement>();
  const phoneCol = useParallax<HTMLDivElement>(0.05);

  // Idle: fetch the checkout so it opens at once.
  useEffect(() => {
    const idle =
      (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
    const onScroll = () => warmCheckout();
    window.addEventListener("scroll", onScroll, { once: true, passive: true });
    idle(() => warmCheckout(), { timeout: 2500 });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Back from a Cashfree page (redirect fallback): reopen the sheet to confirm.
  useEffect(() => {
    if (returningPaymentId) {
      setMounted(true);
      setOpen(true);
    }
  }, [returningPaymentId]);

  const start = useCallback(() => {
    warmCheckout();
    setMounted(true);
    setOpen(true);
    void import("@/lib/meta-pixel")
      .then((m) => m.trackInitiateCheckout999())
      .catch(() => undefined);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="p9 min-h-screen overflow-x-clip bg-[var(--ink)] antialiased">
      <style dangerouslySetInnerHTML={{ __html: P999_CSS }} />

      <header ref={heroRef} data-play={play} className="p9-dark relative overflow-hidden">
        <div aria-hidden="true" className="p9-aurora">
          <i />
          <i />
          <i />
        </div>
        <div aria-hidden="true" className="p9-grid" />
        <div aria-hidden="true" className="p9-grain" />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-6 lg:pb-28">
          <div className="flex items-center justify-between">
            <span
              className="text-[1.3rem] font-extrabold tracking-tight text-white"
              aria-label="AiDwar"
            >
              Ai<span className="text-[var(--mint)]">Dwar</span>
            </span>
            <span className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[12px] font-semibold text-white/80">
              ₹999/month · zero markup
            </span>
          </div>

          <div className="mt-8 grid items-center gap-12 lg:mt-16 lg:grid-cols-[1.1fr_0.9fr] lg:gap-10">
            <div className="min-w-0 text-center lg:text-left">
              <p
                className="p9-fade inline-flex items-center gap-2 rounded-full border border-[var(--mint)]/30 bg-[var(--mint-soft)] px-3.5 py-1.5 text-[13px] font-bold text-[var(--mint)]"
                style={{ ["--d" as string]: "0s" }}
              >
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--mint)] opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--mint)]" />
                </span>
                {HERO.kicker} · AI replies included
              </p>
              <div className="mt-5">
                <Headline />
              </div>
              <p
                className="p9-fade mx-auto mt-5 max-w-xl text-[18px] leading-relaxed text-white/75 sm:text-[20px] lg:mx-0"
                style={{ ["--d" as string]: "0.45s" }}
              >
                <strong className="font-extrabold text-white">₹999/month.</strong> Pay Meta directly
                — we add <span className="text-[var(--mint)]">zero markup</span> on messages.
              </p>
              <div
                ref={heroCta}
                className="p9-fade mt-8 flex flex-col items-center gap-3 lg:items-start"
                style={{ ["--d" as string]: "0.6s" }}
              >
                <MagneticCta
                  onClick={start}
                  onPointerEnter={warmCheckout}
                  onTouchStart={warmCheckout}
                  className="w-full max-w-sm text-[18px] min-h-[3.75rem]"
                  data-testid="hero-cta"
                >
                  Start for ₹999{" "}
                  <span className="p9-arrow" aria-hidden="true">
                    →
                  </span>
                </MagneticCta>
                <p className="text-[13.5px] font-medium text-white/60">{HERO.small}</p>
              </div>
            </div>

            <div ref={phoneCol} className="p9-par min-w-0">
              <Suspense fallback={<DemoFallback />}>
                <Demo999 aidenLink={aidenLink} />
              </Suspense>
            </div>
          </div>
        </div>
      </header>

      <main>
        <section
          className="p9-paper px-4 pb-20 pt-20 sm:px-6 sm:pb-28 sm:pt-28"
          aria-labelledby="p9-calc"
        >
          <SectionHead
            id="p9-calc"
            kicker="Zero-markup calculator"
            title="You pay Meta. Not us."
            sub="Other tools resell Meta's messages with 20–40% on top. We don't touch your message bill."
          />
          <Reveal className="mx-auto mt-10 max-w-xl">
            <Suspense
              fallback={<div className="h-[640px] rounded-[1.75rem] bg-white" aria-hidden="true" />}
            >
              <Calculator999 rates={rates} />
            </Suspense>
          </Reveal>
        </section>
        <WhatYouGet />
        <LiveIn10 />
        <Proof />
        <MetaNote />
        <Guarantee />
        <Faq items={faq(rates)} />
        <FinalCta ref={finalCta} onStart={start} onWarm={warmCheckout} />
      </main>
      <Footer />

      <StickyBar
        on={stickyVisible({
          heroCtaVisible: heroVisible,
          finalCtaVisible: finalVisible,
          checkoutOpen: open,
        })}
        onStart={start}
        onWarm={warmCheckout}
      />

      {mounted ? (
        <Suspense fallback={null}>
          <Checkout999 open={open} onClose={close} returningPaymentId={returningPaymentId} />
        </Suspense>
      ) : null}
    </div>
  );
}
