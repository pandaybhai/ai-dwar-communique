import {
  Bot, Clock, FileText, Flag, GitBranch, ListChecks, MessageSquare, MessageSquareText, MousePointerClick,
  Pencil, Play, StickyNote, Tag, UserPlus, AlertCircle, HelpCircle, Link2, MapPin, Navigation, Contact, GalleryHorizontal,
  Variable, CalendarClock, Sheet, Globe, Mail, CalendarCheck, ClipboardList, IndianRupee, NotebookPen, CheckCircle2, BellRing, Users, Shuffle, CornerDownRight, ShoppingBag, IdCard, type LucideIcon,
} from "lucide-react";
import type { FlowNode, NodeType } from "@/lib/flow-graph";
import { CUSTOMER_CARD_DESIGNS } from "@/lib/customer-cards";

/** label/hint are wording only; the NodeType key (e.g. "carousel") is what saved flows store and must never change. */
export type NodeMeta = { label: string; hint?: string; group: "Messages" | "Ask" | "Logic" | "Actions" | "Other"; icon: LucideIcon; defaults: () => Record<string, unknown> };

let seq = 0;
export const uid = (p = "n") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const NODE_META: Record<NodeType, NodeMeta> = {
  start: { label: "Start", group: "Other", icon: Play, defaults: () => ({}) },
  text: { label: "Message", group: "Messages", icon: MessageSquare, defaults: () => ({ text: "Hi {{name}}!" }) },
  buttons: { label: "Buttons", group: "Messages", icon: MousePointerClick, defaults: () => ({ text: "Pick one:", buttons: [{ id: uid("b"), title: "Yes" }, { id: uid("b"), title: "No" }] }) },
  list: { label: "List", group: "Messages", icon: ListChecks, defaults: () => ({ text: "Choose an option:", button_text: "Choose", rows: [{ id: uid("r"), title: "Option 1" }] }) },
  template: { label: "Template", group: "Messages", icon: FileText, defaults: () => ({ template_id: "", variables: [] }) },
  form: { label: "Form", group: "Messages", icon: MessageSquareText, defaults: () => ({ form_id: "" }) },
  ask: { label: "Question", group: "Ask", icon: HelpCircle, defaults: () => ({ text: "What's your pincode?", variable: "answer", validation: "text", retries: 2, on_unexpected: "repeat", timeout_minutes: 1440 }) },
  branch: { label: "Branch", group: "Logic", icon: GitBranch, defaults: () => ({ branches: [{ id: uid("br"), label: "Branch 1", match: "all", conditions: [{ subject: "var:answer", op: "eq", value: "" }] }] }) },
  wait: { label: "Wait", group: "Logic", icon: Clock, defaults: () => ({ minutes: 60 }) },
  end: { label: "End", group: "Logic", icon: Flag, defaults: () => ({}) },
  tag: { label: "Tag", group: "Actions", icon: Tag, defaults: () => ({ tag: "", action: "add" }) },
  set_field: { label: "Update field", group: "Actions", icon: Pencil, defaults: () => ({ field: "", value: "" }) },
  assign: { label: "Assign to team", group: "Actions", icon: UserPlus, defaults: () => ({ user_id: "" }) },
  needs_you: { label: "Needs you", group: "Actions", icon: AlertCircle, defaults: () => ({ note: "" }) },
  note: { label: "Sticky note", group: "Other", icon: StickyNote, defaults: () => ({ text: "Note to your team" }) },
  cta_url: { label: "Link button", group: "Messages", icon: Link2, defaults: () => ({ text: "Tap below to see it:", button_text: "Open", url: "https://" }) },
  location_request: { label: "Ask location", group: "Ask", icon: MapPin, defaults: () => ({ text: "Please share your location.", variable: "location", timeout_minutes: 1440, retries: 1, on_unexpected: "repeat" }) },
  location_send: { label: "Send location", group: "Messages", icon: Navigation, defaults: () => ({ latitude: "", longitude: "", name: "", address: "" }) },
  contact_card: { label: "Contact card", group: "Messages", icon: Contact, defaults: () => ({ name: "", phone: "" }) },
  carousel: { label: "WhatsApp shop", hint: "Opens your WhatsApp catalogue with add-to-cart. Needs WhatsApp shop connected.", group: "Messages", icon: GalleryHorizontal, defaults: () => ({ header: "Our picks", text: "Take a look:", retailer_ids: [] }) },
  set_variable: { label: "Set variable", group: "Logic", icon: Variable, defaults: () => ({ variable: "total", mode: "value", expression: "" }) },
  business_hours: { label: "Business hours", group: "Logic", icon: CalendarClock, defaults: () => ({}) },
  ab_split: { label: "A/B split", group: "Logic", icon: Shuffle, defaults: () => ({ percent_a: 50 }) },
  goto_flow: { label: "Go to flow", group: "Logic", icon: CornerDownRight, defaults: () => ({ flow_id: "" }) },
  internal_note: { label: "Internal note", group: "Actions", icon: NotebookPen, defaults: () => ({ text: "" }) },
  close_chat: { label: "Close chat", group: "Actions", icon: CheckCircle2, defaults: () => ({}) },
  opt: { label: "Opt-in / out", group: "Actions", icon: BellRing, defaults: () => ({ action: "in" }) },
  sheets_append: { label: "Google Sheets row", group: "Actions", icon: Sheet, defaults: () => ({ sheet: "", tab: "Sheet1", columns: ["{{name}}", "{{phone}}", "{{last_answer}}"] }) },
  payment: { label: "Payment request", group: "Actions", icon: IndianRupee, defaults: () => ({ amount: "", description: "Your order", text: "Here's your payment link:", wait_hours: 24 }) },
  segment: { label: "Segment", group: "Actions", icon: Users, defaults: () => ({ action: "add", segment_name: "" }) },
  http: { label: "Webhook / HTTP", group: "Actions", icon: Globe, defaults: () => ({ method: "POST", url: "https://", headers: [], body: '{\n  "name": "{{name}}",\n  "phone": "{{phone}}"\n}', save: [] }) },
  email_team: { label: "Email the team", group: "Actions", icon: Mail, defaults: () => ({ user_ids: [], addresses: "", subject: "New chat lead: {{name}}", body: "{{name}} ({{phone}}) said: {{last_answer}}" }) },
  wait_until: { label: "Wait until", group: "Logic", icon: CalendarCheck, defaults: () => ({ mode: "date", date: "", field: "" }) },
  order_draft: { label: "Create order draft", group: "Actions", icon: ClipboardList, defaults: () => ({ items: "{{last_answer}}", total: "", notes: "", needs_you: true }) },
  send_card: { label: "Send card", hint: "A branded picture card — offer, product, order update, receipt or appointment.", group: "Messages", icon: IdCard, defaults: () => ({ kind: "customer_offer", vars: {}, caption: "", fallback_text: "" }) },
  show_products: { label: "Show products", hint: "Sends matching products as photos with price and link. Works for every business.", group: "Messages", icon: ShoppingBag, defaults: () => ({ category: "", budget: "", min_price: "", max_price: "", max_items: 5, photos_first: true, readable_names: true }) },
};

