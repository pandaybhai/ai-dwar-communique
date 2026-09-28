import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { outputsOf, type FlowNode, type NodeType } from "@/lib/flow-graph";
import { NODE_META, handleLabel, summary } from "./node-meta";

export type RFData = { kind: NodeType; data: Record<string, unknown>; problems?: string[]; stats?: { entered: number; exited: number; dropped: number } };

function FlowNodeView({ id, data, selected }: NodeProps & { data: RFData }) {
  const meta = NODE_META[data.kind];
  const node: FlowNode = { id, type: data.kind, data: data.data };
  const outs = outputsOf(node);
  const bad = (data.problems?.length ?? 0) > 0;
  const isNote = data.kind === "note";
  return (
    <div
      className={`w-64 rounded-2xl border bg-card text-card-foreground shadow-sm transition-shadow duration-200 ${
        selected ? "ring-2 ring-primary shadow-md" : "hover:shadow-md"
      } ${bad ? "border-destructive" : "border-border"} ${isNote ? "bg-accent/40" : ""}`}
    >
      {data.kind !== "start" && !isNote && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary"><meta.icon className="h-3.5 w-3.5" /></span>
        <span className="truncate text-sm font-semibold">{String(data.data["label"] ?? "") || meta.label}</span>
        {data.stats && (
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground" title="entered · exited · dropped">
            {data.stats.entered}·{data.stats.exited}·{data.stats.dropped}
          </span>
        )}
      </div>
      {summary(node) && <p className="line-clamp-3 whitespace-pre-wrap px-3 py-2 text-xs text-muted-foreground">{summary(node)}</p>}
      {bad && <p className="px-3 pb-2 text-xs text-destructive">{data.problems![0]}</p>}
      {outs.length > 0 && (
        <div className="space-y-1 border-t border-border px-3 py-2">
          {outs.map((h) => (
            <div key={h} className="relative flex h-5 items-center justify-end text-[11px] text-muted-foreground">
              <span className="truncate pr-2">{handleLabel(node, h) || "Next"}</span>
              <Handle id={h} type="source" position={Position.Right} className="!right-[-18px] !h-3 !w-3 !border-2 !border-background !bg-primary" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const FlowNodeCard = memo(FlowNodeView);
