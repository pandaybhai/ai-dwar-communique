/**
 * Aiden's fixed onboarding texts. These defaults are the built-in wording:
 * they seed ai_prompt_blocks and are what Aiden sends whenever the saved
 * version can't be used. Browser-safe (the admin Scripts tab reads it too).
 */

export type ScriptKey =
  | "stranger_reply"
  | "day_one_intro"
  | "ask_website"
  | "reading_site"
  | "fact_saved"
  | "fact_save_failed"
  | "no_source_reply"
  | "upgrade_intent"
  | "trial_cap_reply"
  | "on_duty"
  | "handover_default"
  | "full_read_done";

export const SCRIPTS: Record<
  ScriptKey,
  { name: string; description: string; vars: string[]; text: string }
> = {
  stranger_reply: {
    name: "Stranger reply",
    description: "Someone messages the AiDwar number without a workspace behind them.",
    vars: [],
    text: "Hi! I'm Aiden from AiDwar. If you've signed up, open aidwar.in/app — your code is on the home screen; send it here and I'll get started. New here? Sign up at aidwar.in.",
  },
  day_one_intro: {
    name: "Day-one intro",
    description: "Sent with the ID card right after an owner sends a valid code.",
    vars: ["first_name", "persona", "business"],
    text: "{first_name}, meet {persona}. From today he works for {business} — answering your customers on WhatsApp, day and night, no leave, no attitude.\n\nHe hasn't read a word about you yet. Let's fix that.",
  },
  ask_website: {
    name: "Ask for the website",
    description: "Asks the owner for their website link.",
    vars: ["business"],
    text: "Send me your website link. Give me 2 minutes with it and I'll know {business} the way a good new hire knows it on day one — what you sell, what you charge, how you deliver.",
  },
  reading_site: {
    name: "Reading the site",
    description: "Sent when the owner's first website link arrives.",
    vars: ["site"],
    text: "Reading {site} now. Go grab a chai — I'll ping you in 2 minutes with everything I learned.",
  },
  fact_saved: {
    name: "Fact saved",
    description: "The owner told Aiden something about the business and it was saved.",
    vars: [],
    text: "Saved — I'll remember that.",
  },
  fact_save_failed: {
    name: "Fact not saved",
    description: "Saving a fact failed.",
    vars: [],
    text: "I couldn't save that just now. Send it again in a moment and I'll keep it.",
  },
  no_source_reply: {
    name: "Empty model reply",
    description: "Only when the model returns nothing at all.",
    vars: [],
    text: "I didn't catch that one — ask me again and I'll have a proper go at it.",
  },
  upgrade_intent: {
    name: "Plans question",
    description: "An owner on trial asks about AiDwar's own plans.",
    vars: [],
    text: "Plans start at ₹2,499 a month. Pick one and pay in a minute here — I'll keep working the moment it's done:\nhttps://aidwar.in/app/billing",
  },
  trial_cap_reply: {
    name: "Trial reading limit",
    description: "The trial's free reading allowance is used up.",
    vars: [],
    text: "I've used up the free reading allowance for your trial. Pick a plan at https://aidwar.in/app/billing and I'll read it straight away.",
  },
  on_duty: {
    name: "On duty",
    description: "Caption when Aiden starts answering on the merchant's number.",
    vars: ["number"],
    text: "I'm on duty at {number}. Message it from your own phone and watch me work.\n\nWhen I'm not sure, I hand over to you. I never guess.",
  },
  handover_default: {
    name: "Default handover",
    description: "What customers hear when Aiden steps back, unless the workspace reworded it.",
    vars: [],
    text: "Let me get someone from the team to help — they'll reply here shortly.",
  },
  full_read_done: {
    name: "Full read finished",
    description: "Sent to the owner when Aiden finishes reading the whole website.",
    vars: ["site", "pages", "products"],
    text: "I've finished reading {site} — {pages} pages and {products} products. Ask me anything your customers would.",
  },
};

export const SCRIPT_KEYS = Object.keys(SCRIPTS) as ScriptKey[];

export function isScriptKey(key: string): key is ScriptKey {
  return key in SCRIPTS;
}

/** {placeholders} used in a text. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
}

/**
 * Fills a script. Returns null when the result can't be sent safely: blank,
 * or a {placeholder} left unfilled.
 */
export function fillScript(text: string | null | undefined, vars: Record<string, string | number>): string | null {
  if (!text || !text.trim()) return null;
  const out = text.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === null || String(value).trim() === "" ? whole : String(value);
  });
  if (/\{[a-z_]+\}/.test(out)) return null;
  return out;
}
