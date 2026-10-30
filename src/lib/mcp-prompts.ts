/**
 * Batch 53: the prompt library — one list for the in-app AI assistants page
 * (/app/ai-assistants), /developers#mcp "Try asking" and the public
 * /ai-assistants page. Only prompts AiDwar MCP's current tools can carry out
 * end to end are here; `tools` names the tools each one uses
 * (batch53-assistants.test.tsx checks every name against the server's tools,
 * Batch 52's and Batch 54's round 2).
 *
 * Left out until a tool exists (listed in the Batch 53 PR):
 * - "Draft a festive offer to customers who bought in the last 90 days" —
 *   create_segment can't filter by purchases.
 * - "Win back customers who haven't replied in 60 days" — no filter on a
 *   customer's last message.
 * - "How much did I spend on WhatsApp this month?" — no spend / statement tool.
 * - "Make a flow that follows up 2 days after an order" — a flow's store-order
 *   trigger can't be set from an AI assistant.
 */

export type LibraryPrompt = {
  text: string;
  /** What the assistant will do, in a few words. */
  does: string;
  tools: string[];
};

export type PromptGroup = { key: "grow" | "numbers" | "automate" | "daily"; title: string; prompts: LibraryPrompt[] };

export const PROMPT_GROUPS: PromptGroup[] = [
  {
    key: "grow",
    title: "Grow sales",
    prompts: [
      {
        text: "Draft a Diwali campaign to customers tagged VIP",
        does: "Picks an approved template, counts who it reaches and what it costs, and saves a draft for you to confirm.",
        tools: ["list_templates", "count_audience", "create_campaign_draft"],
      },
      {
        text: "Make a segment of opted-in customers tagged VIP and tell me how many there are",
        does: "Saves the segment in Customers and counts it.",
        tools: ["create_segment", "count_audience"],
      },
      // Batch 54 (round 2).
      {
        text: "Draft a campaign for my newest products",
        does: "Reads your newest products, picks an approved template and saves a draft for you to confirm.",
        tools: ["list_products", "list_templates", "count_audience", "create_campaign_draft"],
      },
      {
        text: "Write a new template for our winter sale and submit it",
        does: "Drafts the template, checks it against Meta's rules and submits it for approval once you say yes.",
        tools: ["create_template_draft", "submit_template"],
      },
      {
        text: "Tag everyone who replied YES as VIP",
        does: "Counts who replied YES and shows five names; adds the tag once you say yes.",
        tools: ["tag_contacts"],
      },
    ],
  },
  {
    key: "numbers",
    title: "Know your numbers",
    prompts: [
      {
        text: "Compare my last 3 campaigns and tell me which template worked best",
        does: "Reads each campaign's delivered, read and replied rates side by side.",
        tools: ["list_campaigns", "get_campaign_report"],
      },
      {
        text: "How did my last campaign do?",
        does: "One campaign's results, cost and timing.",
        tools: ["list_campaigns", "get_campaign_report"],
      },
      {
        text: "How much did my last campaign sell?",
        does: "Orders and revenue AiDwar linked to the campaign, or says plainly there's no sales data.",
        tools: ["list_campaigns", "get_campaign_sales"],
      },
      {
        text: "How many opted-in customers do I have, and how much is left in my wallet?",
        does: "Counts everyone who opted in and reads your wallet balance.",
        tools: ["count_audience", "get_workspace_overview"],
      },
    ],
  },
  {
    key: "automate",
    title: "Automate",
    prompts: [
      {
        text: "Build a welcome flow that asks new customers their size and city",
        does: "Drafts the flow switched off. You add its trigger in the builder and confirm before it goes live.",
        tools: ["create_flow_draft", "activate_flow"],
      },
      {
        text: "Which of my flows are switched on, and what starts them?",
        does: "Lists your flows with their status and triggers.",
        tools: ["list_flows", "get_flow"],
      },
    ],
  },
  {
    key: "daily",
    title: "Daily check",
    prompts: [
      {
        text: "Which chats need me right now, oldest first?",
        does: "Lists the chats waiting for a person, longest wait first, with a link to each.",
        tools: ["list_needs_attention"],
      },
      {
        text: "Summarise today in 5 lines",
        does: "Your wallet, Aiden, open chats, chats waiting for you and today's campaigns.",
        tools: ["get_workspace_overview", "list_needs_attention", "list_campaigns"],
      },
      {
        text: "Move tomorrow's campaign to 7pm",
        does: "Shows the new time, who it reaches and the cost; moves it once you say yes.",
        tools: ["list_campaigns", "preview_campaign_change", "update_scheduled_campaign"],
      },
      {
        text: "What is Aiden waiting on me for?",
        does: "Lists Aiden's open questions; answers one with your own words once you confirm them.",
        tools: ["list_aiden_questions", "answer_aiden_question"],
      },
    ],
  },
];

export const LIBRARY_PROMPTS: LibraryPrompt[] = PROMPT_GROUPS.flatMap((g) => g.prompts);

/** Two to start with (the Home card). */
export const STARTER_PROMPTS: string[] = [
  "Which chats need me right now, oldest first?",
  "Draft a Diwali campaign to customers tagged VIP",
];
