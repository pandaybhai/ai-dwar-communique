import type { FlowGraph } from "@/lib/flow-graph";
import { cn } from "@/lib/utils";
import { thumbnailLayout, toneOf } from "./flows-v2";

/**
 * Batch 49: a flow's mini map for the Flows list: each step a small box in its
 * group's colour, each link a line, on the chat wall's dots. Decorative; the
 * card says the flow's name and step count in words.
 */
export function FlowThumbnail({
  graph,
  className,
}: {
  graph: FlowGraph | null;
  className?: string;
}) {
  const W = 280;
  const H = 120;
  const { boxes, lines } = thumbnailLayout(graph, W, H);
  return (
    <div
      aria-hidden="true"
      className={cn("nd-wall overflow-hidden rounded-[14px] border border-line", className)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[120px] w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {lines.map((l) => {
          const mid = (l.x1 + l.x2) / 2;
          return (
            <path
              key={l.id}
              d={`M${l.x1},${l.y1} C${mid},${l.y1} ${mid},${l.y2} ${l.x2},${l.y2}`}
              fill="none"
              stroke="var(--muted-ink)"
              strokeOpacity={0.45}
              strokeWidth={1.25}
            />
          );
        })}
        {boxes.map((b) => {
          const tone = toneOf(b.type);
          return (
            <rect
              key={b.id}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={Math.min(6, b.h / 3)}
              fill={b.type === "start" ? tone.fill : "var(--surface)"}
              stroke={tone.stroke}
              strokeWidth={1.25}
            />
          );
        })}
      </svg>
    </div>
  );
}
