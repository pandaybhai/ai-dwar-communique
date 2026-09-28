import { useCallback, useEffect, useState } from "react";
import { History, Play, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aidwar } from "@/integrations/aidwar/client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { callApi } from "@/lib/whatsapp-client";

type RunRow = {
  id: string;
  flow_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  trigger: Record<string, unknown>;
  events: Array<{ node_id: string | null; event: string; at: string }>;
};

const EVENT_LABEL: Record<string, string> = {
  started: "Started",
  entered: "Step",
  exited: "Moved on",
  reply: "Customer replied",
  send: "Message sent",
  ended: "Finished",
  failed: "Failed",
  pause: "Paused",
  resume: "Resumed",
  stop: "Stopped",
  opted_out: "Opted out",
};

/** Per-contact flow run log + "start a flow manually" for the inbox header. */
export function FlowRunHistory({
  organizationId,
  contactId,
  conversationId,
}: {
  organizationId: string;
  contactId: string;
  conversationId: string;
}) {
  const { enabled } = useFeatureFlag("flows_v2");
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [manualFlows, setManualFlows] = useState<Array<{ id: string; name: string }>>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    const { data, error } = await callApi<{ runs: RunRow[] }>("/api/flows/triggers", {
      body: { action: "contact_runs", organization_id: organizationId, contact_id: contactId },
    });
    if (!error) setRuns(data?.runs ?? []);
    // Flows with a "manual" trigger, published, for the start picker.
    const { data: trigs } = await aidwar
      .from("flow_triggers")
      .select("flow_id, flows(name)")
      .eq("organization_id", organizationId)
      .eq("kind", "manual")
      .eq("is_enabled", true);
    setManualFlows(
      ((trigs ?? []) as unknown as Array<{ flow_id: string; flows: { name: string } | null }>).map((t) => ({
        id: t.flow_id,
        name: t.flows?.name ?? "Flow",
      })),
    );
  }, [enabled, organizationId, contactId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!enabled) return null;

  const start = async () => {
    if (!pick) return;
    setBusy(true);
    const { error } = await callApi("/api/flows/triggers", {
      body: { action: "start", organization_id: organizationId, flow_id: pick, contact_id: contactId, conversation_id: conversationId },
    });
    setBusy(false);
    if (error) toast.error(error);
    else {
      toast.success("Flow started for this customer.");
      void load();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="rounded-full" aria-label="Flow history">
          <History className="mr-1 h-3.5 w-3.5" /> Flows
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[90vw] p-3">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Workflow className="h-4 w-4 text-primary" /> Flow runs for this customer
        </p>
        {runs === null ? (
          <div className="space-y-2">
            <div className="h-10 animate-pulse rounded-lg bg-muted" />
            <div className="h-10 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            No flow runs yet.
          </p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {runs.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{r.flow_name}</p>
                  <span className="rounded-full bg-muted px-2 py-0.5 capitalize">{r.status}</span>
                </div>
                <p className="mt-0.5 text-muted-foreground">
                  {new Date(r.started_at).toLocaleString("en-IN")}
                  {r.trigger["kind"] ? ` · via ${String(r.trigger["kind"]).replace(/_/g, " ")}` : ""}
                </p>
                {r.events.length > 0 && (
                  <ol className="mt-1.5 space-y-0.5 border-l-2 border-muted pl-2 text-muted-foreground">
                    {r.events.slice(-8).map((e, i) => (
                      <li key={i}>
                        {EVENT_LABEL[e.event] ?? e.event}
                        {e.node_id ? ` · ${e.node_id.slice(0, 18)}` : ""}{" "}
                        <span className="opacity-70">{new Date(e.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
        {can("ai.configure") && manualFlows.length > 0 && (
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
            <Select value={pick} onValueChange={setPick}>
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue placeholder="Start a flow…" />
              </SelectTrigger>
              <SelectContent>
                {manualFlows.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8" disabled={!pick || busy} onClick={() => void start()}>
              <Play className="mr-1 h-3 w-3" /> Start
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
