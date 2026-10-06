import { useCallback, useEffect, useState } from "react";
import { MessageSquareText, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { argsLine, type AiRunView, type ToolTraceEntry } from "@/lib/ai-run-view";

/** What each tool was asked and what it found — one line per call. */
export function ToolTrace({ tools }: { tools: ToolTraceEntry[] }) {
  if (!tools.length) return <p className="text-xs text-muted-foreground">No tool used.</p>;
  return (
    <ul className="space-y-1.5">
      {tools.map((t, i) => {
        const args = argsLine(t.args);
        const result = !t.ok
          ? `failed${t.error ? ` — ${t.error}` : ""}`
          : t.nothing_found
            ? t.rows
              ? `no exact match · ${t.rows} closest`
              : "found nothing"
            : `${t.rows ?? 0} found`;
        return (
          <li key={i} className="rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono font-medium text-foreground">{t.tool}</span>
              <span
                className={
                  !t.ok || (t.nothing_found && !t.rows)
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {result}
              </span>
            </div>
            {args ? (
              <p className="mt-0.5 break-all font-mono text-muted-foreground">{args}</p>
            ) : null}
            {t.found.length ? (
              <p className="mt-0.5 text-muted-foreground">{t.found.join(", ")}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Workspaces → the last 25 customer answers: question, reply, status and the
 * tool trace, so a wrong answer can be read back without SQL. Read-only.
 */
export function RecentAnswersPanel({ organizationId }: { organizationId: string }) {
  const [runs, setRuns] = useState<AiRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRuns(null);
    setError(null);
    const { data, error: err } = await callApi<{ runs: AiRunView[] }>("/api/admin/ai", {
      body: { action: "aiden_runs", organization_id: organizationId },
    });
    if (err) setError(err);
    setRuns(data?.runs ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-foreground">Recent answers</h3>
          <p className="text-xs text-muted-foreground">
            The last 25 customer replies, and what each tool was asked and found.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={runs === null}>
          <RotateCcw className="mr-1 h-4 w-4" /> Refresh
        </Button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {runs === null ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 && !error ? (
        <EmptyState
          icon={MessageSquareText}
          title="No customer answers yet"
          description="Answers Aiden gives this workspace's customers show up here."
        />
      ) : (
        <ul className="max-h-[60vh] divide-y divide-border/50 overflow-auto">
          {runs.map((r) => (
            <li key={r.id} className="py-2">
              <button
                type="button"
                onClick={() => setOpen(open === r.id ? null : r.id)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-2 py-1 text-left text-sm transition-colors duration-150 hover:bg-muted/60"
              >
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleString("en-IN")}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {r.question || "—"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${r.status === "ok" ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"}`}
                >
                  {r.escalation ? `${r.status} · ${r.escalation}` : r.status}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {r.tools.length ? r.tools.map((t) => t.tool).join(", ") : "no tools"}
                </span>
              </button>
              {open === r.id ? (
                <div className="mt-2 space-y-2 px-2">
                  <p className="whitespace-pre-wrap rounded-lg bg-muted/30 px-3 py-2 text-sm text-foreground">
                    {r.reply || "(no reply text)"}
                  </p>
                  <ToolTrace tools={r.tools} />
                  <p className="font-mono text-[11px] text-muted-foreground">
                    run {r.id}
                    {r.conversation_id ? ` · conversation ${r.conversation_id}` : ""}
                    {r.model ? ` · ${r.model}` : ""}
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
