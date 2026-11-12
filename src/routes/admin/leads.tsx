import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  BellRing,
  Download,
  MessageCircle,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, TableSkeleton } from "@/components/data-pagination";
import { callApi } from "@/lib/whatsapp-client";
import { aidwar } from "@/integrations/aidwar/client";
import { cn } from "@/lib/utils";
import {
  LEAD_STATUSES,
  filterLeads,
  leadWhatsAppLink,
  isStartLead,
  leadTime,
  leadTitle,
  type LeadNote,
  type LeadRow,
  type LeadStatus,
} from "@/lib/leads";
import { LeadSummary, LeadsTable, StartBadge } from "@/components/admin/lead-views";
import { CUSTOMERS, SELLS } from "@/lib/start-qualify";

const DESCRIPTION =
  "Demo enquiries from the website — who asked, what they need, and where they are.";

export const Route = createFileRoute("/admin/leads")({
  // Batch 76: ?lead=<id> opens that lead (the new-lead alert's "Open lead" button).
  validateSearch: (search: Record<string, unknown>): { lead?: string } =>
    typeof search["lead"] === "string" ? { lead: search["lead"].slice(0, 64) } : {},
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
  /** Batch 76: what the caller may do here — "sales" works leads; only "super_admin" exports or edits alerts. */
  role?: "super_admin" | "sales";
  me?: string;
  alert_numbers?: string[] | null;
};

function AdminLeads() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // The sheet always shows the freshest copy of the lead from the list.
  const open = useMemo(
    () => (data?.leads ?? []).find((l) => l.id === openId) ?? null,
    [data, openId],
  );
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  // Batch 75: the /start answers ("all", a value, or "none" = skipped).
  const [sells, setSells] = useState("all");
  const [customers, setCustomers] = useState("all");
  // Batch 76: where the lead came from, and whether the reminder went.
  const [source, setSource] = useState("all");
  const [reminded, setReminded] = useState("all");
  const { lead: linkedLead } = Route.useSearch();

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

  // Batch 76: the alert's "Open lead" link opens that lead once the list is in.
  useEffect(() => {
    if (linkedLead && data?.leads.some((l) => l.id === linkedLead)) setOpenId(linkedLead);
  }, [linkedLead, data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const l of data?.leads ?? []) {
      c["all"] = (c["all"] ?? 0) + 1;
      c[l.status] = (c[l.status] ?? 0) + 1;
    }
    return c;
  }, [data]);

  const visible = useMemo(
    () =>
      filterLeads(data?.leads ?? [], {
        status,
        search,
        unassignedOnly,
        sells,
        customers,
        source,
        reminded,
      }),
    [data, status, search, unassignedOnly, sells, customers, source, reminded],
  );

  // Batch 76: super admin only (the server refuses everyone else).
  async function exportCsv() {
    const { data: session } = await aidwar.auth.getSession();
    const token = session.session?.access_token;
    if (!token) return;
    const res = await fetch("/api/admin/leads?format=csv", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "aidwar-leads.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const unassignedNew = (data?.leads ?? []).filter(
    (l) => l.status === "new" && !l.assigned_to,
  ).length;

  return (
    <>
      <PageHeader title="Leads & Demos" description={DESCRIPTION} />
      {data?.role === "super_admin" ? (
        <LeadAlertNumbers
          numbers={data.alert_numbers ?? []}
          onSaved={(alert_numbers) => setData((d) => (d ? { ...d, alert_numbers } : d))}
        />
      ) : null}

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
        <PlainFilter
          label="Source"
          value={source}
          onChange={setSource}
          testId="filter-source"
          options={[
            { value: "landing_start", label: "/start" },
            { value: "landing", label: "/demo" },
          ]}
        />
        <PlainFilter
          label="Reminded"
          value={reminded}
          onChange={setReminded}
          testId="filter-reminded"
          options={[
            { value: "yes", label: "Reminded" },
            { value: "no", label: "Not reminded" },
          ]}
        />
        {data?.role === "super_admin" ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            data-testid="export-csv"
            onClick={() => void exportCsv()}
          >
            <Download className="mr-2 h-3.5 w-3.5" /> Export CSV
          </Button>
        ) : null}
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
        role={data?.role ?? "super_admin"}
        me={data?.me ?? ""}
        onClose={() => setOpenId(null)}
        onSaved={(id, changes) => {
          // Show the change at once, then confirm it with a fresh read.
          setData((d) =>
            d ? { ...d, leads: d.leads.map((l) => (l.id === id ? { ...l, ...changes } : l)) } : d,
          );
          void load();
        }}
      />
    </>
  );
}