export const AI_ICON = Bot;

/**
 * Step types offered in the editor's palette. Send card only appears when the
 * workspace has cards switched on; every other step is offered as before.
 */
export function paletteTypes(opts: { cards: boolean }): NodeType[] {
  return (Object.keys(NODE_META) as NodeType[]).filter((k) => k !== "start" && (k !== "send_card" || opts.cards));
}

export function handleLabel(node: FlowNode, handle: string): string {
  if (handle === "next") return "";
  if (handle === "else") return "Else";
  if (handle === "window_closed") return "Window closed";
  if (handle === "invalid") return "Unexpected";
  if (handle === "timeout") return "No reply";
  if (handle === "open") return "Open";
  if (handle === "failed") return "Failed";
  if (handle === "paid") return "Paid";
  if (handle === "not_paid") return `Not paid in ${Number(node.data["wait_hours"] ?? 24)}h`;
  if (handle === "closed") return "Closed";
  if (handle === "success") return "Success";
  if (handle === "found") return "Found";
  if (handle === "none") return "None match";
  if (handle === "a") return `A (${Number(node.data["percent_a"] ?? 50)}%)`;
  if (handle === "b") return `B (${100 - Number(node.data["percent_a"] ?? 50)}%)`;
  const opts = [
    ...(((node.data["buttons"] as Array<{ id: string; title: string }>) ?? [])),
    ...(((node.data["rows"] as Array<{ id: string; title: string }>) ?? [])),
    ...(((node.data["branches"] as Array<{ id: string; label?: string }>) ?? []).map((b) => ({ id: b.id, title: b.label || "Branch" }))),
  ];
  return opts.find((o) => o.id === handle)?.title ?? handle;
}

