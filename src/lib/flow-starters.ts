import type { FlowEdge, FlowGraph, FlowNode, NodeType } from "@/lib/flow-graph";

type N = [id: string, type: NodeType, data: Record<string, unknown>];
type E = [source: string, target: string, handle?: string];

function build(nodes: N[], edges: E[]): FlowGraph {
  return {
    nodes: nodes.map(([id, type, data], i): FlowNode => ({ id, type, data, position: { x: 80 + (i % 3) * 300, y: 60 + Math.floor(i / 3) * 200 } })),
    edges: edges.map(([source, target, handle], i): FlowEdge => ({ id: `e${i}`, source, target, sourceHandle: handle ?? "next" })),
  };
}

export type Starter = { key: string; name: string; description: string; graph: () => FlowGraph };

export const STARTERS: Starter[] = [
  {
    key: "blank",
    name: "Blank flow",
    description: "Start from an empty canvas.",
    graph: () => build([["start", "start", {}], ["end", "end", {}]], [["start", "end"]]),
  },
  // The three Automations, as flows: one message each. They start only once
  // published and given a trigger (Triggers in the editor).
  {
    key: "welcome_message",
    name: "Welcome message",
    description: "One hello for new customers. Add a “First message ever” trigger.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["hello", "text", { text: "Hi {{name}}! 👋 Thanks for messaging us — how can we help you today?" }],
          ["end", "end", {}],
        ],
        [["start", "hello"], ["hello", "end"]],
      ),
  },
  {
    key: "keyword_reply",
    name: "Keyword reply",
    description: "One reply when a customer sends a word like “price”. Add a Keyword trigger.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["reply", "text", { text: "Thanks for asking! Here are the details you wanted:" }],
          ["end", "end", {}],
        ],
        [["start", "reply"], ["reply", "end"]],
      ),
  },
  {
    key: "away_message",
    name: "Away message",
    description: "One reply outside your business hours (set them in Flow settings); nothing while you're open.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["hours", "business_hours", {}],
          ["away", "text", { text: "Thanks for your message! We're away right now and will reply as soon as we're back." }],
          ["end", "end", {}],
        ],
        [["start", "hours"], ["hours", "away", "closed"], ["hours", "end", "open"], ["away", "end"]],
      ),
  },
  {
    key: "welcome_menu",
    name: "Welcome menu",
    description: "Greet and offer three choices.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["menu", "buttons", { text: "Hi {{name}}! How can we help?", buttons: [{ id: "b1", title: "Shop" }, { id: "b2", title: "Track order" }, { id: "b3", title: "Talk to us" }] }],
          ["shop", "text", { text: "Browse our latest picks on our website." }],
          ["track", "text", { text: "Please share your order number and we'll check." }],
          ["team", "assign", {}],
          ["end", "end", {}],
        ],
        [["start", "menu"], ["menu", "shop", "b1"], ["menu", "track", "b2"], ["menu", "team", "b3"], ["shop", "end"], ["track", "end"], ["team", "end"]],
      ),
  },
  {
    key: "lead_qualification",
    name: "Lead qualification",
    description: "Ask name, need and budget, then tag.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["need", "list", { text: "What are you looking for?", button_text: "Choose", variable: "need", rows: [{ id: "r1", title: "New order" }, { id: "r2", title: "Bulk / wholesale" }, { id: "r3", title: "Something else" }] }],
          ["email", "ask", { text: "What's your email?", variable: "email", validation: "email", retry_text: "That doesn't look like an email — try again?" }],
          ["tag", "tag", { tag: "Lead", action: "add" }],
          ["thanks", "text", { text: "Thanks {{name}}! Our team will reach out soon." }],
          ["end", "end", {}],
        ],
        [["start", "need"], ["need", "email", "r1"], ["need", "email", "r2"], ["need", "email", "r3"], ["email", "tag"], ["tag", "thanks"], ["thanks", "end"]],
      ),
  },
  {
    key: "appointment",
    name: "Appointment request",
    description: "Collect a preferred date and hand over.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["date", "ask", { text: "Which date suits you? (dd-mm-yyyy)", variable: "date", validation: "date" }],
          ["ok", "text", { text: "Got it — {{date}}. We'll confirm the time shortly." }],
          ["assign", "assign", {}],
          ["end", "end", {}],
        ],
        [["start", "date"], ["date", "ok"], ["ok", "assign"], ["assign", "end"]],
      ),
  },
  {
    key: "order_status",
    name: "Order status",
    description: "Ask the order number and route to your team.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["ask", "ask", { text: "Please send your order number.", variable: "order_no", validation: "text" }],
          ["note", "needs_you", { note: "Order status asked: {{order_no}}" }],
          ["reply", "text", { text: "Thanks! We're checking order {{order_no}} for you." }],
          ["end", "end", {}],
        ],
        [["start", "ask"], ["ask", "note"], ["note", "reply"], ["reply", "end"]],
      ),
  },
  {
    key: "feedback",
    name: "Feedback",
    description: "Rate 1–3 and branch on the score.",
    graph: () =>
      build(
        [
          ["start", "start", {}],
          ["rate", "buttons", { text: "How was your experience?", variable: "rating", buttons: [{ id: "b1", title: "Great" }, { id: "b2", title: "Okay" }, { id: "b3", title: "Not good" }] }],
          ["thanks", "text", { text: "Thank you, {{name}}! 💚" }],
          ["sorry", "needs_you", { note: "Unhappy feedback" }],
          ["sorrytxt", "text", { text: "Sorry about that — someone from our team will reach out." }],
          ["end", "end", {}],
        ],
        [["start", "rate"], ["rate", "thanks", "b1"], ["rate", "thanks", "b2"], ["rate", "sorry", "b3"], ["sorry", "sorrytxt"], ["thanks", "end"], ["sorrytxt", "end"]],
      ),
  },
];
