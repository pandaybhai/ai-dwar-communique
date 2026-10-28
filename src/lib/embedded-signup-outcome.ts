/**
 * Batch 40: every way Meta's Embedded Signup can end, as one named outcome
 * with a plain-language recovery path. Pure — the connect button (Settings
 * and the first-run journey) and the tests read the same table.
 *
 * Inputs come from three places: Meta's WA_EMBEDDED_SIGNUP window message
 * (CANCEL with the step it stopped at, ERROR with Meta's own words), the
 * FB.login callback, and our /api/whatsapp/es-exchange answer (its HTTP
 * status and message, which carries Graph's error text).
 */

export type EsOutcomeKind =
  | "cancelled"
  | "popup_blocked"
  | "number_on_app"
  | "business_verification"
  | "permission_missing"
  | "number_elsewhere"
  | "meta_unreachable"
  | "not_configured"
  | "unknown";

export type EsOutcome = {
  kind: EsOutcomeKind;
  title: string;
  body: string;
  /** What to do, in order. */
  steps: string[];
  retryLabel: string;
  /** Meta's own words, when there were any — shown small, for support. */
  detail: string | null;
};

export type EsSignal = {
  /** The window message's event, when Meta sent one. */
  event?: "CANCEL" | "ERROR" | null;
  /** CANCEL: the screen they closed it on (e.g. PHONE_NUMBER_SETUP). */
  currentStep?: string | null;
  /** ERROR / exchange: Meta's or our server's message. */
  message?: string | null;
  code?: string | number | null;
  /** Our exchange route's HTTP status. */
  httpStatus?: number | null;
  /** The Facebook script or window never opened. */
  sdkFailed?: boolean;
};

const NUMBER_ON_APP =
  /already (?:registered|in use|being used)|registered (?:on|with) whatsapp|on (?:the )?whatsapp (?:business )?app|existing whatsapp account|number is (?:currently )?(?:in use|connected)|migrat/i;
