import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 73 — /start v2: cinematic motion and sharper copy on the same page and
 * the same funnel. Server render only (no browser): the H1 and the form are
 * never hidden, every resting state is the final frame, reduced motion runs no
 * animation, the story's step → phone mapping, the copy, and no % claims. The
 * funnel itself (form → demo_leads → /signup, Lead/CAPI) stays covered,
 * unchanged, by batch72-start.test.tsx.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, className, children }: { to: string; className?: string; children: unknown }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
  useNavigate: () => async () => undefined,
}));

import { StartPage } from "@/components/start/start-page";
import { START_CSS } from "@/components/start/start-css";
import {
  BUILT_FOR,
  HERO_CHIPS,
  PRICING_SUB,
  STORY_STEPS,
  activeStoryStep,
  heroChipsShown,
  pricingHeadline,
  storyPhone,
} from "./start-story";

const PLANS = [
  { key: "starter", name: "Starter", currency: "INR", price_monthly: 2499 },
  { key: "growth", name: "Growth", currency: "INR", price_monthly: 4999 },
];

const html = renderToStaticMarkup(<StartPage plans={PLANS} gstRegistered={false} />);
/** Visible text: no <style>, no tags, entities decoded. */
const text = html
  .replace(/<style[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

describe("the H1 and the form paint at once from the server", () => {
  it("the H1 is the brief's line and nothing on its path is hidden or moved", () => {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    expect(h1).not.toBeNull();
    expect(h1![1]!.replace(/<[^>]+>/g, "")).toBe("Your next 100 sales are already in WhatsApp.");
    expect(h1![0]).not.toMatch(/style=|opacity|translate|data-shown|data-on/);
    // Everything opened before the hero form ends: no reveal wrapper, no hidden state.
    const heroStart = html.indexOf("<header");
    const heroFormEnd = html.indexOf("</form>", heroStart);
    const hero = html.slice(heroStart, heroFormEnd);
    expect(hero).toContain("<form");
    // Batch 78: the card opens on step 1 — the "What do you sell?" tap cards.
    expect(hero).toContain('role="radio"');
    expect(hero).not.toMatch(/s73-reveal|opacity-0|data-shown="false"|invisible/);
  });

  it("every 'hidden until it plays' rule lives inside prefers-reduced-motion: no-preference", () => {
    const css = START_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(motion).toBeGreaterThan(0);
    const firstKeyframes = css.indexOf("@keyframes");
    // Rules outside the motion block (the @keyframes definitions only run from inside it).
    const outside = css.slice(0, motion);
    const block = css.slice(motion, firstKeyframes);
    // Outside the block: no animation, no transition, and none of the hidden-before-reveal states.
    expect(outside).not.toMatch(/animation|transition/);
    expect(css.slice(firstKeyframes)).not.toMatch(/^\s*\.s73/m);
    // (A story element that isn't part of the current step stays hidden — that's state, not motion.)
    expect(outside).not.toMatch(/data-shown="false"|translateY|scale\(/);
    // Inside: the reveals, the pop-ins, the loops — and loops pause off screen.
    expect(block).toMatch(/\.s73-reveal\[data-shown="false"\]/);
    expect(block).toMatch(/\[data-play="off"\][\s\S]*animation-play-state: paused/);
    // Tailwind animations on the page are motion-safe only (the send spinner shows only while sending).
    const loose = [...html.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1]!.split(/\s+/))
      .filter((c) => /^animate-/.test(c));
    expect(loose).toEqual([]);
  });

  it("the server's (and reduced motion's) frame is the finished one", () => {
    // The hero chat is complete and all four glass chips are in.
    expect(html).toContain("Order held · ₹1,34,500");
    for (const c of HERO_CHIPS) {
      expect(html).toMatch(new RegExp(`data-on="true">(<span[^>]*></span>)?${escape(c.text)}`));
    }
    // Numbers show their real value; the first "Built for" word is the one shown.
    expect(text).toContain("Sent 1,900");
    expect(text).toContain("1,900+");
    expect(html).toContain(`<span data-on="true">${BUILT_FOR[0]}</span>`);
    // The story starts at step 1, settled.
    expect(html).toContain('data-step="0"');
  });
});

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the night story: step → phone", () => {
  it("each step drives the phone and its clock", () => {
    expect(storyPhone(0)).toEqual({
      clock: "11:47 PM",
      question: true,
      typing: false,
      answer: false,
      yes: false,
      toast: false,
      assigned: false,
      morning: false,
      notifications: 0,
    });
    // Step 2: typing dots first, then the reply.
    expect(storyPhone(1, false)).toMatchObject({ clock: "11:47 PM", typing: true, answer: false });
    expect(storyPhone(1)).toMatchObject({ typing: false, answer: true, yes: false });
    // Step 3: yes, the toast and "Assigned to you".
    expect(storyPhone(2)).toMatchObject({
      clock: "11:48 PM",
      answer: true,
      yes: true,
      toast: true,
      assigned: true,
      morning: false,
    });
    // Step 4: morning, three notifications.
    expect(storyPhone(3)).toMatchObject({ clock: "9:02 AM", morning: true, notifications: 3 });
    // Out-of-range steps clamp; never a typing state once settled.
    expect(storyPhone(-2).clock).toBe("11:47 PM");
    expect(storyPhone(9).morning).toBe(true);
    for (let i = 0; i < STORY_STEPS.length; i++) expect(storyPhone(i).typing).toBe(false);
  });

  it("the step crossing the middle of the screen wins; nothing crossing keeps the last", () => {
    const steps = [{}, {}, {}, {}];
    expect(activeStoryStep(0, [{ isIntersecting: true, target: steps[2] }], steps)).toBe(2);
    expect(activeStoryStep(2, [{ isIntersecting: false, target: steps[2] }], steps)).toBe(2);
    expect(activeStoryStep(1, [{ isIntersecting: true, target: {} }], steps)).toBe(1);
  });

  it("the hero chips pop in as the chat reaches them", () => {
    expect(heroChipsShown(0)).toEqual({ reach: false, read: false, replied: false, late: false });
    expect(heroChipsShown(2)).toEqual({ reach: true, read: true, replied: false, late: false });
    expect(heroChipsShown(4)).toEqual({ reach: true, read: true, replied: true, late: true });
  });
});

