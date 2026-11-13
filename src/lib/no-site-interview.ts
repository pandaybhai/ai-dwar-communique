/**
 * Batch 78: the no-website Day-0 interview on WhatsApp — pure, so the steps
 * and their order are tested without a chat. The owner chose "I don't have a
 * website — I'll tell Aiden on WhatsApp" at workspace setup; the session is
 * marked step "no_site", and after the Day-one intro Aiden asks four short
 * questions, one at a time (each saved as a fact), then asks for a photo or
 * PDF of the price list (or Skip). The texts are Scripts in /admin/aiden.
 */

/** The session's step once the owner chose "no website" at setup. */
export const NO_SITE_STEP = "no_site";
export const MEDIA_STEP = "interview_media";

export const INTERVIEW = [
  { step: "interview_1", script: "interview_q1", topic: "Products and prices" },
  { step: "interview_2", script: "interview_q2", topic: "Timings and delivery area" },
  { step: "interview_3", script: "interview_q3", topic: "Payment options" },
  { step: "interview_4", script: "interview_q4", topic: "Returns and exchanges" },
] as const;

export type InterviewStep = (typeof INTERVIEW)[number]["step"] | typeof MEDIA_STEP;

export function isInterviewStep(step: string | null | undefined): step is InterviewStep {
  return step === MEDIA_STEP || INTERVIEW.some((q) => q.step === step);
}

/** Chose "no website" at setup and hasn't been asked anything yet. */
export function isNoSiteStep(step: string | null | undefined): boolean {
  return step === NO_SITE_STEP;
}

/** The step after this one: the next question, then the price list. */
export function nextInterviewStep(step: InterviewStep): InterviewStep | null {
  const i = INTERVIEW.findIndex((q) => q.step === step);
  if (i < 0) return null; // the price-list step is the last
  return i + 1 < INTERVIEW.length ? INTERVIEW[i + 1]!.step : MEDIA_STEP;
}

export function questionFor(step: InterviewStep) {
  return INTERVIEW.find((q) => q.step === step) ?? null;
}

/** The Skip button on the price-list step. */
export const SKIP_MEDIA_ID = "skip_media";

/**
 * What /api/onboarding/start does to the setup session's step for the
 * choice made at setup (`no_website` true / false; absent = not said, e.g.
 * the Talk-to-Aiden card asking for its code): a new session for "no
 * website" starts as "no_site"; an open one (pending or bound) moves to
 * "no_site" unless its interview already began; choosing a website again
 * clears "no_site". Anything further on is left alone.
 */
export function setupStepPatch(
  noWebsite: unknown,
  existing: { status?: string | null; step?: string | null } | null,
): { step: string | null } | null {
  if (noWebsite !== true && noWebsite !== false) return null;
  if (!existing) return noWebsite ? { step: NO_SITE_STEP } : null;
  if (existing.status !== "pending" && existing.status !== "bound") return null;
  if (noWebsite) {
    return existing.step === NO_SITE_STEP || isInterviewStep(existing.step)
      ? null
      : { step: NO_SITE_STEP };
  }
  return existing.step === NO_SITE_STEP ? { step: null } : null;
}
