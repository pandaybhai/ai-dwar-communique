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

/** Batch 54: what round 2's tools unlock (shown after the five above). */
export const EXAMPLE_PROMPTS_ROUND2 = [
  "Draft a campaign for my newest products",
  "How much did my last campaign sell?",
  "Write a new template for our winter sale and submit it",
  "Move tomorrow's campaign to 7pm",
  "Tag everyone who replied YES as VIP",
  "What is Aiden waiting on me for?",
];

/** Every prompt to try, in the order the docs show them. */
export const ALL_EXAMPLE_PROMPTS = [...EXAMPLE_PROMPTS, ...EXAMPLE_PROMPTS_ROUND2];

export type McpToolKind = "read" | "draft" | "confirm";

/**
 * The tools as /developers#mcp lists them (Batch 52 + Batch 54). "draft"
 * saves a draft or a preview and sends nothing; "confirm" acts only with the
 * confirm_code its draft or preview returned, after the user said yes.
 * batch54-mcp2-site.test.tsx keeps this list equal to the server's tools.
 */
export const MCP_TOOL_LIST: Array<{ name: string; kind: McpToolKind; does: string }> = [
  { name: "list_workspaces", kind: "read", does: "Your workspaces and your role in each." },
  { name: "get_workspace_overview", kind: "read", does: "Plan, wallet, Aiden's mode, numbers and open chats." },
  { name: "list_templates", kind: "read", does: "Approved templates with their variables and buttons." },
  { name: "list_segments", kind: "read", does: "Saved audiences and their rules." },
  { name: "count_audience", kind: "read", does: "How many opted-in customers an audience reaches." },
  { name: "search_contacts", kind: "read", does: "Customers by name, phone, tag or opt-in." },
  { name: "list_products", kind: "read", does: "Your catalogue: price, stock, pictures, links and collections." },
  { name: "list_campaigns", kind: "read", does: "Campaigns, newest first, with headline numbers." },
  { name: "get_campaign_report", kind: "read", does: "One campaign's delivery, reads, replies and cost." },
  { name: "get_campaign_sales", kind: "read", does: "Orders and revenue linked to a campaign (only from AiDwar's sales data)." },
  { name: "list_flows", kind: "read", does: "Chat flows and whether they're on." },
  { name: "get_flow", kind: "read", does: "One flow's steps in plain words." },
  { name: "list_needs_attention", kind: "read", does: "Chats waiting for a person." },
  { name: "list_aiden_questions", kind: "read", does: "What Aiden is waiting on you for." },
  { name: "create_segment", kind: "draft", does: "Saves a new audience from rules; sends nothing." },
  { name: "create_campaign_draft", kind: "draft", does: "A campaign draft with recipients, cost and a confirm code." },
  { name: "create_flow_draft", kind: "draft", does: "A chat flow, saved switched off." },
  { name: "create_template_draft", kind: "draft", does: "A template checked against Meta's rules; nothing saved." },
  { name: "preview_campaign_change", kind: "draft", does: "What moving, re-targeting or cancelling a scheduled campaign would do." },
  { name: "send_campaign", kind: "confirm", does: "Sends or schedules a drafted campaign." },
  { name: "activate_flow", kind: "confirm", does: "Switches a drafted flow on." },
  { name: "submit_template", kind: "confirm", does: "Sends a drafted template to Meta for approval." },
  { name: "update_scheduled_campaign", kind: "confirm", does: "Changes a scheduled campaign's time, audience or values." },
  { name: "cancel_scheduled_campaign", kind: "confirm", does: "Cancels a scheduled campaign before it sends." },
  { name: "tag_contacts", kind: "confirm", does: "Previews, then adds a tag to up to 5,000 customers." },
  { name: "answer_aiden_question", kind: "confirm", does: "Previews, then gives Aiden your own answer (and the waiting customer, if their chat is open)." },
];

/** The promise, in the same words everywhere (consent page, docs, landing). */
export const MCP_PROMISE = [
  "Reads your workspace: campaigns, results and sales, templates, products, segments, customers, flows, the chats that need you and Aiden's questions.",
  "Drafts campaigns, chat flows and templates, and prepares tags and schedule changes, for you to review.",
  "Nothing is sent, submitted or changed and no flow goes live until you confirm.",
];

export const MCP_LIMITS =
  "It acts as you, with your permissions. It can't message a customer on its own, change Aiden, billing, your team or settings, or delete anything.";