describe("the copy", () => {
  it("has the brief's copy, in order", () => {
    const inOrder = [
      "Built for jewellers, boutiques, cafés, D2C brands, clinics and coaching institutes",
      "Your next 100 sales are already in WhatsApp.",
      "AiDwar sends your offers, replies to every customer in seconds, and brings buyers back — automatically, from your own WhatsApp number.",
      // Batch 78: the hero card opens on step 1 (questions first).
      "What do you sell?",
      "Free trial · No card · Live in 10 minutes",
      "Example",
      "Trusted by growing businesses",
      "ZOORI Jewels",
      "TalentDwar",
      "Meezoy",
      "Fanzart",
      "Your shop closes at 9. Your WhatsApp doesn't.",
      "A customer asks about the 22k chain they saw on Instagram.",
      "Aiden answers in 3 seconds — with your real price and stock.",
      "They say yes. Aiden holds it and tags you.",
      "You wake up to a sale, not a missed message.",
      "Illustrative example.",
      "Three leaks quietly costing you sales.",
      "Broadcasts nobody reads.",
      "Approved WhatsApp templates with images, buttons and offers — they land in the chat your customers already check all day.",
      "Messages at 11pm. Nobody replies.",
      "Aiden replies from your own products and prices, in Hindi, Hinglish or English — and hands over when it should.",
      "Customers buy once and vanish.",
      "Welcome flows, offer cards and follow-ups bring them back without you lifting a finger.",
      "Everything WhatsApp can do for your business. In one place.",
      "Send to thousands. Track every read.",
      "Answers in seconds. Day and night.",
      "Set it once. It runs forever.",
      "One number. Your whole team.",
      "Orders, invoices, COD confirmations — sent automatically.",
      "Run AiDwar from your AI assistant. You approve before anything sends.",
      "Live on AiDwar Growth · Hyderabad",
      "1,900+",
      "customers reached in one Diwali campaign",
      "Every invoice from their billing software now reaches the customer on WhatsApp — automatically.",
      "How it works",
      "Connect your number",
      "10 minutes, we guide you.",
      "Import customers",
      "A CSV from Excel or Google Sheets, +91 added for you.",
      "Send your first offer",
      "Or let Aiden start replying.",
      "Start free. Grow from ₹2,499/month.",
      "Pay for WhatsApp messages only when you send. Cancel anytime.",
      "Is this the official WhatsApp API?",
      "Can Aiden reply in Hindi or Telugu?",
      "Your customers are already on WhatsApp. Be there when they message.",
      "Privacy",
      "Terms",
      "© Meezoy Ventures Pvt Ltd",
    ];
    let at = 0;
    for (const phrase of inOrder) {
      const found = text.indexOf(phrase, at);
      expect(found, phrase).toBeGreaterThanOrEqual(0);
      at = found;
    }
  });

  it("no percentage or open-rate claims anywhere; dropped claims stay dropped", () => {
    expect(text).not.toContain("%");
    expect(text).not.toMatch(/open rate|open-rate/i);
    // Step 0: no setup-fee promise (nothing in our plans or terms says so), no
    // loyalty cards (no such card kind), no Excel import (CSV only).
    expect(text).not.toMatch(/setup fee/i);
    expect(text).not.toMatch(/loyalty/i);
    expect(text).not.toMatch(/Excel or CSV|Excel\/CSV/);
    // Brand rule (#78 review): AiDwar marketing never names other AI products.
    expect(text).not.toMatch(/claude|chatgpt/i);
    expect(html).not.toMatch(/claude|chatgpt/i);
    // "Order held" is the in-chat toast only, never also a glass chip.
    expect(HERO_CHIPS.map((c) => c.text)).not.toContain("Order held · ₹1,34,500");
    expect(HERO_CHIPS.map((c) => c.text)).toContain("Replied at 11:47 PM");
    // No invented message in a real customer's name.
    expect(text).not.toMatch(/shopping with ZOORI/);
  });

  it("pricing reads the lowest public plan; the sub-line makes only claims our terms back", () => {
    expect(pricingHeadline("₹2,499")).toBe("Start free. Grow from ₹2,499/month.");
    expect(pricingHeadline("₹2,499", true)).toBe("Start free. Grow from ₹2,499/month + GST.");
    expect(pricingHeadline(null)).toBe("Start free.");
    expect(PRICING_SUB).toBe("Pay for WhatsApp messages only when you send. Cancel anytime.");
    // "Cancel anytime" is the refunds policy's own promise.
    expect(readFileSync("src/routes/refunds.tsx", "utf8")).toContain(
      "You can cancel your plan at any time from Billing in your workspace.",
    );
    const cheaper = renderToStaticMarkup(
      <StartPage
        plans={[...PLANS, { key: "lite", name: "Lite", currency: "INR", price_monthly: 999 }]}
        gstRegistered={false}
      />,
    );
    expect(cheaper).toContain("Start free. Grow from ₹999/month.");
  });

  it("the FAQ's language answer matches Aiden's own instruction and language list", () => {
    expect(text).toContain(
      "Yes. Aiden replies in the language the customer writes in — English, Hindi, Hinglish, Telugu and more.",
    );
    expect(readFileSync("src/lib/ai-brief.server.ts", "utf8")).toContain(
      "Reply in the language the customer wrote in, including Hinglish",
    );
    expect(readFileSync("src/lib/languages.ts", "utf8")).toMatch(/name: "Telugu"/);
  });

  it("the sticky bar: shimmer until the first interaction, the desktop line, still above the cookie banner", () => {
    const bar = readFileSync("src/components/start/start-sticky-bar.tsx", "utf8");
    expect(bar).toContain("Join ZOORI Jewels, Meezoy and more");
    expect(bar).toMatch(/addEventListener\("pointerdown", stop/);
    expect(bar).toContain("--aidwar-bottom-bar");
    expect(html).toContain('data-shimmer="on"');
  });

  it("/start loads no animation library and keeps its stylesheet to itself", () => {
    const files = [
      "src/routes/start.tsx",
      "src/components/start/start-page.tsx",
      "src/components/start/start-hero.tsx",
      "src/components/start/night-story.tsx",
      "src/components/start/start-bento.tsx",
      "src/components/start/start-sections.tsx",
      "src/components/start/start-motion.tsx",
      "src/components/start/phone-chat.tsx",
    ].map((f) => readFileSync(f, "utf8"));
    for (const f of files) {
      expect(f).not.toMatch(/from "(motion[^"]*|framer-motion|gsap|lottie[^"]*|three)"/);
    }
    // Inlined into the page; never imported into the site-wide stylesheet.
    expect(readFileSync("src/styles.css", "utf8")).not.toContain("s73-");
    expect(html).toContain("<style>");
  });
});