function LeadSheet({
  lead,
  admins,
  role,
  me,
  onClose,
  onSaved,
}: {
  lead: LeadRow | null;
  admins: Array<{ id: string; name: string }>;
  role: "super_admin" | "sales";
  me: string;
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
      const { data } = await callApi<{ notes: LeadNote[] }>(`/api/admin/leads?lead_id=${lead.id}`, {
        method: "GET",
      });
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
            {leadWhatsAppLink(lead.phone) ? (
              <Button
                asChild
                size="sm"
                className="mt-4 rounded-full bg-success text-success-foreground hover:bg-success/90"
              >
                <a
                  href={leadWhatsAppLink(lead.phone)!}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="lead-whatsapp"
                >
                  <MessageCircle className="mr-1.5 h-4 w-4" /> WhatsApp
                </a>
              </Button>
            ) : null}

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

              {role === "sales" ? (
                <div className="grid gap-1.5 text-sm" data-testid="assign-self">
                  <span className="font-medium">Assigned to</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">
                      {lead.assigned_to
                        ? lead.assigned_to === me
                          ? "You"
                          : (admins.find((a) => a.id === lead.assigned_to)?.name ?? "Someone else")
                        : "Nobody yet"}
                    </span>
                    {lead.assigned_to === me ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        disabled={saving}
                        onClick={() => void patch({ assigned_to: null })}
                      >
                        Unassign
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="rounded-full"
                        disabled={saving}
                        onClick={() => void patch({ assigned_to: me })}
                      >
                        Assign to me
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
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
              )}

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
                  <li
                    key={n.id}
                    className="rounded-xl border border-border bg-muted/30 p-3 text-sm"
                  >
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

/** Batch 76: a small "any / one value" filter (source, reminded). */
function PlainFilter({
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
      </select>
    </label>
  );
}

/**
 * Batch 76 (super admin only): who gets a WhatsApp alert from AiDwar's number
 * for every new lead. One number per line; +91 is added to a 10-digit number.
 */
function LeadAlertNumbers({
  numbers,
  onSaved,
}: {
  numbers: string[];
  onSaved: (numbers: string[]) => void;
}) {
  const [text, setText] = useState(numbers.join("\n"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setText(numbers.join("\n")), [numbers]);
  async function save() {
    setBusy(true);
    setMsg(null);
    const list = text
      .split(/[\n,]+/)
      .map((n) => n.trim())
      .filter(Boolean);
    const { data, error } = await callApi<{ alert_numbers: string[] }>("/api/admin/leads", {
      method: "POST",
      body: { action: "alert_numbers", numbers: list },
    });
    setBusy(false);
    if (error || !data) {
      setMsg({ ok: false, text: error ?? "We couldn't save that." });
      return;
    }
    onSaved(data.alert_numbers);
    setMsg({ ok: true, text: "Saved." });
  }
  return (
    <section
      className="mb-5 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"
      aria-labelledby="alert-numbers"
      data-testid="alert-numbers"
    >
      <h2 id="alert-numbers" className="flex items-center gap-2 text-base font-semibold">
        <BellRing className="h-4 w-4 text-primary" /> New-lead WhatsApp alerts
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every new lead is sent to these numbers from AiDwar&apos;s WhatsApp number. One per line.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          className="max-w-sm font-mono text-sm"
          aria-label="Alert numbers"
          placeholder="+91 98123 45670"
        />
        <Button
          size="sm"
          className="w-fit rounded-full"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      {msg ? (
        <p
          className={cn("mt-2 text-xs", msg.ok ? "text-muted-foreground" : "text-destructive")}
          role="status"
        >
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
