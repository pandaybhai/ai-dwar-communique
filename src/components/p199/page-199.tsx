import { Suspense, lazy, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { stickyVisible } from "@/lib/page-999";
import { AFTER_30_DAYS, HERO_199 as HERO, faq199 } from "@/lib/page-199";
import { P999_CSS } from "@/components/p999/p999-css";
import { cn } from "@/lib/utils";
import { ensureAppCss } from "@/lib/lean-css";
import appCss from "../../styles.css?url";
import { MagneticCta, Reveal, useParallax, usePlaying } from "@/components/p999/p999-motion";
import {
  Faq,
  FinalCta,
  Footer,
  Guarantee,
  LiveIn10,
  MetaNote,
  PriceBlock,
  Proof,
  SectionHead,
  StickyBar,
  WhatYouGet,
} from "@/components/p199/sections-199";

/**
 * Batch 82: /199 — pay ₹199 for 30 days of AiDwar Basic; our team calls to set
 * it up and help choose a plan. A copy of /999 (page-999.tsx: the same layout,
 * motion, live demo, calculator, FAQ, sticky bar and one-screen checkout) with
 * this page's words and its own checkout (/api/public/checkout-199). /999 is
 * untouched.
 *
 * Batch 80 (/999, copied from): One job: the buyer pays in a one-screen
 * checkout without leaving the page.
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
const loadCheckout = () => import("@/components/p199/checkout-199");
const Demo999 = lazy(loadDemo);
const Calculator999 = lazy(loadCalc);
const Checkout199 = lazy(loadCheckout);

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

export function Page199({
  rates,
  aidenLink,
  returningPaymentId,
  adminTestPrice = null,
  resume = false,
}: {
  rates: { marketing: number; utility: number; effective_from: string | null };
  aidenLink: string | null;
  returningPaymentId: string | null;
  /** /199?admin_test_price=1 — the server decides whether it's allowed (Super Admin). */
  adminTestPrice?: 1 | null;
  /** /199?resume=1 — back from the emailed log-in link. */
  resume?: boolean;
}) {
  const heroCta = useRef<HTMLDivElement | null>(null);
  const finalCta = useRef<HTMLDivElement | null>(null);
  const heroVisible = useVisible(heroCta);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { ref: heroRef, play } = usePlaying<HTMLElement>();
  const phoneCol = useParallax<HTMLDivElement>(0.05);

  // Batch 81: this page paints from its own CSS; the app sheet is attached
  // by the root's loader, or here after a client-side navigation in.
  useEffect(() => ensureAppCss(appCss), []);

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
      .then((m) => m.trackInitiateCheckout199())
      .catch(() => undefined);
  }, []);
  // Closed with something typed and not paid → "Finish setup — ₹199".
  const [unfinished, setUnfinished] = useState(false);
  const close = useCallback((state?: { typed: boolean; paid: boolean }) => {
    setOpen(false);
    if (state && state.typed && !state.paid) setUnfinished(true);
  }, []);

  // Batch 81: back from the emailed log-in link (?resume=1) — straight into the checkout.
  useEffect(() => {
    if (resume) start();
    // once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Batch 81: how far down the page (the bar shows from 30%).
  const [scrolled, setScrolled] = useState(0);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrolled(max > 0 ? window.scrollY / max : 0);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

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
              ₹199 · 30 days · zero markup
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
              {/* Batch 81: the price is the hero. */}
              <div
                className="p9-fade mx-auto mt-6 max-w-md lg:mx-0"
                style={{ ["--d" as string]: "0.35s" }}
                data-testid="hero-price"
              >
                <p className="flex items-baseline justify-center gap-1.5 lg:justify-start">
                  <span className="text-[4.25rem] font-extrabold leading-none tracking-[-0.05em] text-white sm:text-[5.25rem]">
                    {HERO.price}
                  </span>
                </p>
                <p className="mt-2 text-[15px] font-medium leading-snug text-white/75">
                  {HERO.priceLine}
                </p>
              </div>
              <div
                ref={heroCta}
                className="p9-fade mt-7 flex flex-col items-center gap-3 lg:items-start"
                style={{ ["--d" as string]: "0.5s" }}
              >
                <MagneticCta
                  onClick={start}
                  onPointerEnter={warmCheckout}
                  onTouchStart={warmCheckout}
                  className="w-full max-w-sm text-[18px] min-h-[3.75rem]"
                  data-testid="hero-cta"
                >
                  {HERO.cta}{" "}
                  <span className="p9-arrow" aria-hidden="true">
                    →
                  </span>
                </MagneticCta>
                <p className="text-[13.5px] font-medium text-white/60">{HERO.small}</p>
              </div>
            </div>

            <div
              ref={phoneCol}
              className={cn("p9-par min-w-0", aidenLink ? "min-h-[684px]" : "min-h-[628px]")}
            >
              <Suspense fallback={<DemoFallback />}>
                <Demo999 aidenLink={aidenLink} />
              </Suspense>
            </div>
          </div>
        </div>
      </header>

      <main>
        {/* Batch 81: price + CTA after the demo, the calculator and "What you get". */}
        <PriceBlock where="demo" dark onStart={start} onWarm={warmCheckout} />
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
        <PriceBlock where="calculator" onStart={start} onWarm={warmCheckout} />
        <WhatYouGet />
        <PriceBlock where="get" onStart={start} onWarm={warmCheckout} />
        <LiveIn10 />
        <Proof />
        <MetaNote />
        <Guarantee />
        {/* The one honest line about what happens after the 30 days. */}
        <section className="p9-paper px-4 pt-16 sm:px-6" aria-label="After 30 days">
          <p
            className="mx-auto max-w-2xl rounded-2xl border border-[#04100b]/10 bg-white px-5 py-4 text-center text-[15.5px] font-semibold leading-relaxed text-[#04100b]"
            data-testid="after-30-days"
          >
            {AFTER_30_DAYS}
          </p>
        </section>
        <Faq items={faq199(rates)} />
        <FinalCta ref={finalCta} onStart={start} onWarm={warmCheckout} />
      </main>
      <Footer />

      <StickyBar
        on={stickyVisible({
          scrolledFraction: scrolled,
          heroCtaVisible: heroVisible,
          checkoutOpen: open,
        })}
        finishSetup={unfinished}
        onStart={start}
        onWarm={warmCheckout}
      />

      {mounted ? (
        <Suspense fallback={null}>
          <Checkout199
            open={open}
            onClose={close}
            returningPaymentId={returningPaymentId}
            adminTestPrice={adminTestPrice}
            resumed={resume}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
