import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { NightStory } from "@/components/start/night-story";
import { StartBento } from "@/components/start/start-bento";
import { StartHero } from "@/components/start/start-hero";
import {
  Faq,
  FinalCta,
  HowItWorks,
  Leaks,
  LogoMarquee,
  PricingCard,
  Proof,
} from "@/components/start/start-sections";
import { StartStickyBar } from "@/components/start/start-sticky-bar";
import { lowestPaidPrice, pricingTeaser, rupees, type StartPlan } from "@/lib/start-page";
import { pricingHeadline } from "@/lib/start-story";
import { START_CSS } from "@/components/start/start-css";

/**
 * Batch 72/73: /start — the Meta-ads landing page. One job: a WhatsApp number
 * in the form (two-step sign-up, Lead/CAPI as Batch 72). Batch 73 is design,
 * motion and copy only: dark → light rhythm, a pinned "while you sleep"
 * story, animated tiles. No site navigation: the logo is not a link and the
 * footer is Privacy · Terms · ©. The page's own stylesheet is inlined, so it
 * costs no request and adds nothing to the site-wide CSS.
 */
export function StartPage({
  plans,
  gstRegistered,
}: {
  plans: StartPlan[];
  gstRegistered: boolean;
}) {
  const heroForm = useRef<HTMLFormElement | null>(null);
  const finalForm = useRef<HTMLFormElement | null>(null);
  const low = lowestPaidPrice(plans);
  const headline = pricingHeadline(low === null ? null : rupees(low), gstRegistered);
  const teaser = pricingTeaser(plans, gstRegistered);
  const toForm = () => {
    heroForm.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    heroForm.current
      ?.querySelector<HTMLInputElement>("input[name=name]")
      ?.focus({ preventScroll: true });
  };

  return (
    <div className="s73 min-h-screen overflow-x-clip bg-background text-foreground antialiased">
      <style dangerouslySetInnerHTML={{ __html: START_CSS }} />
      <StartHero ref={heroForm} />
      <main>
        <LogoMarquee />
        <NightStory />
        <Leaks />
        <StartBento />
        <Proof />
        <HowItWorks />
        <PricingCard headline={headline} onStart={toForm} />
        <Faq pricing={teaser} />
        <FinalCta ref={finalForm} />
      </main>

      <footer className="bg-[#06120e] px-4 pb-28 pt-2 text-center text-sm text-white/65 md:pb-10">
        <Link to="/privacy" className="underline-offset-2 hover:underline">
          Privacy
        </Link>
        {" · "}
        <Link to="/terms" className="underline-offset-2 hover:underline">
          Terms
        </Link>
        {" · "}© Meezoy Ventures Pvt Ltd
      </footer>

      <StartStickyBar heroForm={heroForm} finalForm={finalForm} />
    </div>
  );
}
