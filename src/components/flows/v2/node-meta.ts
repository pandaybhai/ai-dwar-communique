import {
  Bot, Clock, FileText, Flag, GitBranch, ListChecks, MessageSquare, MessageSquareText, MousePointerClick,
  Pencil, Play, StickyNote, Tag, UserPlus, AlertCircle, HelpCircle, Link2, MapPin, Navigation, Contact, GalleryHorizontal,
  Variable, CalendarClock, Sheet, IndianRupee, NotebookPen, CheckCircle2, BellRing, Users, Shuffle, CornerDownRight, type LucideIcon,
} from "lucide-react";
import type { FlowNode, NodeType } from "@/lib/flow-graph";

export type NodeMeta = { label: string; group: "Messages" | "Ask" | "Logic" | "Actions" | "Other"; icon: LucideIcon; defaults: () => Record<string, unknown> };

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
  carousel: { label: "Products", group: "Messages", icon: GalleryHorizontal, defaults: () => ({ header: "Our picks", text: "Take a look:", retailer_ids: [] }) },
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
};

export const AI_ICON = Bot;

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
    default: return "";
  }
}
