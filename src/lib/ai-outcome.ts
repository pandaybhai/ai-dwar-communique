/**
 * One outcome, one vocabulary.
 *
 * A conversation in the inbox, a run in the work log and a test in the
 * playground all describe the same thing in the same words. Nothing else in
 * the app is allowed to invent its own wording for these.
 */

export type OutcomeKey = "answered" | "handed_over" | "not_answered" | "limit" | "broken";

export type Outcome = {
  key: OutcomeKey;
  /** What the employee says happened, in its own voice. */
  label: string;
  /** Short form for a busy list — the inbox uses this. */
  shortLabel: string;
  tone: "default" | "secondary" | "destructive";
  /** Why it stopped, when it stopped. Null when it simply answered. */
  reason: string | null;
};

/**
 * Every reason the run engine can actually emit. Nothing speculative — if a
 * signal isn't produced by decideEscalation, it doesn't belong here.
 */
export const HANDOVER_REASONS: Record<string, string> = {
  tool_failed: "A lookup didn't work, so I passed it to you.",
  no_tools: "I had no lookups switched on, so I couldn't check anything.",
  no_source: "I had nothing to answer from.",
  sensitive_topic: "This one is too important for me to answer alone.",
  merchant_rule: "You told me to hand this kind of question over.",
  question_repeated: "They asked again after I got it wrong the first time.",
  customer_frustrated: "They sounded unhappy, so I fetched a person.",
  asked_for_person: "They asked to talk to a person.",
  flow_assign: "A flow handed this chat to you.",
  // Batch 27: a run that broke or hit the spending limit is handed over, never left silent.
  ai_error: "Something went wrong while I was answering, so I passed it to you.",
  ai_capped: "This month's AI spending limit was reached, so I passed it to you.",
};

export function handoverReasonText(signal: string | null | undefined): string | null {
  if (!signal) return null;
  return HANDOVER_REASONS[signal] ?? "I stepped back on this one.";
}

/**
 * Batch 28: the last staff alert for a chat that waits on a person, as the
 * hand-off alert recorded it (conversations.handoff_alert_result).
 */
export type HandoffAlertResult = {
  at: string;
  reminder: boolean;
  whatsapp: string[];
  email: string | null;
  skipped: string | null;
};

/**
 * The Inbox banner's sentence for that alert: who was told, or that nobody
 * could be reached. Staff-facing; null when no alert has been recorded.
 */
export function describeAlertResult(result: Partial<HandoffAlertResult> | null | undefined): string | null {
  if (!result || !result.at) return null;
  const told: string[] = [];
  const phones = (result.whatsapp ?? []).filter(Boolean);
  if (phones.length) told.push(`${phones.join(" and ")} on WhatsApp`);
  if (result.email) told.push(`${result.email} by email`);
  if (told.length) return `Your team was told: ${told.join(" and ")}.`;
  if (result.skipped === "no_staff_contact")
    return "Nobody on your team was told: no staff WhatsApp number or email is saved under AI employee → Who hears when a chat needs a person.";
  return "Nobody on your team could be reached — check the WhatsApp numbers and email under AI employee → Who hears when a chat needs a person.";
}

export function outcomeOf(status: string | null | undefined, signal?: string | null): Outcome {
  switch (status) {
    case "escalated":
      return {
        key: "handed_over",
        label: "I passed this to you",
        shortLabel: "Needs you",
        tone: "secondary",
        reason: handoverReasonText(signal),
      };
    case "refused":
      return {
        key: "not_answered",
        label: "I didn't answer this",
        shortLabel: "Not answered",
        tone: "secondary",
        reason: handoverReasonText(signal),
      };
    case "capped":
      return {
        key: "limit",
        label: "I've hit this month's limit",
        shortLabel: "Limit reached",
        tone: "destructive",
        reason: "I've hit this month's limit.",
      };
    case "error":
      return {
        key: "broken",
        label: "Something went wrong",
        shortLabel: "Went wrong",
        tone: "destructive",
        reason: "Something on my side broke before I could answer.",
      };
    default:
      return {
        key: "answered",
        label: "I answered this",
        shortLabel: "Answered",
        tone: "default",
        reason: null,
      };
  }
}
