/**
 * Batch 52: how to connect AiDwar MCP from each AI assistant, and what to
 * ask it. One source for /developers#mcp and the new_site landing. The
 * steps follow each client's own docs as of 30 Oct 2026 (`source`).
 */

import { LIBRARY_PROMPTS } from "@/lib/mcp-prompts";

export const MCP_URL = "https://aidwar.in/mcp";

export type ConnectClient = {
  key: "claude" | "chatgpt" | "codex" | "cursor";
  name: string;
  /** Who can add a custom MCP server, in the client's own terms. */
  availability: string;
  steps: string[];
  /** A command or config to copy, when the client takes one. */
  code?: { label: string; language: "bash" | "toml" | "json"; text: string };
  source: string;
};

export const CONNECT_CLIENTS: ConnectClient[] = [
  {
    key: "claude",
    name: "Claude (claude.ai and Claude Desktop)",
    availability: "Free (one custom connector), Pro, Max, Team and Enterprise.",
    steps: [
      "Open Customize, then Connectors, and choose + Add, then Add custom connector.",
      `Name it AiDwar and paste ${MCP_URL} as the URL, then Continue.`,
      "Under Authentication pick Sign in now; for the OAuth client pick Register automatically. Choose Add.",
      "Sign in to AiDwar in the window that opens and choose Allow.",
      "In a chat, turn AiDwar on from + then Connectors. Claude Desktop uses the same connectors.",
      "On Team and Enterprise an Owner adds it once in Organization settings, Connectors (Add, Custom, Web); each person then chooses Connect.",
    ],
    source: "https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp",
  },
  {
    key: "chatgpt",
    name: "ChatGPT",
    availability: "Business and Enterprise/Edu on chatgpt.com (on Business, admins and owners add it).",
    steps: [
      "Go to chatgpt.com/plugins, choose + and then Add custom MCP server.",
      "Name it AiDwar, add a short description and paste the URL.",
      "Set authentication to OAuth, tick the box that you understand the risks, and choose Create as a plugin.",
      "Sign in to AiDwar when asked and choose Allow. If ChatGPT later says it lost access, sign in again.",
    ],
    source: "https://help.openai.com/en/articles/12584461",
  },
  {
    key: "codex",
    name: "Codex (CLI and IDE extension)",
    availability: "Anyone using Codex.",
    steps: [
      "Add the server, then sign in (a browser window opens; choose Allow).",
      "In the IDE extension: the gear menu, MCP servers, Add server, Streamable HTTP, and the same URL.",
    ],
    code: {
      label: "Terminal",
      language: "bash",
      text: `codex mcp add aidwar --url ${MCP_URL}\ncodex mcp login aidwar`,
    },
    source: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  },
  {
    key: "cursor",
    name: "Cursor",
    availability: "Anyone using Cursor.",
    steps: [
      "Add AiDwar to ~/.cursor/mcp.json (or .cursor/mcp.json in one project).",
      "Open Cursor's MCP list (Customize in the sidebar), choose Connect next to AiDwar, sign in and choose Allow.",
    ],
    code: {
      label: "~/.cursor/mcp.json",
      language: "json",
      text: `{\n  "mcpServers": {\n    "aidwar": { "url": "${MCP_URL}" }\n  }\n}`,
    },
    source: "https://cursor.com/docs/context/mcp",
  },
];

/**
 * Prompts to try: the Batch 53 library (src/lib/mcp-prompts.ts), the one
 * list the AI assistants page, /developers and /ai-assistants share.
 */
export const EXAMPLE_PROMPTS: string[] = LIBRARY_PROMPTS.map((p) => p.text);

/** Batch 53: any other app that speaks MCP over HTTP with OAuth. */
export const OTHER_CLIENT = {
  key: "other" as const,
  name: "Other MCP apps",
  availability: "Any app that connects to remote MCP servers over HTTP and signs in with OAuth.",
  steps: [
    `Add a remote (Streamable HTTP) MCP server with the URL ${MCP_URL}.`,
    "Choose OAuth sign-in if the app asks; it registers itself with AiDwar automatically.",
    "Sign in to AiDwar in the window that opens and choose Allow.",
  ],
};

/** The promise, in the same words everywhere (consent page, docs, landing). */
export const MCP_PROMISE = [
  "Reads your workspace: campaigns and results, templates, segments, customers, flows and the chats that need you.",
  "Drafts campaigns and chat flows for you to review.",
  "Nothing is sent and no flow goes live until you confirm.",
];

export const MCP_LIMITS =
  "It acts as you, with your permissions. It can't message a customer on its own, change Aiden, billing, your team or settings, or delete anything.";

/**
 * Batch 53: the limits as people read them. The enforced numbers are
 * CALLS_PER_MINUTE / SENDS_PER_HOUR in mcp-access.server.ts (a test keeps
 * these equal).
 */
export const MCP_CALLS_PER_MINUTE = 60;
export const MCP_SENDS_PER_HOUR = 5;

/** Batch 53: the safety box (AI assistants page and /ai-assistants). */
export const MCP_SAFETY = [
  "Drafts only until you confirm. Your assistant shows you the draft; sending a campaign or switching on a flow needs your yes.",
  "Each confirm code works for 15 minutes, for you, for that draft exactly as it was.",
  MCP_LIMITS,
];