export function summary(node: FlowNode): string {
  const d = node.data;
  switch (node.type) {
    case "text": case "buttons": case "list": case "ask": case "note": return String(d["text"] ?? "");
    case "template": return String(d["template_name"] ?? "Pick a template");
    case "form": return String(d["form_name"] ?? "Pick a form");
    case "wait": return `${Number(d["minutes"] ?? 0)} minutes`;
    case "tag": return `${d["action"] === "remove" ? "Remove" : "Add"} "${String(d["tag"] ?? "")}"`;
    case "set_field": return `${String(d["field"] ?? "")} = ${String(d["value"] ?? "")}`;
    case "needs_you": return String(d["note"] ?? "");
    case "assign": return d["mode"] === "round_robin" ? "Round-robin across the team" : d["user_id"] ? "To a teammate" : "To the team queue";
    case "cta_url": return `${String(d["text"] ?? "")}\n[${String(d["button_text"] ?? "")}] ${String(d["url"] ?? "")}`;
    case "location_request": return String(d["text"] ?? "");
    case "location_send": return String(d["name"] || d["address"] || `${d["latitude"]}, ${d["longitude"]}`);
    case "contact_card": return `${String(d["name"] ?? "")} ${String(d["phone"] ?? "")}`;
    case "carousel": return `${((d["retailer_ids"] as string[]) ?? []).length} product(s)`.replace("1 product(s)", "1 product").replace("(s)", "s");
    case "set_variable": return `${String(d["variable"] ?? "")} = ${String(d["expression"] ?? "")}`;
    case "internal_note": return String(d["text"] ?? "");
    case "opt": return d["action"] === "out" ? "Opt the customer out" : "Opt the customer in";
    case "segment": return `${d["action"] === "remove" ? "Remove from" : "Add to"} ${String(d["segment_name"] ?? "")}`;
    case "goto_flow": return String(d["flow_name"] ?? "Pick a flow");
    case "business_hours": return "Open / closed";
    case "sheets_append": return `${((d["columns"] as string[]) ?? []).length} column(s) → sheet`;
    case "payment": return `₹${String(d["amount"] ?? "")} · ${String(d["description"] ?? "")}`;
    case "http": return `${String(d["method"] ?? "GET")} ${String(d["url"] ?? "")}`;
    case "email_team": return String(d["subject"] ?? "");
    case "wait_until": return d["mode"] === "field" ? `Until {{${String(d["field"] ?? "")}}}` : `Until ${String(d["date"] ?? "")}`;
    case "order_draft": return String(d["items"] ?? "");
    case "send_card": {
      const design = CUSTOMER_CARD_DESIGNS.find((x) => x.kind === d["kind"]);
      const vars = (d["vars"] as Record<string, string> | undefined) ?? {};
      const first = design?.vars.map((v) => String(vars[v.key] ?? "").trim()).find((v) => v && !v.startsWith("https://")) ?? "";
      return design ? `${design.title} card${first ? ` · ${first}` : ""}` : "Pick a card design";
    }
    case "show_products": {
      const price = [d["min_price"] ? `from ₹${String(d["min_price"])}` : "", d["max_price"] ? `up to ₹${String(d["max_price"])}` : ""].filter(Boolean).join(" ");
      const keyword = String(d["keyword"] ?? "").trim();
      const order = d["sort"] === "spread" ? " · spread across budget" : d["sort"] === "newest" ? " · newest" : "";
      return `Up to ${Number(d["max_items"] ?? 5)} ${String(d["category"] ?? "") || "products"}${keyword ? ` · "${keyword}"` : ""}${String(d["budget"] ?? "") ? ` · ${String(d["budget"])}` : ""}${price ? ` · ${price}` : ""}${order}`;
    }
    default: return "";
  }
}
