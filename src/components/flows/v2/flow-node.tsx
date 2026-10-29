import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertCircle } from "lucide-react";
import { outputsOf, type FlowNode, type NodeType } from "@/lib/flow-graph";
import { cn } from "@/lib/utils";
import { NODE_META, handleLabel, summary } from "./node-meta";
import { styleOf } from "./node-style";

export type RFData = { kind: NodeType; data: Record<string, unknown>; problems?: string[] | undefined; stats?: { entered: number; exited: number; dropped: number } | undefined };

const count = new Intl.NumberFormat("en-IN");
const handleCls =
  "!h-2.5 !w-2.5 !border-2 !border-card !bg-border-strong transition-[background-color,transform] duration-150 hover:!scale-125 hover:!bg-primary";

/**
 * Batch 42: a step on the canvas — its kind's colour and icon, its own name,
 * what it says, and one labelled exit per output. A step with something to fix
 * carries a red badge and the first problem; the published version's counts
 * show how many customers reached it and how many stopped there.
 */
function FlowNodeView({ id, data, selected }: NodeProps & { data: RFData }) {
  const meta = NODE_META[data.kind];
  const style = styleOf(data.kind);
  const node: FlowNode = { id, type: data.kind, data: data.data };
  const outs = outputsOf(node);
  const problems = data.problems ?? [];
  const bad = problems.length > 0;
  const isNote = data.kind === "note";
  const isEdge = data.kind === "start" || data.kind === "end";
  const name = String(data.data["label"] ?? "") || meta.label;
  const text = summary(node);
  return (
    <div
      className={cn(
        "relative w-64 rounded-xl border bg-card text-card-foreground shadow-xs transition-[box-shadow,border-color] duration-150 motion-reduce:transition-none",
        selected ? "border-primary shadow-md ring-2 ring-primary/25" : "hover:shadow-md",
        bad ? "border-danger-border" : !selected && "border-border",
        isNote && "border-warning-border bg-warning-soft",
        isEdge && "w-48",
      )}
    >
      {!isNote && !isEdge ? <span aria-hidden="true" className={cn("absolute inset-x-3 top-0 h-0.5 rounded-b-full", style.bar)} /> : null}
      {data.kind !== "start" && !isNote && <Handle type="target" position={Position.Left} className={handleCls} />}
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", style.chip)}>
          <meta.icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-semibold leading-tight">{name}</span>
          {name !== meta.label ? <span className="block truncate text-[0.6875rem] leading-tight text-muted-foreground">{meta.label}</span> : null}
        </span>
        {bad ? (
          <span
            className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-full bg-danger px-1 text-[0.6875rem] font-semibold text-danger-foreground"
            title={problems.join("\n")}
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            {problems.length}
            <span className="sr-only"> {problems.length === 1 ? "thing" : "things"} to fix</span>
          </span>
        ) : null}
      </div>
      {(data.kind === "text" || data.kind === "buttons") && String(data.data["image_url"] ?? "").trim() && (
        <img src={String(data.data["image_url"])} alt="" loading="lazy" className="mx-3 mt-1 h-20 w-[calc(100%-1.5rem)] rounded-lg object-cover" />
      )}
      {text && <p className="line-clamp-3 whitespace-pre-wrap px-3 pb-2 text-xs leading-relaxed text-muted-foreground">{text}</p>}
      {bad && (
        <p className="mx-3 mb-2 flex items-start gap-1 rounded-md bg-danger-soft px-2 py-1 text-[0.6875rem] leading-snug text-danger-soft-foreground">
          {problems[0]}
        </p>
      )}
      {data.stats && (
        <div className="mx-3 mb-2 flex items-center gap-2 text-[0.6875rem] text-muted-foreground" title="Customers who reached this step, and who stopped here, in the published version">
          <span className="tabular rounded bg-muted px-1.5 py-0.5"><span className="font-semibold text-foreground">{count.format(data.stats.entered)}</span> reached</span>
          {data.stats.dropped > 0 ? (
            <span className="tabular rounded bg-warning-soft px-1.5 py-0.5 text-warning-soft-foreground"><span className="font-semibold">{count.format(data.stats.dropped)}</span> stopped</span>
          ) : null}
        </div>
      )}
      {outs.length > 0 && (
        <div className="space-y-1 border-t border-border px-3 py-2">
          {outs.map((h) => (
            <div key={h} className="relative flex h-5 items-center justify-end text-[0.6875rem] text-muted-foreground">
              <span className="truncate pr-2">{handleLabel(node, h) || "Next"}</span>
              <Handle id={h} type="source" position={Position.Right} className={cn(handleCls, "!right-[-17px]")} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const FlowNodeCard = memo(FlowNodeView);
