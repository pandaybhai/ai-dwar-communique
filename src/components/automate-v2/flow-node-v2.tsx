import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RFData } from "@/components/flows/v2/flow-node";
import { NODE_META, handleLabel, summary } from "@/components/flows/v2/node-meta";
import { outputsOf, type FlowNode } from "@/lib/flow-graph";
import { cn } from "@/lib/utils";
import { toneOf } from "./flows-v2";
import "./flow-builder-v2.css";

/**
 * Batch 49: a flow step on the builder's canvas in the new design. Drawing
 * only: the same handles as FlowNodeView (a target on the left except on
 * Start and sticky notes, one source per outputsOf() handle id on the
 * right), the same label, picture, summary, problems and stats, so a saved
 * graph connects and behaves exactly as before. The step's icon takes its
 * palette group's colour (messages, questions, logic, actions).
 */
export function FlowNodeViewV2({ id, data, selected }: NodeProps & { data: RFData }) {
  const meta = NODE_META[data.kind];
  const node: FlowNode = { id, type: data.kind, data: data.data };
  const outs = outputsOf(node);
  const bad = (data.problems?.length ?? 0) > 0;
  const isNote = data.kind === "note";
  const tone = toneOf(data.kind);
  return (
    <div
      className={cn(
        "nd-flow-step w-64 rounded-[18px] border bg-surface text-foreground shadow-md transition-shadow duration-200",
        selected ? "outline-2 outline-offset-2 outline-aiden" : "hover:shadow-lg",
        bad ? "border-danger" : "border-line",
        isNote && "border-gold-line bg-gold-bg",
      )}
    >
      {data.kind !== "start" && !isNote && (
        <Handle type="target" position={Position.Left} className="nd-flow-handle" />
      )}
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-3">
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full", tone.chip)}>
          <meta.icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">
            {String(data.data["label"] ?? "") || meta.label}
          </span>
          {String(data.data["label"] ?? "") ? (
            <span className="block truncate text-xs text-muted-foreground">{meta.label}</span>
          ) : null}
        </span>
        {data.stats && (
          <span
            className="shrink-0 rounded-full bg-bubble-in px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground"
            title="entered, moved on, dropped"
          >
            {data.stats.entered}/{data.stats.exited}/{data.stats.dropped}
          </span>
        )}
      </div>
      {(data.kind === "text" || data.kind === "buttons") &&
        String(data.data["image_url"] ?? "").trim() && (
          <img
            src={String(data.data["image_url"])}
            alt=""
            loading="lazy"
            className="mx-3.5 mb-2 h-20 w-[calc(100%-1.75rem)] rounded-[10px] object-cover"
          />
        )}
      {summary(node) && (
        <p className="m-0 mx-3.5 mb-3 line-clamp-3 whitespace-pre-wrap rounded-[12px] bg-bubble-in px-2.5 py-2 text-xs text-foreground">
          {summary(node)}
        </p>
      )}
      {bad && (
        <p className="m-0 px-3.5 pb-2 text-xs font-semibold text-danger">{data.problems![0]}</p>
      )}
      {outs.length > 0 && (
        <div className="space-y-1 border-t border-line px-3.5 py-2">
          {outs.map((h) => (
            <div
              key={h}
              className="relative flex h-5 items-center justify-end text-[11px] font-semibold text-muted-foreground"
            >
              <span className="truncate pr-2">{handleLabel(node, h) || "Next"}</span>
              <Handle
                id={h}
                type="source"
                position={Position.Right}
                className="nd-flow-handle !right-[-18px]"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
