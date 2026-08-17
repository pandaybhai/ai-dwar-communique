import { PermissionGate } from "@/components/permission-gate";
import { permissionDeniedReason } from "@/lib/permissions";
import { usePermissions } from "@/hooks/use-permissions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Contact as ContactIcon, Download, Search } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { downloadCsv, toCsv } from "@/lib/csv";
import { logActivity } from "@/lib/activity";

import {
  OPT_IN_CLASSES,
  OPT_IN_LABELS,
  contactInitials,
  formatDate,
  sourceClass,
  sourceLabel,
  type ContactRow,
  type OptInStatus,
  type TagRow,
} from "@/lib/contacts";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { callApi } from "@/lib/whatsapp-client";
import type { SegmentRow } from "@/lib/segments";
import { AddContactDialog } from "@/components/contacts/add-contact-dialog";
import { ImportContactsDialog } from "@/components/contacts/import-contacts-dialog";
import { ContactDrawer } from "@/components/contacts/contact-drawer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 25;

export function ContactsView({
  organizationId,
  role,
  showHeader = true,
  initialOptIn,
}: {
  organizationId: string;
  role: string | null;
  showHeader?: boolean;
  /** Deep link from the flows reachability warning, e.g. ?opt_in=unknown. */
  initialOptIn?: string;
}) {
  const { can } = usePermissions();
  const canEdit = can("contacts.edit");
  const canImport = can("contacts.import");
  const canExport = can("contacts.export");
  const canDeleteContacts = can("contacts.delete");
  void role;

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [optInFilter, setOptInFilter] = useState(initialOptIn || "all");
  const [segmentFilter, setSegmentFilter] = useState("all");
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [page, setPage] = useState(0);

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ContactRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [breakdown, setBreakdown] = useState<{ source: string; contacts: number }[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadTags = useCallback(async () => {
    const { data } = await aidwar
      .from("tags")
      .select("id, name, color")
      .eq("organization_id", organizationId)
      .order("name");
    setAllTags((data as TagRow[]) ?? []);
  }, [organizationId]);

  const loadBreakdown = useCallback(async () => {
    const { data } = await aidwar.rpc("contacts_source_breakdown", {
      p_organization_id: organizationId,
    });
    setBreakdown((data as { source: string; contacts: number }[]) ?? []);
  }, [organizationId]);

  const loadSegments = useCallback(async () => {
    const { data } = await aidwar
      .from("segments")
      .select("id, name, description, filters, created_by, created_at")
      .eq("organization_id", organizationId)
      .order("name");
    setSegments((data as SegmentRow[]) ?? []);
  }, [organizationId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    let contactIdsForSegment: string[] | null = null;
    if (segmentFilter !== "all") {
      const segment = segments.find((s) => s.id === segmentFilter);
      const { data: res } = await callApi<{ ids: string[] }>("/api/contacts/evaluate-segment", {
        body: { organization_id: organizationId, mode: "ids", filters: segment?.filters ?? {} },
      });
      contactIdsForSegment = res?.ids ?? [];
      if (contactIdsForSegment.length === 0) {
        setContacts([]);
        setTotal(0);
        setLoading(false);
        return;
      }
    }

    let contactIdsForTag: string[] | null = null;
    if (tagFilter !== "all") {
      const { data: links } = await aidwar
        .from("contact_tags")
        .select("contact_id")
        .eq("organization_id", organizationId)
        .eq("tag_id", tagFilter);
      contactIdsForTag = ((links as { contact_id: string }[]) ?? []).map((l) => l.contact_id);
      if (contactIdsForTag.length === 0) {
        setContacts([]);
        setTotal(0);
        setLoading(false);
        return;
      }
    }

    let query = aidwar
      .from("contacts")
      .select("id, name, phone, wa_id, opt_in_status, attributes, source, source_detail, created_at", { count: "exact" })
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (debounced) query = query.or(`name.ilike.%${debounced}%,phone.ilike.%${debounced}%`);
    if (optInFilter !== "all") query = query.eq("opt_in_status", optInFilter);
    if (contactIdsForTag) query = query.in("id", contactIdsForTag);
    if (contactIdsForSegment) query = query.in("id", contactIdsForSegment.slice(0, 5000));

    const { data, count, error: qErr } = await query;
    if (qErr) {
      setError("We couldn't load your contacts. Please try again.");
      setLoading(false);
      return;
    }

    const base = (data ?? []) as Omit<ContactRow, "tags">[];
    let withTags: ContactRow[] = base.map((c) => ({ ...c, tags: [] }));
    if (base.length) {
      const { data: links } = await aidwar
        .from("contact_tags")
        .select("contact_id, tags(id, name, color)")
        .eq("organization_id", organizationId)
        .in(
          "contact_id",
          base.map((c) => c.id),
        );
      const map = new Map<string, TagRow[]>();
      for (const link of ((links as unknown as { contact_id: string; tags: TagRow | null }[]) ?? [])) {
        if (!link.tags) continue;
        const list = map.get(link.contact_id) ?? [];
        list.push(link.tags);
        map.set(link.contact_id, list);
      }
      withTags = base.map((c) => ({ ...c, tags: map.get(c.id) ?? [] }));
    }

    setContacts(withTags);
    setTotal(count ?? 0);
    setLoading(false);
  }, [organizationId, page, debounced, optInFilter, tagFilter, segmentFilter, segments]);

  useEffect(() => {
    void loadTags();
    void loadSegments();
    void loadBreakdown();
  }, [loadTags, loadSegments, loadBreakdown]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    const fresh = contacts.find((c) => c.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [contacts, selected]);

  const hasFilters = useMemo(
    () =>
      Boolean(debounced) || tagFilter !== "all" || optInFilter !== "all" || segmentFilter !== "all",
    [debounced, tagFilter, optInFilter, segmentFilter],
  );

  async function exportCsv() {
    setExporting(true);
    let query = aidwar
      .from("contacts")
      .select("name, phone, opt_in_status, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(10000);
    if (debounced) query = query.or(`name.ilike.%${debounced}%,phone.ilike.%${debounced}%`);
    if (optInFilter !== "all") query = query.eq("opt_in_status", optInFilter);
    const { data, error: expErr } = await query;
    setExporting(false);
    if (expErr) {
      toast.error("We couldn't export your contacts.");
      return;
    }
    const rows = (data ?? []) as {
      name: string | null;
      phone: string;
      opt_in_status: string;
      created_at: string;
    }[];
    downloadCsv(
      `contacts-${Date.now()}.csv`,
      toCsv([
        ["name", "phone", "opt_in_status", "created_at"],
        ...rows.map((r) => [r.name ?? "", r.phone, r.opt_in_status, r.created_at]),
      ]),
    );
    // Bulk exports are logged; reading a single contact is not.
    void logActivity("contacts_exported", organizationId, {
      row_count: rows.length,
      filters: {
        search: debounced || null,
        tag: tagFilter,
        opt_in: optInFilter,
        segment: segmentFilter,
      },
    });
  }


  return (
    <>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {showHeader ? (
          <PageHeader
            title="Contacts"
            description="Your customer list with tags and smart segments, so every campaign reaches exactly the right people."
          />
        ) : (
          <p className="mb-8 text-sm text-muted-foreground">
            Search, filter and tag every customer — or narrow the list down to a saved segment.
          </p>
        )}
        <div className="mb-8 flex flex-wrap items-center gap-2">
          {canExport ? (
            <Button
              variant="ghost"
              className="rounded-full"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              <Download className="mr-2 h-4 w-4" />
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          ) : null}
          <PermissionGate allowed={canImport} reason={permissionDeniedReason("Import contacts")}>
            <ImportContactsDialog organizationId={organizationId} onImported={() => void load()} />
          </PermissionGate>
          <PermissionGate allowed={canEdit} reason={permissionDeniedReason("Edit contacts")}>
            <AddContactDialog
              organizationId={organizationId}
              onCreated={() => {
                setPage(0);
                void load();
              }}
            />
          </PermissionGate>
        </div>
      </div>

      <SourceBreakdownCard rows={breakdown} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone"
            className="pl-9"
            aria-label="Search contacts"
          />
        </div>
        <Select
          value={tagFilter}
          onValueChange={(v) => {
            setTagFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="All tags" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tags</SelectItem>
            {allTags.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={optInFilter}
          onValueChange={(v) => {
            setOptInFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(Object.keys(OPT_IN_LABELS) as OptInStatus[]).map((k) => (
              <SelectItem key={k} value={k}>
                {OPT_IN_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {segments.length ? (
          <Select
            value={segmentFilter}
            onValueChange={(v) => {
              setSegmentFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="sm:w-52">
              <SelectValue placeholder="All contacts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All contacts</SelectItem>
              {segments.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <TableSkeleton rows={8} />
      ) : total === 0 && !hasFilters ? (
        <EmptyState
          icon={ContactIcon}
          title="No contacts yet"
          description="Import your customers to start reaching them, or add your first contact by hand."
          action={
            <AddContactDialog
              organizationId={organizationId}
              onCreated={() => {
                setPage(0);
                void load();
              }}
            />
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          {contacts.length === 0 ? (
            <NoResults message="No contacts match these filters." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Opt-in</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contacts.map((c) => (
                    <TableRow
                      key={c.id}
                      onClick={() => setSelected(c)}
                      className="cursor-pointer transition-colors duration-150"
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 text-xs font-semibold text-primary">
                            {contactInitials(c)}
                          </div>
                          <span className="font-medium text-foreground">
                            {c.name || "Unnamed contact"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {c.phone}
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-[220px] flex-wrap gap-1">
                          {c.tags.length ? (
                            c.tags.map((t) => (
                              <span
                                key={t.id}
                                className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                                style={{
                                  borderColor: `${t.color}55`,
                                  backgroundColor: `${t.color}18`,
                                  color: t.color,
                                }}
                              >
                                {t.name}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${sourceClass(c.source)}`}
                        >
                          {sourceLabel(c.source)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${OPT_IN_CLASSES[c.opt_in_status]}`}
                        >
                          {OPT_IN_LABELS[c.opt_in_status]}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                        {formatDate(c.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </div>
      )}

      <ContactDrawer
        contact={selected}
        organizationId={organizationId}
        allTags={allTags}
        canDelete={canDeleteContacts}
        onClose={() => setSelected(null)}
        onChanged={() => {
          void loadTags();
          void loadBreakdown();
          void load();
        }}
      />
    </>
  );
}

function SourceBreakdownCard({ rows }: { rows: { source: string; contacts: number }[] | null }) {
  if (rows === null) {
    return <div className="mb-4 h-24 animate-pulse rounded-2xl border border-border/70 bg-muted/40" />;
  }
  if (!rows.length) return null;
  const total = rows.reduce((sum, r) => sum + Number(r.contacts), 0) || 1;
  return (
    <div className="mb-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <p className="text-sm font-semibold text-foreground">Where your contacts come from</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => {
          const pct = Math.round((Number(r.contacts) / total) * 100);
          return (
            <div key={r.source} className="rounded-xl border border-border/60 bg-background/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${sourceClass(r.source)}`}
                >
                  {sourceLabel(r.source)}
                </span>
                <span className="text-lg font-semibold text-foreground">{r.contacts}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{pct}% of contacts</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
