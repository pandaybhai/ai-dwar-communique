import { NODE_META, type NodeMeta } from "@/components/flows/v2/node-meta";
import { KIND_LABELS } from "@/components/flows/v2/triggers-panel";
import type { FlowGraph, FlowNode, NodeType } from "@/lib/flow-graph";
import { stepName } from "@/lib/flow-responses";
import { runEventWords, triggerCopy } from "./copy";

/**
 * Batch 49: what the new Flows screens draw, as plain functions. Wording and
 * shapes only: nothing here changes a graph, a trigger or a run.
 */

export type StepGroup = NodeMeta["group"];

/**
 * A step's colour by its palette group (node-meta's NODE_META.group):
 * messages emerald, questions gold, logic violet, actions blue, start ink.
 */
export const GROUP_TONE: Record<
  StepGroup | "start",
  { chip: string; stroke: string; fill: string }
> = {
  Messages: {
    chip: "bg-aiden-soft text-aiden-deep",
    stroke: "var(--aiden)",
    fill: "var(--aiden-soft)",
  },
  Ask: { chip: "bg-gold-bg text-gold-ink", stroke: "var(--gold)", fill: "var(--gold-bg)" },
  Logic: { chip: "bg-av3 text-av3-ink", stroke: "var(--av3-ink)", fill: "var(--av3)" },
  Actions: { chip: "bg-av2 text-av2-ink", stroke: "var(--av2-ink)", fill: "var(--av2)" },
  Other: {
    chip: "bg-bubble-in text-muted-foreground",
    stroke: "var(--line)",
    fill: "var(--bubble-in)",
  },
  start: { chip: "bg-ink text-ink-foreground", stroke: "var(--ink)", fill: "var(--ink)" },
};

export function toneOf(type: NodeType) {
  if (type === "start") return GROUP_TONE.start;
  return GROUP_TONE[NODE_META[type]?.group ?? "Other"];
}

export type TriggerRow = {
  flow_id: string;
  kind: string;
  config: Record<string, unknown> | null;
  is_enabled: boolean;
};

/** "Keyword “menu”, “hi”", "First message ever", … for one trigger, with the Triggers panel's names. */
export function triggerText(t: Pick<TriggerRow, "kind" | "config">): string {
  if (t.kind === "keyword") {
    const kws = ((t.config?.["keywords"] as string[] | undefined) ?? []).filter(Boolean);
    if (kws.length) {
      const shown = kws
        .slice(0, 2)
        .map((k) => `“${k}”`)
        .join(", ");
      return triggerCopy.keyword(shown, Math.max(0, kws.length - 2));
    }
  }
  return KIND_LABELS[t.kind] ?? t.kind.replace(/_/g, " ");
}

/** How a flow starts on the list: its switched-on triggers, or that it has none. */
export function triggersLine(triggers: TriggerRow[]): string {
  const on = triggers.filter((t) => t.is_enabled);
  if (!on.length) return triggers.length ? triggerCopy.allOff : triggerCopy.none;
  return triggerCopy.startsOn(triggerText(on[0]!), on.length - 1);
}

/** The graph a flow's card shows: the published version, else the newest draft. */
export function graphForCard<
  V extends { flow_id: string; status: string; version: number; graph: FlowGraph },
>(versions: V[], flowId: string): FlowGraph | null {
  const mine = versions.filter((v) => v.flow_id === flowId).sort((a, b) => b.version - a.version);
  return (
    (
      mine.find((v) => v.status === "published") ??
      mine.find((v) => v.status === "draft") ??
      mine[0]
    )?.graph ?? null
  );
}

export type ThumbBox = { id: string; type: NodeType; x: number; y: number; w: number; h: number };
export type ThumbLine = { id: string; x1: number; y1: number; x2: number; y2: number };

const NODE_W = 256;
const NODE_H = 120;

/**
 * A flow's mini map: every step as a box at its canvas position, every link
 * as a line from the right of one box to the left of the next, fitted into a
 * width × height box with a margin. Sticky notes are left out.
 */
export function thumbnailLayout(graph: FlowGraph | null, width = 280, height = 120, pad = 12) {
  const nodes = (graph?.nodes ?? []).filter((n) => n.type !== "note");
  if (!nodes.length) return { boxes: [] as ThumbBox[], lines: [] as ThumbLine[] };
  const pos = (n: FlowNode, i: number) => n.position ?? { x: 80 + i * 40, y: 80 + i * 40 };
  const pts = nodes.map(pos);
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x + NODE_W));
  const maxY = Math.max(...pts.map((p) => p.y + NODE_H));
  const scale = Math.min(
    (width - pad * 2) / Math.max(1, maxX - minX),
    (height - pad * 2) / Math.max(1, maxY - minY),
  );
  const offX = (width - (maxX - minX) * scale) / 2;
  const offY = (height - (maxY - minY) * scale) / 2;
  const boxes: ThumbBox[] = nodes.map((n, i) => ({
    id: n.id,
    type: n.type,
    x: offX + (pts[i]!.x - minX) * scale,
    y: offY + (pts[i]!.y - minY) * scale,
    w: NODE_W * scale,
    h: NODE_H * scale,
  }));
  const at = new Map(boxes.map((b) => [b.id, b]));
  const lines: ThumbLine[] = [];
  for (const e of graph?.edges ?? []) {
    const a = at.get(e.source);
    const b = at.get(e.target);
    if (!a || !b) continue;
    lines.push({ id: e.id, x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2 });
  }
  return { boxes, lines };
}

/**
 * A step's name in a run's timeline, from the graph version that run used:
 * its own label, else its kind ("Buttons", "Question"), with what it says
 * quoted when it says something ("Buttons “Hi! How can we help?”").
 */
export function stepTitle(
  graph: FlowGraph | null | undefined,
  nodeId: string | null,
): string | null {
  if (!nodeId) return null;
  const node = graph?.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const label = String(node.data["label"] ?? "").trim();
  if (label) return label;
  const kind = NODE_META[node.type]?.label ?? node.type;
  const text = String(node.data["text"] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return `${kind} “${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
  const name = stepName(node);
  return name && name !== node.type && name !== kind ? `${kind} ${name}` : kind;
}

export function eventText(event: string, step: string | null): string {
  const words = runEventWords[event] ?? event.replace(/_/g, " ");
  if (!step) return words.replace(/ (at|from)$/, "");
  if (
    event === "started" ||
    event === "ended" ||
    event === "pause" ||
    event === "resume" ||
    event === "stop"
  )
    return words;
  return `${words} ${step}`;
}

/**
 * The events a timeline shows: "entered"/"exited" bookkeeping rows are
 * dropped (every step has them; the step's own event says more), the rest kept
 * in order, at most `limit`, the newest kept when cut.
 */
export function timelineEvents<E extends { event: string }>(events: E[], limit = 8): E[] {
  const shown = events.filter((e) => e.event !== "entered" && e.event !== "exited");
  return shown.length > limit ? shown.slice(-limit) : shown;
}