const VERIFICATION = /business verification|verify (?:your|the) business|(?:isn't|is not|not been|not) verified|unverified|verification (?:is )?(?:required|pending)/i;
const PERMISSION =
  /permission|scope|not authori[sz]ed|access (?:was )?denied|missing (?:the )?(?:whatsapp_business|business_management)|\(#(?:10|200|294)\)/i;

function stepWords(step: string | null | undefined): string | null {
  const clean = String(step ?? "").trim();
  if (!clean) return null;
  return clean.replace(/_/g, " ").toLowerCase();
}

const OUTCOMES: Record<EsOutcomeKind, Omit<EsOutcome, "detail">> = {
  cancelled: {
    kind: "cancelled",
    title: "The Facebook window was closed before it finished",
    body: "Nothing was changed on your number. Start again whenever you're ready — it takes about two minutes.",
    steps: [
      "Keep the Facebook window open until it says you're all set.",
      "If it asked for something you didn't have to hand, check “What you'll need” above first.",
    ],
    retryLabel: "Start again",
  },
  popup_blocked: {
    kind: "popup_blocked",
    title: "The Facebook window didn't open",
    body: "Your browser stopped Meta's sign-up window, so nothing happened yet.",
    steps: [
      "Allow pop-ups for aidwar.in (the icon at the right of the address bar).",
      "Pause any ad or tracker blocker for this page.",
      "Still stuck? Try Chrome or Safari, or let us call you.",
    ],
    retryLabel: "Try again",
  },
  number_on_app: {
    kind: "number_on_app",
    title: "That number is still on the WhatsApp app",
    body: "A number can be on the WhatsApp app on a phone, or on the WhatsApp Business Platform that Aiden uses — not both at once.",
    steps: [
      "Easiest: use a number that isn't on WhatsApp — a new SIM or your office landline works.",
      "Or free this one: back up its chats, then in WhatsApp go to Settings → Account → Delete account. After about 3 minutes it can be connected here.",
      "Your own personal WhatsApp stays as it is — that's where Aiden messages you.",
    ],
    retryLabel: "Connect again",
  },
  business_verification: {
    kind: "business_verification",
    title: "Meta wants to verify your business first",
    body: "This is Meta's check, not ours. It usually takes 1–3 working days, and you can keep setting up Aiden meanwhile.",
    steps: [
      "Open business.facebook.com → Settings → Security Centre → Start verification.",
      "Have your GST certificate or business registration and a utility bill to hand.",
      "When Meta approves it, come back here and connect — your progress is kept.",
    ],
    retryLabel: "Connect again",
  },
  permission_missing: {
    kind: "permission_missing",
    title: "A permission wasn't given",
    body: "Aiden needs to manage and send messages for this number, and one of those boxes was unticked — or your Facebook account isn't an admin of the business.",
    steps: [
      "Start again and leave every box ticked on the “What AiDwar can access” screen.",
      "Use the Facebook account that is an admin of your Meta business portfolio.",
    ],
    retryLabel: "Start again",
  },
  number_elsewhere: {
    kind: "number_elsewhere",
    title: "That number is already on another AiDwar workspace",
    body: "One number can work for one workspace.",
    steps: [
      "Disconnect it in that workspace (Settings → WhatsApp), then connect it here.",
      "Or connect a different number.",
    ],
    retryLabel: "Connect another number",
  },
  meta_unreachable: {
    kind: "meta_unreachable",
    title: "We couldn't reach Meta just now",
    body: "Your sign-up may have gone through on Meta's side; nothing was saved here yet.",
    steps: ["Check your connection.", "Wait a minute and connect again — it picks up the same number."],
    retryLabel: "Try again",
  },
  not_configured: {
    kind: "not_configured",
    title: "Connecting isn't switched on yet",
    body: "This is on our side, not yours. Ask for a call and we'll connect your number with you.",
    steps: ["Tap “Need help? We'll call you”."],
    retryLabel: "Try again",
  },
  unknown: {
    kind: "unknown",
    title: "Meta couldn't finish the sign-up",
    body: "Nothing was changed on your number.",
    steps: ["Try once more.", "If it happens again, let us call you — we'll do it together in five minutes."],
    retryLabel: "Try again",
  },
};

/** The one outcome for whatever Meta (or our exchange) told us. */
export function classifyEmbeddedSignup(signal: EsSignal): EsOutcome {
  const message = String(signal.message ?? "").trim();
  const detail = message || null;
  const pick = (kind: EsOutcomeKind, extra?: Partial<EsOutcome>): EsOutcome => ({
    ...OUTCOMES[kind],
    detail,
    ...extra,
  });

  if (signal.sdkFailed) return pick("popup_blocked");
  if (signal.httpStatus === 409 || /another aidwar workspace/i.test(message)) return pick("number_elsewhere");
  if (/isn't configured|not configured/i.test(message)) return pick("not_configured");
  if (NUMBER_ON_APP.test(message)) return pick("number_on_app");
  if (VERIFICATION.test(message)) return pick("business_verification");
  if (PERMISSION.test(message) || signal.code === 10 || signal.code === 200 || signal.code === "10" || signal.code === "200")
    return pick("permission_missing");
  if (signal.httpStatus === 502 || /couldn't reach meta/i.test(message)) return pick("meta_unreachable");

  if (signal.event === "CANCEL" || (!signal.event && !message && !signal.httpStatus)) {
    const where = stepWords(signal.currentStep);
    // Closed on the phone-number screen: most often there was no number free.
    if (where && /phone number/.test(where)) {
      return pick("cancelled", {
        body: `You closed it on the ${where} screen. That screen needs a number that isn't on the WhatsApp app — a new SIM or a landline is easiest.`,
      });
    }
    return pick("cancelled", where ? { body: `You closed it on the ${where} screen. Nothing was changed on your number.` } : {});
  }
  return pick("unknown");
}

/** Every outcome, for the tests and the help copy. */
export const ES_OUTCOME_KINDS = Object.keys(OUTCOMES) as EsOutcomeKind[];
