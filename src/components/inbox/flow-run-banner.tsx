import { useCallback, useEffect, useState } from "react";
import { Pause, Play, Square, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { aidwar } from "@/integrations/aidwar/client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { callApi } from "@/lib/whatsapp-client";
import type { FlowGraph } from "@/lib/flow-graph";

type ActiveRun = {
  id: string;
  status: string;
  current_node_id: string | null;
  flows: { name: string } | null;
  flow_versions: { graph: FlowGraph } | null;
};

const NODE_LABEL: Record<string, string> = {
  start: "Start", text: "Message", buttons: "Buttons", list: "List", template: "Template", form: "Form",
  ask: "Question", wait: "Wait", branch: "Branch", tag: "Tag", set_field: "Update field", assign: "Assign",
  needs_you: "Needs you", end: "End",
};

/** "In flow: <flow> – <step>" with Pause / Stop / Resume. */
export function FlowRunBanner({ organizationId, contactId }: { organizationId: string; contactId: string }) {
  const { enabled } = useFeatureFlag("flows_v2");
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    const { data } = await aidwar
      .from("flow_runs")
      .select("id, status, current_node_id, flows(name), flow_versions(graph)")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .in("status", ["running", "waiting", "paused"])
      .order("updated_at", { ascending: false })
      .limit(1);
    setRun(((data ?? []) as unknown as ActiveRun[])[0] ?? null);
  }, [enabled, organizationId, contactId]);

  useEffect(() => {
    void load();
    if (!enabled) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load, enabled]);

  if (!enabled || !run) return null;
  const node = run.flow_versions?.graph.nodes.find((n) => n.id === run.current_node_id);
  const label = node ? String(node.data["label"] ?? "") || NODE_LABEL[node.type] || node.type : "—";

  const act = async (action: "pause" | "stop" | "resume") => {
    setBusy(true);
    const { error } = await callApi("/api/flows/runs", {
      body: { organization_id: organizationId, run_id: run.id, action },
    });
    setBusy(false);
    if (error) toast.error(error);
    else toast.success(action === "stop" ? "Flow stopped for this customer." : action === "pause" ? "Flow paused." : "Flow resumed.");
    await load();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs">
      <Workflow className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      <span className="font-medium">
        In flow: {run.flows?.name ?? "Flow"} – {label}
        {run.status === "paused" ? " (paused)" : ""}
      </span>
      <span className="text-muted-foreground">Aiden and auto-replies stay quiet while it waits.</span>
      <div className="ml-auto flex gap-1">
        {run.status === "paused" ? (
          <Button size="sm" variant="outline" className="h-7 rounded-full" disabled={busy} onClick={() => void act("resume")}>
            <Play className="mr-1 h-3 w-3" /> Resume
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 rounded-full" disabled={busy} onClick={() => void act("pause")}>
            <Pause className="mr-1 h-3 w-3" /> Pause
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 rounded-full" disabled={busy} onClick={() => void act("stop")}>
          <Square className="mr-1 h-3 w-3" /> Stop
        </Button>
      </div>
    </div>
  );
}
