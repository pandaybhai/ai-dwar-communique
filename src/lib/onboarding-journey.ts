/**
 * Batch 40: the first-run journey — four steps, one decision each — and the
 * funnel it is measured by. Pure: the journey page, its API, the nudges, the
 * admin funnel and the tests all read the same names and the same rule.
 *
 * Progress is never stored as "the step you were on": it is worked out from
 * facts (a website or material to read, a connected number, a test answer,
 * the mode chosen), so it can't expire and closing the tab loses nothing.
 */

export const JOURNEY_STEPS = ["business", "connect", "aiden", "live"] as const;
export type JourneyStep = (typeof JOURNEY_STEPS)[number];

export const STEP_LABELS: Record<JourneyStep, string> = {
  business: "Your business",
  connect: "Connect WhatsApp",
  aiden: "Meet Aiden",
  live: "Go live",
};

/** The funnel, in order. Each is recorded once per workspace. */
export const FUNNEL_STEPS = [
  "started",
  "website_read",
  "connect_opened",
  "connected",
  "aiden_tested",
  "went_live",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const FUNNEL_LABELS: Record<FunnelStep, string> = {
  started: "Started",
  website_read: "Website read",
  connect_opened: "Opened connect",
  connected: "Connected WhatsApp",
  aiden_tested: "Tested Aiden",
  went_live: "Went live",
};

/** Not funnel steps, but remembered the same way. */
export const JOURNEY_MARKS = ["connect_skipped", "dismissed", "callback_requested"] as const;
export type JourneyMark = (typeof JOURNEY_MARKS)[number];

export function funnelEventType(step: FunnelStep | JourneyMark): string {
  return `onboarding.${step}`;
}

export type JourneyFacts = {
  hasOrg: boolean;
  /** A website (or a file / a written fact) for Aiden to learn from. */
  hasMaterial: boolean;
  connected: boolean;
  /** "I'll connect later" on the connect step. */
  connectSkipped: boolean;
  /** Aiden answered at least one test question. */
  tested: boolean;
  wentLive: boolean;
};

export type JourneyPosition = JourneyStep | "done";

/** The first step that isn't done yet. */
export function resumeStep(facts: JourneyFacts): JourneyPosition {
  if (!facts.hasOrg || !facts.hasMaterial) return "business";
  if (!facts.connected && !facts.connectSkipped) return "connect";
  if (!facts.tested) return "aiden";
  if (!facts.wentLive) return "live";
  return "done";
}

export function parseStep(raw: unknown): JourneyStep | null {
  return typeof raw === "string" && (JOURNEY_STEPS as readonly string[]).includes(raw)
    ? (raw as JourneyStep)
    : null;
}

export function stepIndex(step: JourneyPosition): number {
  return step === "done" ? JOURNEY_STEPS.length : JOURNEY_STEPS.indexOf(step);
}

/**
 * Where a visit lands: the asked-for step (a nudge's deep link, or going
 * back) when it's already reachable, else the first unfinished one. Asking
 * for a step further on never skips one that isn't done — except Connect,
 * which a nudge may open as soon as the business step is done.
 */
export function landingStep(facts: JourneyFacts, requested: JourneyStep | null): JourneyStep {
  const resume = resumeStep(facts);
  const fallback: JourneyStep = resume === "done" ? "live" : resume;
  if (!requested) return fallback;
  if (stepIndex(requested) <= stepIndex(resume)) return requested;
  if (requested === "connect" && facts.hasOrg && facts.hasMaterial) return "connect";
  return fallback;
}

/** The deep link for a step (the nudge's button, the chat's Connect link). */
export function journeyLink(step: JourneyStep, origin = "https://aidwar.in"): string {
  return `${origin}/app/start?step=${step}`;
}

/** The furthest funnel step reached, from the recorded steps. */
export function furthestFunnelStep(recorded: Iterable<string>): FunnelStep | null {
  const have = new Set(recorded);
  let best: FunnelStep | null = null;
  for (const step of FUNNEL_STEPS) if (have.has(step)) best = step;
  return best;
}

export type FunnelRow = { organizationId: string; steps: string[]; startedAt: string };

export type FunnelSummary = {
  total: number;
  steps: Array<{ step: FunnelStep; label: string; reached: number; fromPrevious: number | null; fromStart: number | null }>;
  /** Where each sign-up stopped: its furthest step, counted. */
  stoppedAt: Array<{ step: FunnelStep; label: string; count: number }>;
};

/** Step-by-step conversion over sign-ups that started (in the window). */
export function summariseFunnel(rows: FunnelRow[]): FunnelSummary {
  const started = rows.filter((r) => r.steps.includes("started"));
  const total = started.length;
  const reached = FUNNEL_STEPS.map((step) => started.filter((r) => r.steps.includes(step)).length);
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const stopped = new Map<FunnelStep, number>();
  for (const row of started) {
    const furthest = furthestFunnelStep(row.steps) ?? "started";
    stopped.set(furthest, (stopped.get(furthest) ?? 0) + 1);
  }
  return {
    total,
    steps: FUNNEL_STEPS.map((step, i) => ({
      step,
      label: FUNNEL_LABELS[step],
      reached: reached[i] ?? 0,
      fromPrevious: i === 0 ? null : pct(reached[i] ?? 0, reached[i - 1] ?? 0),
      fromStart: pct(reached[i] ?? 0, total),
    })),
    stoppedAt: FUNNEL_STEPS.map((step) => ({ step, label: FUNNEL_LABELS[step], count: stopped.get(step) ?? 0 })),
  };
}
