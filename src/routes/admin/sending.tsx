import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { cn } from "@/lib/utils";
import type { SendingNow, SendingRow } from "@/lib/admin-sending";

const DESCRIPTION =
  "Campaigns sending right now — speed over the last minute, how many are sent and left, and when each should finish.";
const REFRESH_MS = 5_000;

export const Route = createFileRoute("/admin/sending")({
  head: () => ({
    meta: [
      { title: "Sending now — AiDwar Admin" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Sending now — AiDwar Admin" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminSending,
});

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

const STATUS_CLASS: Record<string, string> = {
  sending: "bg-emerald-50 text-emerald-800",
  paused: "bg-amber-50 text-amber-800",
  scheduled: "bg-sky-50 text-sky-800",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

function Progress({ row }: { row: SendingRow }) {
  const done =
    row.total > 0
      ? Math.min(100, Math.round(((row.total - (row.remaining ?? 0)) / row.total) * 100))
      : 0;
  return (
    <div className="min-w-[8rem]">
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${done}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{done}%</div>
    </div>
  );
}

function AdminSending() {
  const [data, setData] = useState<SendingNow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: res, error: err } = await callApi<SendingNow>("/api/admin/sending", {
      method: "GET",
    });
    setLoading(false);
    if (err || !res) {
      setError(err ?? "We couldn't load what's sending.");
      return;
    }
    setError(null);
    setData(res);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <PageHeader title="Sending now" description={DESCRIPTION} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => void load()}>
          <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
        {data ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-semibold text-primary">
            <Send className="h-3.5 w-3.5" /> {data.total_rate_per_sec} msg/s across{" "}
            {data.active.filter((r) => r.status === "sending").length} campaigns
          </span>
        ) : null}
        {data ? (
          <span className="text-xs text-muted-foreground">
            Updated {when(data.generated_at)} · refreshes every {REFRESH_MS / 1000}s · speed = last{" "}
            {data.window_seconds}s
          </span>
        ) : null}
      </div>

      {error ? <ErrorState message={error} /> : null}

      {data && data.active.length === 0 ? (
        <EmptyState
          icon={Send}
          title="Nothing is sending"
          description="Running, paused and due campaigns show up here."
        />
      ) : null}

      {data && data.active.length > 0 ? (
        <div className="mb-10 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Campaign</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Progress</th>
                <th className="px-4 py-3 text-right">Speed</th>
                <th className="px-4 py-3 text-right">Sent</th>
                <th className="px-4 py-3 text-right">Failed</th>
                <th className="px-4 py-3 text-right">Left</th>
                <th className="px-4 py-3 text-right">ETA</th>
              </tr>
            </thead>
            <tbody>
              {data.active.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{row.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.workspace} · started {when(row.started_at)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_CLASS[row.status] ?? "bg-muted",
                      )}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Progress row={row} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.rate_per_sec ?? 0} msg/s
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.sent.toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.failed.toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.remaining?.toLocaleString("en-IN") ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.status === "sending" ? duration(row.eta_seconds) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data && data.recent.length > 0 ? (
        <>
          <h2 className="mb-3 text-lg font-semibold text-foreground">Finished in the last hour</h2>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Campaign</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Sent</th>
                  <th className="px-4 py-3 text-right">Failed</th>
                  <th className="px-4 py-3 text-right">Took</th>
                  <th className="px-4 py-3 text-right">Average speed</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((row) => {
                  const took =
                    row.started_at && row.completed_at
                      ? Math.round(
                          (Date.parse(row.completed_at) - Date.parse(row.started_at)) / 1000,
                        )
                      : null;
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{row.name}</div>
                        <div className="text-xs text-muted-foreground">{row.workspace}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            STATUS_CLASS[row.status] ?? "bg-muted",
                          )}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.sent.toLocaleString("en-IN")}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.failed.toLocaleString("en-IN")}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{duration(took)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.rate_per_sec === null ? "—" : `${row.rate_per_sec} msg/s`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
