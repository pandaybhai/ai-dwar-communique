import { STARTER_PROMPTS } from "@/lib/mcp-prompts";

/**
 * Batch 57: the in-app AI assistants page's own words (/app/ai-assistants)
 * and the Home card's, in one place. The page is one page in both designs:
 * `classic` is what Classic shows, byte for byte; `workspace` is Aiden
 * Workspace's, which changes only headings, empty and error states and adds
 * a plain line for "MCP".
 *
 * Left exactly as it was on purpose (Batch 56 owns what an AI app may see and
 * do, and how access is given or taken back): the page description, the
 * switched-off notice, the apps section's line about removing access, the
 * workspace switch's explanation, the team apps note, every connect step,
 * safety line and prompt (src/lib/mcp-connect.ts, src/lib/mcp-prompts.ts).
 */

/** The example in the empty timeline: a starter prompt, never typed twice. */
const EXAMPLE = STARTER_PROMPTS.find((p) => p.startsWith("Draft a Diwali")) ?? STARTER_PROMPTS[0];

const CLASSIC = {
  title: "AI assistants",
  description:
    "Use AiDwar from Claude, ChatGPT, Codex or Cursor: ask about your numbers, draft campaigns and flows. Nothing is sent until you confirm.",
  loadFailed: "We couldn't load this page. Please refresh.",
  retry: "",
  noAccess: {
    title: "You don't have access to AI assistants",
    body: "Ask an owner or admin of this workspace to give you “Use AiDwar from an AI assistant”.",
  },
  toastOn: "AI assistants are on for this workspace.",
  toastOff: "AI assistants are off for this workspace.",
  off: {
    title: "AI assistants are switched off for this workspace.",
    support: "AiDwar support switched them off. Write to support to switch them back on.",
    manager:
      "Connected apps can't read or draft anything here until you switch them on under Safety and limits.",
    member:
      "Connected apps can't read or draft anything here. An owner or admin can switch them on from this page.",
  },
  connect: {
    title: "Connect",
    blurb: "Add AiDwar to your AI assistant once; it signs in as you.",
  },
  apps: {
    title: "Your connected apps",
    blurbEveryone:
      "The AI apps you allowed, and below them your team's. Removing one ends its access at once.",
    blurbOwn: "The AI apps you allowed to use AiDwar as you. Removing one ends its access at once.",
  },
  activity: {
    title: "What your AI did",
    blurbEveryone:
      "Everything an AI assistant created, drafted, sent or switched on in this workspace.",
    blurbOwn: "Everything your AI assistant created, drafted, sent or switched on for you.",
    app: "App",
    allApps: "All apps",
    person: "Person",
    everyone: "Everyone",
    open: "Open",
    emptyTitle: "Nothing yet.",
    emptyBody: `When your assistant creates a segment, drafts a campaign or a flow, or sends or switches one on after you confirm, it shows here with who asked, from which app and a link to it. Try asking it: “${EXAMPLE}”.`,
    emptyAction: "",
  },
  prompts: {
    title: "Prompt library",
    blurb: "Copy one into your assistant. Each works with today's AiDwar tools.",
  },
  safety: {
    title: "Safety and limits",
    switchLabel: "AI assistants in this workspace",
    switchHelp:
      "Off stops every connected app from reading or drafting here, for everyone. Apps stay connected and work again when you switch it back on.",
    on: "On",
    off: "Off",
  },
};

export type AssistantsCopy = typeof CLASSIC;

export const ASSISTANTS_COPY: { classic: AssistantsCopy; workspace: AssistantsCopy } = {
  classic: CLASSIC,
  workspace: {
    ...CLASSIC,
    loadFailed: "Couldn't load your AI assistants. Check your internet and tap Try again.",
    retry: "Try again",
    noAccess: {
      ...CLASSIC.noAccess,
      title: "AI assistants aren't open to you yet",
    },
    connect: {
      title: "Connect your assistant",
      blurb:
        "Add AiDwar to your AI assistant once. It signs in as you. Any assistant that supports MCP works: MCP is the common way AI apps connect to other tools.",
    },
    activity: {
      ...CLASSIC.activity,
      title: "What your assistant did",
      emptyTitle: "Nothing here yet",
      emptyBody: `When your assistant makes a group of customers, drafts a campaign or a flow, or sends or switches one on after you confirm, you'll see it here with a link to open it. Try asking it: “${EXAMPLE}”.`,
      emptyAction: "See things to ask",
    },
    prompts: {
      title: "Things to ask",
      blurb:
        "Copy one, paste it into your assistant and send. Each one works with what AiDwar can do today.",
    },
  },
};

export function assistantsCopy(newDesign: boolean): AssistantsCopy {
  return newDesign ? ASSISTANTS_COPY.workspace : ASSISTANTS_COPY.classic;
}

/** The Home card (connect-card.tsx), the same in both designs: unchanged words. */
export const CONNECT_CARD_COPY = {
  title: "Connect your AI assistant",
  body: "Add AiDwar to Claude, ChatGPT, Codex or Cursor and ask about your numbers or have it draft a campaign. Nothing is sent until you confirm.",
  dismiss: "Dismiss: Connect your AI assistant",
  copyUrl: "Copy the server URL",
  more: "How to connect, and more to ask",
} as const;
