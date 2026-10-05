import { useEffect, useState } from "react";
import { Download, MessageCircle, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination, TableSkeleton } from "@/components/data-pagination";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import {
  RESPONSE_STATUS_LABELS,
  rangeBounds,
  type ResponseRow,
  type ResponseStatus,
  type ResponsesRange,
  type ResponsesSummary,
} from "@/lib/flow-responses";

type Column = { key: string; label: string; kind: "variable" | "field" };
type Page = { columns: Column[]; rows: ResponseRow[]; total: number; page_size: number; summary: ResponsesSummary | null };

const STATUS_STYLE: Record<ResponseStatus, string> = {
  finished: "bg-primary/10 text-primary",
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

const selectCls = "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** Every customer's answers to this flow — one row per run, newest first. */
export function ResponsesPanel({ organizationId, flowId, canExport }: { organizationId: string; flowId: string; canExport: boolean }) {
  const [range, setRange] = useState<ResponsesRange>("30d");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [status, setStatus] = useState<ResponseStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [paged, setPaged] = useState({ key: "", page: 0 });
  const [data, setData] = useState<Page | null>(null);
  const [summary, setSummary] = useState<ResponsesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const bounds = rangeBounds(range, custom);
  const filters = { from: bounds.from, to: bounds.to, status, search: debounced || null };
  const filterKey = JSON.stringify(filters);
  // Any filter change starts again from the first page.
  const page = paged.key === filterKey ? paged.page : 0;

  useEffect(() => {
    let live = true;
    setError(null);
    void callApi<Page>("/api/flows/responses", {
      body: { action: "list", organization_id: organizationId, flow_id: flowId, filters, page, summary: page === 0 },
    }).then(({ data: out, error: err }) => {
      if (!live) return;
      if (err || !out) { setError(err ?? "Couldn't load the responses."); return; }
      setData(out);
      if (out.summary) setSummary(out.summary);
    });
    return () => { live = false; };
    // filterKey stands in for the filters object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, flowId, filterKey, page]);

  const download = async () => {
    setDownloading(true);
    try {
      const { data: s } = await aidwar.auth.getSession();
      const token = s.session?.access_token;
      if (!token) { toast.error("Your session expired. Please sign in again."); return; }
      const res = await fetch("/api/flows/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "export", organization_id: organizationId, flow_id: flowId, filters }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? "Couldn't download the responses.");
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "flow-responses.csv";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      if (res.headers.get("x-truncated") === "1") toast.message(`Downloaded the newest ${res.headers.get("x-rows")} rows — narrow the dates for the rest.`);
    } finally {
      setDownloading(false);
    }
  };

  const columns = data?.columns ?? [];
  return (
    <div className="space-y-4 p-4">
      {summary && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Runs started" value={summary.started.toLocaleString("en-IN")} />
            <Stat label="Finished" value={summary.finished.toLocaleString("en-IN")} />
            <Stat label="Completion rate" value={`${summary.completion_rate}%`} />
          </div>
          {summary.drop_off.length > 0 && (
            <div className="rounded-xl border border-border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Drop-off by question</p>
              <ul className="flex flex-wrap gap-2">
                {summary.drop_off.map((d) => (
                  <li key={d.node_id} className="rounded-full bg-muted px-3 py-1 text-xs">
                    <span className="font-medium">{d.label}</span>
                    <span className="ml-1 text-muted-foreground">
                      {d.count} stopped here{summary.started ? ` (${Math.round((d.count / summary.started) * 100)}%)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Date range" className={selectCls} value={range} onChange={(e) => setRange(e.target.value as ResponsesRange)}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="custom">Custom dates</option>
        </select>
        {range === "custom" && (<>
          <Input aria-label="From date" type="date" className="h-9 w-40" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          <span className="text-sm text-muted-foreground">to</span>
          <Input aria-label="To date" type="date" className="h-9 w-40" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
        </>)}
        <select aria-label="Status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as ResponseStatus | "all")}>
          <option value="all">All statuses</option>
          {(Object.keys(RESPONSE_STATUS_LABELS) as ResponseStatus[]).map((s) => <option key={s} value={s}>{RESPONSE_STATUS_LABELS[s]}</option>)}
        </select>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="h-9 pl-8" placeholder="Search name, phone or answers" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {canExport && (
          <Button size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
            <Download className="mr-1 h-4 w-4" /> {downloading ? "Preparing…" : "Download CSV"}
          </Button>
        )}
      </div>

      {error ? (
        <p className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">{error}</p>
      ) : !data ? (
        <TableSkeleton rows={5} />
      ) : data.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No responses match these filters yet.
        </p>
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                {columns.map((c) => <TableHead key={c.key} title={c.kind === "field" ? "Saved by an Update field step" : undefined}>{c.label}</TableHead>)}
                <TableHead className="w-10"><span className="sr-only">Chat</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => {
                const chat = r.conversation_id ? `/app/inbox?c=${r.conversation_id}` : null;
                return (
                  <TableRow key={r.run_id}>
                    <TableCell className="font-medium">
                      {chat ? <a href={chat} className="hover:underline">{r.name || "Unknown"}</a> : r.name || "Unknown"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{r.phone}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {new Date(r.started_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                      {r.version != null && <span className="ml-1 text-xs text-muted-foreground">v{r.version}</span>}
                    </TableCell>
                    <TableCell>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}>{RESPONSE_STATUS_LABELS[r.status]}</span>
                      {r.step && <span className="ml-1 text-xs text-muted-foreground">at {r.step}</span>}
                    </TableCell>
                    {columns.map((c) => <TableCell key={c.key} className="max-w-56 truncate" title={r.answers[c.key] ?? ""}>{r.answers[c.key] || <span className="text-muted-foreground">—</span>}</TableCell>)}
                    <TableCell>
                      {chat && <a href={chat} aria-label="Open the chat" title="Open the chat" className="text-muted-foreground hover:text-foreground"><MessageCircle className="h-4 w-4" /></a>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pagination page={page} pageSize={data.page_size} total={data.total} onPageChange={(p) => setPaged({ key: filterKey, page: p })} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-heading text-xl font-semibold">{value}</p>
    </div>
  );
}
