import type { NodeType } from "@/lib/flow-graph";
import { NODE_META, type NodeMeta } from "./node-meta";

/**
 * Batch 42: one colour per kind of step, so a canvas reads at a glance —
 * messages green, questions blue, logic violet, actions amber. The colours are
 * the app's chart palette (a flow is a diagram), so they follow light and dark.
 * Presentation only: the stored NodeType keys never change.
 */
export type NodeGroup = NodeMeta["group"];

export const GROUP_STYLE: Record<
  NodeGroup,
  {
    /** Icon chip on a step and in the palette. */
    chip: string;
    /** Accent strip on the step card. */
    bar: string;
    /** Thumbnail / minimap fill (a CSS colour). */
    fill: string;
    label: string;
  }
> = {
  Messages: { chip: "bg-chart-1/12 text-chart-1", bar: "bg-chart-1", fill: "var(--chart-1)", label: "Sends a message" },
  Ask: { chip: "bg-chart-2/12 text-chart-2", bar: "bg-chart-2", fill: "var(--chart-2)", label: "Waits for an answer" },
  Logic: { chip: "bg-chart-4/12 text-chart-4", bar: "bg-chart-4", fill: "var(--chart-4)", label: "Decides the path" },
  Actions: { chip: "bg-chart-3/15 text-chart-3", bar: "bg-chart-3", fill: "var(--chart-3)", label: "Does something" },
  Other: { chip: "bg-muted text-muted-foreground", bar: "bg-border-strong", fill: "var(--border-strong)", label: "" },
};

export function groupOf(kind: NodeType): NodeGroup {
  return NODE_META[kind]?.group ?? "Other";
}

export function styleOf(kind: NodeType) {
  return GROUP_STYLE[groupOf(kind)];
}
