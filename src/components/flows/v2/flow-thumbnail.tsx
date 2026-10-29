import { memo } from "react";
import type { FlowGraph } from "@/lib/flow-graph";
import { cn } from "@/lib/utils";
import { GROUP_STYLE, groupOf } from "./node-style";

const NODE_W = 256;
const NODE_H = 120;

/**
 * Batch 42: a flow drawn small — every step a coloured block where it sits on
 * the canvas, every connection a line. Decorative (the row says the name), so
 * it is hidden from screen readers. An empty or unread graph shows a dashed box.
 */
function FlowThumbnailView({
  graph,
  className,
}: {
  graph: FlowGraph | null | undefined;
  className?: string;
}) {
  const nodes = (graph?.nodes ?? []).filter((n) => n.type !== "note");
  if (!graph || nodes.length === 0) {
    return (
      <div
        aria-hidden="true"
        className={cn("rounded-lg border border-dashed border-border bg-subtle", className)}
      />
    );
  }
  const pos = new Map(
    nodes.map((n, i) => [n.id, n.position ?? { x: i * 320, y: 0 }] as const),
  );
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX + NODE_W;
  const h = Math.max(...ys) - minY + NODE_H;
  const pad = 60;
  return (
    <svg
      aria-hidden="true"
      viewBox={`${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      className={cn("rounded-lg border border-border bg-subtle", className)}
    >
      {graph.edges.map((e) => {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) return null;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        return (
          <path
            key={e.id}
            d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={14}
          />
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id)!;
        return (
          <rect
            key={n.id}
            x={p.x}
            y={p.y}
            width={NODE_W}
            height={NODE_H}
            rx={28}
            fill={GROUP_STYLE[groupOf(n.type)].fill}
            opacity={n.type === "start" || n.type === "end" ? 0.55 : 0.9}
          />
        );
      })}
    </svg>
  );
}

export const FlowThumbnail = memo(FlowThumbnailView);
