/**
 * Batch 57: every word the new Settings shows, in one place (a later Hindi
 * pass changes this file only). Plain, warm Indian-English for a shop owner:
 * short headings, a plain line the first time a technical word appears.
 *
 * Left exactly as it was on purpose: the billing note under Notifications
 * (billing), the Connected AI apps blurb and its how-to line (Batch 56 owns
 * what an AI app may see and do), and the section names, which the classic
 * cards inside each section and the ⌘K jumps use too.
 */

import type { SettingsSectionKey } from "./settings-sections";

export const SETTINGS_COPY = {
  title: "Settings",
  description: "Your shop's details, your team, and everything AiDwar is connected to.",
  loadingLabel: "Loading your settings",
  loadFailed: "Couldn't load your workspace. Check your internet and tap Try again.",
  noWorkspace:
    "Couldn't find your workspace. Refresh the page, or pick it again from Switch workspace in your profile menu.",
  navLabel: "Settings sections",
  /** Batch 50 wording, unchanged: it says where billing notes go. */
  billingNote:
    "Receipts and low-credit notes go to the billing WhatsApp number you give when you choose a plan.",
  profilePicker: "Choose which number's profile to edit",
} as const;

/** Each section's name in the sub-nav and the one line under its heading. */
export const SECTION_COPY: Record<SettingsSectionKey, { label: string; blurb: string }> = {
  general: {
    label: "Workspace",
    blurb: "Your shop's name, as your team sees it across AiDwar.",
  },
  team: {
    label: "Team and roles",
    blurb: "Invite your team and choose what each person can do.",
  },
  whatsapp: {
    label: "WhatsApp",
    blurb: "Your WhatsApp profile, the numbers you send from, and how each number is doing.",
  },
  api: {
    label: "API and webhooks",
    blurb:
      "Let your own software work with AiDwar. The API is how it sends messages through us, and a webhook is the address we call to tell it what happened. Your keys and a test console are below.",
  },
  ai_apps: {
    label: "Connected AI apps",
    // Batch 56 owns this wording (what an AI app may do as you): unchanged.
    blurb: "AI assistants you allowed to use AiDwar as you, and where to remove them.",
  },
  notifications: {
    label: "Notifications",
    blurb: "Who on your team gets a message when a customer needs a person.",
  },
  optout: {
    label: "Opt-out keywords",
    blurb:
      "When a customer sends one of these words, they have opted out, and we stop sending them offers.",
  },
  integrations: {
    label: "Integrations",
    blurb: "Link your Shopify store so your products and orders show up in AiDwar.",
  },
  connections: {
    label: "Flow connections",
    blurb: "Accounts your chat flows use, like Google Sheets and Razorpay payment links.",
  },
  sending: {
    label: "Send settings",
    blurb:
      "Quiet hours, how many offers one customer can get, win-back timing, linking sales to your messages, and tax.",
  },
  sources: {
    label: "Lead sources",
    blurb: "See where new customers come from, using the words in their first message.",
  },
  danger: {
    label: "Danger zone",
    blurb: "Delete this workspace for good. This can't be undone.",
  },
};

/** ⌘K jumps (settings-jumps.ts): the sections' own names. */
export const JUMP_COPY = {
  profile: "WhatsApp profile",
  team: SECTION_COPY.team.label,
  api: SECTION_COPY.api.label,
} as const;

/**
 * Settings > Connected AI apps (connected-ai-apps.tsx). The list is shared
 * with the AI assistants page, which Classic shows too: `classic` is what
 * Classic shows, byte for byte; `workspace` is Aiden Workspace's.
 */
const CONNECTED_CLASSIC = {
  loadingLabel: "Loading connected apps",
  loadFailed: "We couldn't load your connected apps. Please try again.",
  removeFailed: "We couldn't remove that app. Please try again.",
  emptyTitle: "No AI apps are connected to your AiDwar account.",
  emptyBody: "",
  emptyAction: "",
  confirm: "Remove its access?",
  keep: "Keep",
  remove: "Remove",
  ask: "Remove access",
};

export const CONNECTED_APPS_COPY = {
  classic: CONNECTED_CLASSIC,
  workspace: {
    ...CONNECTED_CLASSIC,
    loadFailed: "Couldn't load your connected AI apps. Check your internet and tap Try again.",
    removeFailed: "Couldn't remove that app. Check your internet and tap Remove again.",
    emptyTitle: "No AI apps are connected yet",
    emptyBody:
      "Add AiDwar to Claude, ChatGPT, Codex or Cursor once, and it shows up here.",
    emptyAction: "See how to connect",
  },
} as const;

export type ConnectedAppsCopy = typeof CONNECTED_CLASSIC;

export function connectedAppsCopy(newDesign: boolean): ConnectedAppsCopy {
  return newDesign ? CONNECTED_APPS_COPY.workspace : CONNECTED_APPS_COPY.classic;
}

/** "Connected 3 Oct 2026" / "last used 29 Oct 2026" (unchanged words). */
export const connectedOnText = (date: string) => `Connected ${date}`;
export const lastUsedOnText = (date: string) => `last used ${date}`;
