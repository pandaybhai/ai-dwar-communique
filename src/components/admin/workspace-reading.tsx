import { useCallback, useEffect, useState } from "react";
import { Globe, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi } from "@/lib/whatsapp-client";

/**
 * /admin/aiden → Workspaces → one workspace's websites: "Force full read"
 * (skips the trial gate and the re-read cooldown; the plan's paid-page limit
 * still applies unless ticked) and the read log, run by run.
 */

const adminApi = (body: Record<string, unknown>) => callApi<Record<string, unknown>>("/api/admin/ai", { body });

type Source = {
  id: string;
  name: string;
  status: string;
  url: string | null;
  mode: string | null;
  discovery: string;
  pages_seen: number | null;
  item_count: number | null;
  products_found: number | null;
  paid_pages: number;
  resume: boolean;
  deleted: boolean;
  swap_blocked: { reasons?: string[] } | null;
  last_synced_at: string | null;
  last_full_read_at: string | null;
  last_error: string | null;
  /** Logged runs' cost: reader + facts + embeddings (₹). */
  read_cost?: { total: number; reader: number; facts: number; embeddings: number; runs: number };
};
type LogRow = { source_id: string | null; action: string; at: string; details: Record<string, unknown> };

const when = (v?: string | null) =>
  v ? new Date(v).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

function logLine(row: LogRow): string {
  const d = row.details;
  if (row.action === "reading_run") {
    const engines = Object.entries((d["engines"] ?? {}) as Record<string, number>)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    return [
      `${String(d["mode"] ?? "")} run`,
      `${Number(d["pages"] ?? 0)} pages (${Number(d["saved"] ?? 0)} saved)`,
      `${Number(d["products"] ?? 0)} products`,
      engines ? `engines: ${engines}` : null,
      `credits ${Number(d["credits"] ?? 0)} · cost ₹${Number(d["cost"] ?? 0)}`,
      d["facts_cost"] !== undefined
        ? `(reader ₹${Number(d["reader_cost"] ?? 0)} · facts ₹${Number(d["facts_cost"] ?? 0)} · embeddings ₹${Number(d["embed_cost"] ?? 0)})`
        : null,
      Number(d["failed"] ?? 0) ? `${Number(d["failed"])} failed` : null,
      Number(d["gone"] ?? 0) ? `${Number(d["gone"])} not found` : null,
      Number(d["unchanged_skipped"] ?? 0) ? `${Number(d["unchanged_skipped"])} unchanged skipped` : null,
      `${Math.round(Number(d["ms"] ?? 0) / 1000)} s`,
      d["more"] ? "continues" : "finished",
      Array.isArray(d["swap_blocked"]) ? `kept live version: ${(d["swap_blocked"] as string[]).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (row.action === "reading_force_full") return `Force full read by admin${d["ignore_paid_caps"] ? " (paid-page limit ignored)" : ""}`;
  if (row.action === "reading_host_changed") return `Address moved: ${String(d["from"] ?? "")} → ${String(d["to"] ?? "")}`;
  if (row.action === "reading_swap_blocked") return `Kept the live version: ${((d["reasons"] ?? []) as string[]).join("; ")}`;
  if (row.action === "reading_site_changed") return `Site change (${String(d["kind"] ?? "")}): ${String(d["detail"] ?? "")}`;
  return row.action;
}

export function WorkspaceReadingPanel({ organizationId }: { organizationId: string }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [ignoreCaps, setIgnoreCaps] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await adminApi({ action: "reading_log", organization_id: organizationId });
    if (error) {
      toast.error(error);
      return;
    }
    setSources((data?.["sources"] as Source[]) ?? []);
    setLog((data?.["log"] as LogRow[]) ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const force = async (sourceId: string | null) => {
    setBusy(sourceId ?? "all");
    const { data, error } = await adminApi({
      action: "reading_force_full",
      organization_id: organizationId,
      source_id: sourceId,
      ignore_paid_caps: ignoreCaps,
    });
    setBusy(null);
    if (error) toast.error(error);
    else toast.success(`Queued ${Number(data?.["queued"] ?? 0)} website read(s). The worker starts within a minute.`);
    await load();
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <Globe className="h-4 w-4" aria-hidden="true" />
            Website reading
          </h3>
          <p className="text-xs text-muted-foreground">
            Force full read skips the trial gate and the re-read cooldown. Monthly Tavily/Firecrawl caps always apply.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ignoreCaps} onChange={(e) => setIgnoreCaps(e.target.checked)} />
            Ignore the plan's paid-page limit
          </label>
          <Button size="sm" variant="outline" disabled={busy !== null || !sources?.length} onClick={() => void force(null)}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {busy === "all" ? "Queuing…" : "Force full read"}
          </Button>
        </div>
      </div>

      {sources === null ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No website added in this workspace.</p>
      ) : (
        <ul className="space-y-2">
          {sources.map((s) => {
            const rows = log.filter((r) => r.source_id === s.id || (r.action === "reading_force_full" && !r.source_id));
            return (
              <li key={s.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {s.name} {s.deleted ? <span className="text-xs text-muted-foreground">(deleted)</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.status}
                      {s.resume ? " · continues" : ""} · {s.mode ?? "day0"} · {s.discovery} · {s.pages_seen ?? 0} pages · {s.item_count ?? 0} saved ·{" "}
                      {s.products_found ?? 0} products · {s.paid_pages} paid pages · last read {when(s.last_synced_at)} · full read{" "}
                      {when(s.last_full_read_at)}
                    </p>
                    {s.read_cost?.runs ? (
                      <p className="text-xs text-muted-foreground">
                        Read cost ₹{s.read_cost.total} over {s.read_cost.runs} logged run{s.read_cost.runs === 1 ? "" : "s"} · reader ₹{s.read_cost.reader} ·
                        facts ₹{s.read_cost.facts} · embeddings ₹{s.read_cost.embeddings}
                      </p>
                    ) : null}
                    {s.last_error ? <p className="text-xs text-destructive">{s.last_error}</p> : null}
                    {s.swap_blocked?.reasons?.length ? (
                      <p className="text-xs text-amber-600">Kept the live version: {s.swap_blocked.reasons.join("; ")}</p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>
                      {open === s.id ? "Hide log" : `Read log (${rows.length})`}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null || s.deleted || s.status === "syncing"} onClick={() => void force(s.id)}>
                      {busy === s.id ? "Queuing…" : "Force full read"}
                    </Button>
                  </div>
                </div>
                {open === s.id ? (
                  rows.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">No runs logged yet.</p>
                  ) : (
                    <ol className="mt-2 max-h-72 space-y-1 overflow-auto text-xs">
                      {rows.map((r, i) => (
                        <li key={`${r.at}-${i}`} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">{when(r.at)}</span>
                          <span className={r.action === "reading_run" ? "" : "text-amber-700"}>{logLine(r)}</span>
                        </li>
                      ))}
                    </ol>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
