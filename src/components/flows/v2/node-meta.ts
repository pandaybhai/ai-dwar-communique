import {
  Bot, Clock, FileText, Flag, GitBranch, ListChecks, MessageSquare, MessageSquareText, MousePointerClick,
  Pencil, Play, StickyNote, Tag, UserPlus, AlertCircle, HelpCircle, type LucideIcon,
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
  note: { label: "Note", group: "Other", icon: StickyNote, defaults: () => ({ text: "Note to your team" }) },
};

export const AI_ICON = Bot;

export function handleLabel(node: FlowNode, handle: string): string {
  if (handle === "next") return "";
  if (handle === "else") return "Else";
  if (handle === "window_closed") return "Window closed";
  if (handle === "invalid") return "Unexpected";
  if (handle === "timeout") return "No reply";
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
    case "assign": return d["user_id"] ? "To a teammate" : "To the team queue";
    default: return "";
  }
}
