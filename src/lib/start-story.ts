/**
 * Batch 73: the /start page's moving parts as pure data and functions, so the
 * story, the hero chips and the rotating word can be tested without a browser.
 * Every scene here is illustrative (the page says so); none is a customer's
 * real chat.
 */

/** The hero chip's rotating word ("Built for …"), crossfaded every ROTATE_MS. */
export const BUILT_FOR = [
  "jewellers",
  "boutiques",
  "cafés",
  "D2C brands",
  "clinics",
  "coaching institutes",
] as const;
export const ROTATE_MS = 2200;

/** The hero chat's script position (bubbles shown 0–5) → which glass chips have popped in. */
export const HERO_CHIPS = [
  { key: "reach", text: "+1,900 customers reached", from: 1 },
  { key: "read", text: "✓✓ Read · 2s ago", from: 2 },
  { key: "replied", text: "Aiden replied in 3 sec", from: 3 },
  { key: "held", text: "Order held · ₹1,34,500", from: 5 },
] as const;

export function heroChipsShown(show: number): Record<(typeof HERO_CHIPS)[number]["key"], boolean> {
  return Object.fromEntries(HERO_CHIPS.map((c) => [c.key, show >= c.from])) as Record<
    (typeof HERO_CHIPS)[number]["key"],
    boolean
  >;
}

/** "While you sleep": four steps, each driving the phone and its clock. */
export const STORY_STEPS = [
  {
    clock: "11:47 PM",
    text: "A customer asks about the 22k chain they saw on Instagram.",
  },
  {
    clock: "11:47 PM",
    text: "Aiden answers in 3 seconds — with your real price and stock.",
  },
  {
    clock: "11:48 PM",
    text: "They say yes. Aiden holds it and tags you.",
  },
  {
    clock: "9:02 AM",
    text: "You wake up to a sale, not a missed message.",
  },
] as const;

export type StoryPhone = {
  clock: string;
  /** The customer's question about the chain. */
  question: boolean;
  /** Aiden's typing dots (step 2, before the reply lands). */
  typing: boolean;
  /** Aiden's answer with price and stock. */
  answer: boolean;
  /** The customer's "Yes please". */
  yes: boolean;
  /** The "Order held" toast and the "Assigned to you" chip. */
  toast: boolean;
  assigned: boolean;
  /** Step 4: the dawn sky and the morning notification stack. */
  morning: boolean;
  notifications: number;
};

/**
 * The phone for a story step (0–3, clamped). `settled` is false for the
 * moment a step has just been reached: step 2 then shows Aiden typing, and
 * the reply lands once it settles. Reduced motion renders settled states only.
 */
export function storyPhone(step: number, settled = true): StoryPhone {
  const s = Math.max(0, Math.min(STORY_STEPS.length - 1, Math.floor(Number(step) || 0)));
  return {
    clock: STORY_STEPS[s]!.clock,
    question: true,
    typing: s === 1 && !settled,
    answer: s > 1 || (s === 1 && settled),
    yes: s >= 2,
    toast: s >= 2,
    assigned: s >= 2,
    morning: s === 3,
    notifications: s === 3 ? 3 : 0,
  };
}

type StepEntry = { isIntersecting: boolean; target: unknown };

/**
 * The step whose text crosses the middle of the screen (an IntersectionObserver
 * with a thin band at the centre). Keeps the previous step when nothing does.
 */
export function activeStoryStep(prev: number, entries: StepEntry[], steps: unknown[]): number {
  let next = prev;
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const i = steps.indexOf(e.target);
    if (i >= 0) next = i;
  }
  return next;
}

/** The pricing card's headline: "Start free. Grow from ₹X/month." (no price when none is public). */
export function pricingHeadline(lowest: string | null, gstRegistered = false): string {
  return lowest
    ? `Start free. Grow from ${lowest}/month${gstRegistered ? " + GST" : ""}.`
    : "Start free.";
}

/** The pricing card's line under the headline — only claims our plans and terms make true. */
export const PRICING_SUB = "Pay for WhatsApp messages only when you send. Cancel anytime.";
