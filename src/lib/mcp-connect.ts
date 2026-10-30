/**
 * Batch 52: how to connect AiDwar MCP from each AI assistant, and what to
 * ask it. One source for /developers#mcp and the new_site landing. The
 * steps follow each client's own docs as of 30 Oct 2026 (`source`).
 */

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

export const EXAMPLE_PROMPTS = [
  "Draft a Diwali campaign to customers tagged VIP",
  "How did my last campaign do?",
  "Build a welcome flow for new customers",
  "Which chats need me right now?",
  "How many opted-in customers do I have, and how much is left in my wallet?",
];

/** The promise, in the same words everywhere (consent page, docs, landing). */
export const MCP_PROMISE = [
  "Reads your workspace: campaigns and results, templates, segments, customers, flows and the chats that need you.",
  "Drafts campaigns and chat flows for you to review.",
  "Nothing is sent and no flow goes live until you confirm.",
];

export const MCP_LIMITS =
  "It acts as you, with your permissions. It can't message a customer on its own, change Aiden, billing, your team or settings, or delete anything.";
