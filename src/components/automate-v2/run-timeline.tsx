import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { relativeTime } from "@/lib/catalog";
import type { FlowGraph } from "@/lib/flow-graph";
import { RESPONSE_STATUS_LABELS, responseStatus, type ResponseStatus } from "@/lib/flow-responses";
import { cn } from "@/lib/utils";
import { eventText, stepTitle, timelineEvents, triggerText } from "./flows-v2";

type Run = {
  id: string;
  version_id: string;
  contact_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  trigger: Record<string, unknown> | null;
  last_error: string | null;
};
type RunEvent = { run_id: string; node_id: string | null; event: string; at: string };

const STATUS_TONE: Record<ResponseStatus, string> = {
  finished: "bg-aiden-soft text-aiden-deep",
  waiting: "bg-gold-bg text-gold-ink",
  stopped: "bg-bubble-in text-muted-foreground",
  failed: "bg-danger-soft text-danger-soft-foreground",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/**
 * Batch 49: a flow's run history as a timeline: its last 10 runs (who, how it
 * started, how it ended) and, per run, what happened step by step, with each
 * step named from the version that run used. Reads only, with the member's
 * own access (flow_runs, flow_run_events, flow_versions and contacts are
 * readable by every member), and only for one flow at a time, on the
 * (flow_id, started_at) index the list's counts already use.
 */
export function RunTimeline({
  organizationId,
  flowId,
  flowName,
}: {
  organizationId: string;
  flowId: string;
  flowName: string;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({});
  const [graphs, setGraphs] = useState<Record<string, FlowGraph>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setFailed(false);
    void (async () => {
      const { data, error } = await aidwar
        .from("flow_runs")
        .select("id, version_id, contact_id, status, started_at, ended_at, trigger, last_error")
        .eq("organization_id", organizationId)
        .eq("flow_id", flowId)
        .order("started_at", { ascending: false })
        .limit(10);
      if (!live) return;
      if (error) {
        setFailed(true);
        setRuns([]);
        return;
      }
      const list = (data ?? []) as Run[];
      setRuns(list);
      if (!list.length) return;
      const versionIds = [...new Set(list.map((r) => r.version_id))];
      const contactIds = [...new Set(list.map((r) => r.contact_id))];
      const [ev, vers, people] = await Promise.all([
        aidwar
          .from("flow_run_events")
          .select("run_id, node_id, event, at")
          .eq("organization_id", organizationId)
          .in("run_id", list.map((r) => r.id))
          .order("at", { ascending: true })
          .limit(500),
        aidwar.from("flow_versions").select("id, graph").eq("organization_id", organizationId).in("id", versionIds),
        aidwar.from("contacts").select("id, name, phone").eq("organization_id", organizationId).in("id", contactIds),
      ]);
      if (!live) return;
      const byRun: Record<string, RunEvent[]> = {};
      for (const e of (ev.data ?? []) as RunEvent[]) (byRun[e.run_id] ??= []).push(e);
      setEvents(byRun);
      setGraphs(
        Object.fromEntries(((vers.data ?? []) as Array<{ id: string; graph: FlowGraph }>).map((v) => [v.id, v.graph])),
      );
      setNames(
        Object.fromEntries(
          ((people.data ?? []) as Array<{ id: string; name: string | null; phone: string }>).map((c) => [
            c.id,
            c.name?.trim() || c.phone,
          ]),
        ),
      );
    })();
    return () => {
      live = false;
    };
  }, [organizationId, flowId]);

  if (runs === null) {
    return (
      <div className="flex flex-col gap-2" aria-label={`Loading runs of ${flowName}`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-[18px] bg-bubble-in motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  if (failed) return <p className="m-0 text-sm text-muted-foreground">The run history didn&rsquo;t load. Refresh to try again.</p>;
  if (!runs.length) {
    return (
      <p className="m-0 flex items-center gap-2 rounded-[18px] border border-dashed border-line px-4 py-5 text-sm text-muted-foreground">
        <History className="h-4 w-4 shrink-0" aria-hidden="true" />
        {flowName} hasn&rsquo;t run for anyone yet. Runs show up here as customers go through it.
      </p>
    );
  }

  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {runs.map((run) => {
        const status = responseStatus(run.status);
        const graph = graphs[run.version_id];
        const shown = timelineEvents(events[run.id] ?? []);
        const how = run.trigger?.["kind"] ? triggerText({ kind: String(run.trigger["kind"]), config: run.trigger }) : null;
        return (
          <li key={run.id} className="rounded-[18px] border border-line bg-surface p-4 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="m-0 min-w-0 font-semibold text-foreground">
                {names[run.contact_id] ?? "A customer"}
                <span className="ml-2 text-sm font-medium text-muted-foreground">
                  {relativeTime(run.started_at)}
                  {how ? `, from ${how.charAt(0).toLowerCase()}${how.slice(1)}` : ""}
                </span>
              </p>
              <span className={cn("rounded-full px-2.5 py-0.5 text-[13px] font-semibold", STATUS_TONE[status])}>
                {RESPONSE_STATUS_LABELS[status]}
              </span>
            </div>
            {shown.length ? (
              <ol className="m-0 mt-3 flex list-none flex-col gap-0 border-l-2 border-line p-0 pl-4">
                {shown.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex items-baseline justify-between gap-3 py-1 text-sm">
                    <span
                      className={cn(
                        "min-w-0",
                        e.event === "failed" || e.event.endsWith("_failed") ? "font-semibold text-danger" : "text-foreground",
                      )}
                    >
                      {eventText(e.event, stepTitle(graph, e.node_id))}
                    </span>
                    <time dateTime={e.at} className="shrink-0 tabular-nums text-muted-foreground">
                      {clock(e.at)}
                    </time>
                  </li>
                ))}
              </ol>
            ) : null}
            {run.last_error && status === "failed" ? (
              <p className="m-0 mt-2 text-sm text-danger">{run.last_error}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
