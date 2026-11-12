import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquarePlus, RefreshCw, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, TableSkeleton } from "@/components/data-pagination";
import { callApi } from "@/lib/whatsapp-client";
import { cn } from "@/lib/utils";
import {
  LEAD_STATUSES,
  filterLeads,
  isStartLead,
  leadTime,
  leadTitle,
  type LeadNote,
  type LeadRow,
  type LeadStatus,
} from "@/lib/leads";
import { LeadSummary, LeadsTable, StartBadge } from "@/components/admin/lead-views";
import { CUSTOMERS, SELLS } from "@/lib/start-qualify";

const DESCRIPTION = "Demo enquiries from the website — who asked, what they need, and where they are.";

export const Route = createFileRoute("/admin/leads")({
  head: () => ({
    meta: [
      { title: "Leads & Demos — AiDwar Admin" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Leads & Demos — AiDwar Admin" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminLeads,
});

type Payload = {
  leads: LeadRow[];
  new_count: number;
  admins: Array<{ id: string; name: string }>;
};

function AdminLeads() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // The sheet always shows the freshest copy of the lead from the list.
  const open = useMemo(() => (data?.leads ?? []).find((l) => l.id === openId) ?? null, [data, openId]);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  // Batch 75: the /start answers ("all", a value, or "none" = skipped).
  const [sells, setSells] = useState("all");
  const [customers, setCustomers] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    const { data: res, error: err } = await callApi<Payload>("/api/admin/leads", { method: "GET" });
    setLoading(false);
    if (err || !res) {
      setError(err ?? "We couldn't load the enquiries.");
      return;
    }
    setError(null);
    setData(res);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const l of data?.leads ?? []) {
      c["all"] = (c["all"] ?? 0) + 1;
      c[l.status] = (c[l.status] ?? 0) + 1;
    }
    return c;
  }, [data]);

  const visible = useMemo(
    () => filterLeads(data?.leads ?? [], { status, search, unassignedOnly, sells, customers }),
    [data, status, search, unassignedOnly, sells, customers],
  );

  const unassignedNew = (data?.leads ?? []).filter((l) => l.status === "new" && !l.assigned_to).length;

  return (
    <>
      <PageHeader title="Leads & Demos" description={DESCRIPTION} />

      {data ? (
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-semibold text-primary">
          <Sparkles className="h-3.5 w-3.5" /> {data.new_count} new
        </span>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => void load()}>
          <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
        <Button
          variant={unassignedOnly ? "default" : "outline"}
          size="sm"
          className="rounded-full"
          aria-pressed={unassignedOnly}
          onClick={() => setUnassignedOnly((v) => !v)}
        >
          New &amp; unassigned ({unassignedNew})
        </Button>
        <Tabs value={status} onValueChange={(v) => setStatus(v as LeadStatus | "all")}>
          <TabsList>
            <TabsTrigger value="all">All ({counts["all"] ?? 0})</TabsTrigger>
            {LEAD_STATUSES.map((s) => (
              <TabsTrigger key={s.value} value={s.value}>
                {s.label} ({counts[s.value] ?? 0})
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <AnswerFilter
          label="Sells"
          value={sells}
          onChange={setSells}
          options={SELLS}
          testId="filter-sells"
        />
        <AnswerFilter
          label="Customers"
          value={customers}
          onChange={setCustomers}
          options={CUSTOMERS}
          testId="filter-customers"
        />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, business or number"
            className="pl-9"
            aria-label="Search enquiries"
          />
        </div>
      </div>

      {loading && !data ? (
        <TableSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} />
      ) : !data?.leads.length ? (
        <EmptyState
          icon={MessageSquarePlus}
          title="No demo enquiries yet"
          description="When someone asks for a demo from the website, they land here."
        />
      ) : !visible.length ? (
        <NoResults message="No enquiries match this filter." />
      ) : (
        <LeadsTable leads={visible} onOpen={setOpenId} />
      )}

      <LeadSheet
        lead={open}
        admins={data?.admins ?? []}
        onClose={() => setOpenId(null)}
        onSaved={(id, changes) => {
          // Show the change at once, then confirm it with a fresh read.
          setData((d) => (d ? { ...d, leads: d.leads.map((l) => (l.id === id ? { ...l, ...changes } : l)) } : d));
          void load();
        }}
      />
    </>
  );
}

function LeadSheet({
  lead,
  admins,
  onClose,
  onSaved,
}: {
  lead: LeadRow | null;
  admins: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (id: string, changes: Partial<LeadRow>) => void;
}) {
  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!lead) return;
    setNote("");
    setErr(null);
    void (async () => {
      const { data } = await callApi<{ notes: LeadNote[] }>(
        `/api/admin/leads?lead_id=${lead.id}`,
        { method: "GET" },
      );
      setNotes(data?.notes ?? []);
    })();
  }, [lead?.id]);

  async function patch(body: Record<string, unknown>) {
    if (!lead) return;
    setSaving(true);
    const { error } = await callApi("/api/admin/leads", {
      method: "POST",
      body: { lead_id: lead.id, ...body },
    });
    setSaving(false);
    if (error) {
      setErr(error);
      return;
    }
    setErr(null);
    onSaved(lead.id, body as Partial<LeadRow>);
  }

  return (
    <Sheet open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-lg">
        {lead ? (
          <>
            <SheetTitle className="text-left">
              {leadTitle(lead)}
              {isStartLead(lead) ? <StartBadge /> : null}
            </SheetTitle>
            <LeadSummary lead={lead} />

            <div className="mt-6 grid gap-4">
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Status</span>
                <select
                  className="h-10 rounded-xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  value={lead.status}
                  onChange={(e) => void patch({ status: e.target.value })}
                >
                  {LEAD_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Assigned to</span>
                <select
                  className="h-10 rounded-xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  value={lead.assigned_to ?? ""}
                  onChange={(e) => void patch({ assigned_to: e.target.value || null })}
                >
                  <option value="">Nobody yet</option>
                  {admins.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Demo date (optional)</span>
                <Input
                  type="datetime-local"
                  defaultValue={lead.demo_at ? lead.demo_at.slice(0, 16) : ""}
                  onBlur={(e) =>
                    void patch({
                      demo_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                    })
                  }
                />
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Next follow-up (optional)</span>
                <Input
                  type="datetime-local"
                  defaultValue={lead.next_follow_up_at ? lead.next_follow_up_at.slice(0, 16) : ""}
                  onBlur={(e) =>
                    void patch({
                      next_follow_up_at: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : null,
                    })
                  }
                />
              </label>

              <div className="grid gap-1.5 text-sm">
                <span className="font-medium">Demo attended</span>
                {lead.demo_attended_at ? (
                  <div className="flex items-center gap-3">
                    <p className="text-muted-foreground">
                      Attended {leadTime(lead.demo_attended_at)}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      disabled={saving}
                      onClick={() => void patch({ demo_attended_at: null })}
                    >
                      Undo
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit rounded-full"
                    disabled={saving}
                    onClick={() => void patch({ demo_attended_at: new Date().toISOString() })}
                  >
                    Mark demo attended
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-6">
              <p className="text-sm font-medium">Notes</p>
              <Textarea
                className="mt-2"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What happened on the call?"
              />
              <Button
                size="sm"
                className="mt-2 rounded-full"
                disabled={saving || !note.trim()}
                onClick={async () => {
                  await patch({ note });
                  setNote("");
                  const { data } = await callApi<{ notes: LeadNote[] }>(
                    `/api/admin/leads?lead_id=${lead.id}`,
                    { method: "GET" },
                  );
                  setNotes(data?.notes ?? []);
                }}
              >
                Add note
              </Button>

              <ul className="mt-4 space-y-3">
                {notes.map((n) => (
                  <li key={n.id} className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {n.author_name ?? "Admin"} · {leadTime(n.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            {err ? <p className="mt-4 text-sm text-destructive">{err}</p> : null}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Batch 75: filter by a /start answer — any, one value, or skipped. */
function AnswerFilter({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  testId: string;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="h-9 rounded-full border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <option value="all">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="none">— (skipped)</option>
      </select>
    </label>
  );
}
