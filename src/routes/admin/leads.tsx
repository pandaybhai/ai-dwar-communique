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
  BUSINESS_TYPES,
  ENQUIRY_BANDS,
  LEAD_STATUSES,
  PRIMARY_NEEDS,
  labelFor,
  type LeadNote,
  type LeadRow,
  type LeadStatus,
} from "@/lib/leads";

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

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_CLASS: Record<LeadStatus, string> = {
  new: "bg-primary/10 text-primary",
  contacted: "bg-amber-50 text-amber-800",
  qualified: "bg-sky-50 text-sky-800",
  demo_booked: "bg-violet-50 text-violet-800",
  won: "bg-emerald-50 text-emerald-800",
  lost: "bg-muted text-muted-foreground",
};

function AdminLeads() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<LeadRow | null>(null);

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

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.leads ?? []).filter(
      (l) =>
        (status === "all" || l.status === status) &&
        (!needle ||
          l.name.toLowerCase().includes(needle) ||
          l.business_name.toLowerCase().includes(needle) ||
          l.phone.includes(needle)),
    );
  }, [data, status, search]);

  return (
    <>
      <PageHeader
        title="Leads &amp; Demos"
        description={DESCRIPTION}
        action={
          data ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-semibold text-primary">
              <Sparkles className="h-3.5 w-3.5" /> {data.new_count} new
            </span>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => void load()}>
          <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
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
        <ErrorState description={error} onRetry={() => void load()} />
      ) : !data?.leads.length ? (
        <EmptyState
          icon={MessageSquarePlus}
          title="No demo enquiries yet"
          description="When someone asks for a demo from the website, they land here."
        />
      ) : !visible.length ? (
        <NoResults onClear={() => { setSearch(""); setStatus("all"); }} />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Business</th>
                <th className="px-4 py-3 font-medium">Needs</th>
                <th className="px-4 py-3 font-medium">Enquiries/day</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Received</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((lead) => (
                <tr
                  key={lead.id}
                  tabIndex={0}
                  onClick={() => setOpen(lead)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpen(lead);
                    }
                  }}
                  className="cursor-pointer border-t border-border/70 transition-colors hover:bg-muted/40 focus:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">
                      {lead.business_name}
                      {lead.is_test ? (
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                          QA
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {lead.name} · {lead.phone}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {labelFor(PRIMARY_NEEDS, lead.primary_need)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{lead.enquiry_band}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium",
                        STATUS_CLASS[lead.status],
                      )}
                    >
                      {labelFor(LEAD_STATUSES, lead.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{when(lead.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LeadSheet
        lead={open}
        admins={data?.admins ?? []}
        onClose={() => setOpen(null)}
        onSaved={() => void load()}
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
  onSaved: () => void;
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
  }, [lead]);

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
    onSaved();
  }

  return (
    <Sheet open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-lg">
        {lead ? (
          <>
            <SheetTitle className="text-left">{lead.business_name}</SheetTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {lead.name} · {lead.phone}
              {lead.website ? (
                <>
                  {" · "}
                  <a
                    className="underline underline-offset-2"
                    href={lead.website}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    website
                  </a>
                </>
              ) : null}
            </p>

            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <Detail label="Business type" value={labelFor(BUSINESS_TYPES, lead.business_type)} />
              <Detail label="Enquiries a day" value={labelFor(ENQUIRY_BANDS, lead.enquiry_band)} />
              <Detail label="Main need" value={labelFor(PRIMARY_NEEDS, lead.primary_need)} />
              <Detail label="Received" value={when(lead.created_at)} />
              <Detail label="Page" value={lead.landing_path ?? "—"} />
              <Detail label="Came from" value={lead.referrer_host ?? "direct"} />
              <Detail
                label="Campaign"
                value={
                  [
                    lead.first_attribution?.["utm_source"],
                    lead.first_attribution?.["utm_medium"],
                    lead.first_attribution?.["utm_campaign"],
                  ]
                    .filter(Boolean)
                    .join(" / ") || "—"
                }
              />
              <Detail
                label="Permission"
                value={`Given ${when(lead.consent_at)} (v${lead.consent_version})`}
              />
              <Detail
                label="Workspace"
                value={lead.organization_id ? "Linked to a signed-up workspace" : "Not linked"}
              />
            </dl>

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
                      {n.author_name ?? "Admin"} · {when(n.created_at)}
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{value}</dd>
    </div>
  );
}
