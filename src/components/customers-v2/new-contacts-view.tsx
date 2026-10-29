import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCheck, Contact as ContactIcon, Download, Search, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import { downloadCsv, toCsv } from "@/lib/csv";
import { logActivity } from "@/lib/activity";
import { callApi } from "@/lib/whatsapp-client";
import { permissionDeniedReason } from "@/lib/permissions";
import { sourceLabel, type ContactRow, type OptInStatus, type TagRow } from "@/lib/contacts";
import type { SegmentRow } from "@/lib/segments";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { PermissionGate } from "@/components/permission-gate";
import { AddContactDialog } from "@/components/contacts/add-contact-dialog";
import { ContactDrawer } from "@/components/contacts/contact-drawer";
import {
  MarkAllUnknownOptedIn,
  bulkOptInSummary,
  type BulkOptInResult,
} from "@/components/contacts/bulk-opt-in";
import { ToneAvatar } from "@/components/inbox/v2/chat-list";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CustomerSummary } from "./customer-summary";
import { GuidedImportDialog } from "./import-guided";
import {
  BOUGHT_DAYS,
  OPT_IN_CHIP,
  boughtSince,
  clearFilter,
  filterChips,
  hasFilters as anyFilters,
  initialFilters,
  lastChatLabel,
  latestChatByContact,
  selectedLabel,
  spentByContact,
  spentLabel,
  tagLinks,
  type CustomerFilters,
  type OrderLite,
} from "./customers-v2";

const PAGE_SIZE = 25;

/** True while a media query matches (false on the server). */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setOn(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return on;
}

const chipClass =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-ground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden";

function OptInChip({ status }: { status: OptInStatus }) {
  const chip = OPT_IN_CHIP[status];
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold",
        chip.className,
      )}
    >
      {chip.label}
    </span>
  );
}

function TagChips({ tags }: { tags: TagRow[] }) {
  if (!tags.length) return <span className="text-sm text-muted-foreground">No tags</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span
          key={t.id}
          className="rounded-full bg-aiden-soft px-2.5 py-1 text-[0.8125rem] font-semibold text-aiden-deep"
        >
          {t.name}
        </span>
      ))}
    </span>
  );
}

/**
 * Batch 48: Customers → Contacts in the new design (docs/design/preview.html
 * #customers). The classic ContactsView's reads, filters and writes: the same
 * contacts / contact_tags / segment queries, Batch 36's /api/contacts/opt-in,
 * the classic add, import (src/lib/contact-import.ts) and drawer. New here
 * are only reads: each customer's newest chat and, with integrations.view,
 * what they spent in the synced shop orders.
 */
export function NewContactsView({
  organizationId,
  initialOptIn,
}: {
  organizationId: string;
  initialOptIn?: string | undefined;
}) {
  const { can } = usePermissions();
  const canEdit = can("contacts.edit");
  const canImport = can("contacts.import");
  const canExport = can("contacts.export");
  const canDeleteContacts = can("contacts.delete");
  const canSeeOrders = can("integrations.view");
  const isPhone = useMedia("(max-width: 700px)");

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filters, setFilters] = useState<CustomerFilters>(() => initialFilters(initialOptIn));
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
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** The shop's orders exist (and can be read): the Spent column and the bought filter show. */
  const [hasOrders, setHasOrders] = useState(false);
  const [lastChat, setLastChat] = useState<Record<string, string>>({});
  const [spent, setSpent] = useState<Record<string, Record<string, number>>>({});

  useEffect(() => {
    setChecked(new Set());
  }, [debounced, filters]);

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

  useEffect(() => {
    if (!canSeeOrders) return setHasOrders(false);
    let live = true;
    void Promise.resolve(
      aidwar
        .from("orders")
        .select("id")
        .eq("organization_id", organizationId)
        .not("contact_id", "is", null)
        .limit(1),
    )
      .then(
        ({ data, error: e }) => live && setHasOrders(!e && Array.isArray(data) && data.length > 0),
      )
      .catch(() => live && setHasOrders(false));
    return () => {
      live = false;
    };
  }, [organizationId, canSeeOrders]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const empty = () => {
      setContacts([]);
      setTotal(0);
      setLoading(false);
    };

    let contactIdsForSegment: string[] | null = null;
    if (filters.segmentId !== "all") {
      const segment = segments.find((s) => s.id === filters.segmentId);
      const { data: res } = await callApi<{ ids: string[] }>("/api/contacts/evaluate-segment", {
        body: { organization_id: organizationId, mode: "ids", filters: segment?.filters ?? {} },
      });
      contactIdsForSegment = res?.ids ?? [];
      if (contactIdsForSegment.length === 0) return empty();
    }

    let contactIdsForTag: string[] | null = null;
    if (filters.tagId !== "all") {
      const { data: links } = await aidwar
        .from("contact_tags")
        .select("contact_id")
        .eq("organization_id", organizationId)
        .eq("tag_id", filters.tagId);
      contactIdsForTag = ((links as { contact_id: string }[]) ?? []).map((l) => l.contact_id);
      if (contactIdsForTag.length === 0) return empty();
    }

    // Batch 48: "Bought in the last N days" — contacts with a synced shop order since then.
    let contactIdsForBought: string[] | null = null;
    if (filters.boughtDays) {
      const { data: rows } = await aidwar
        .from("orders")
        .select("contact_id")
        .eq("organization_id", organizationId)
        .not("contact_id", "is", null)
        .gte("placed_at", boughtSince(filters.boughtDays))
        .limit(5000);
      contactIdsForBought = Array.from(
        new Set(((rows as { contact_id: string }[]) ?? []).map((r) => r.contact_id)),
      );
      if (contactIdsForBought.length === 0) return empty();
    }

    let query = aidwar
      .from("contacts")
      .select(
        "id, name, phone, wa_id, opt_in_status, attributes, source, source_detail, created_at",
        {
          count: "exact",
        },
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (debounced) query = query.or(`name.ilike.%${debounced}%,phone.ilike.%${debounced}%`);
    if (filters.optIn !== "all") query = query.eq("opt_in_status", filters.optIn);
    if (contactIdsForTag) query = query.in("id", contactIdsForTag);
    if (contactIdsForSegment) query = query.in("id", contactIdsForSegment.slice(0, 5000));
    if (contactIdsForBought) query = query.in("id", contactIdsForBought);

    const { data, count, error: qErr } = await query;
    if (qErr) {
      setError("We couldn't load your contacts. Please try again.");
      setLoading(false);
      return;
    }

    const base = (data ?? []) as Omit<ContactRow, "tags">[];
    let withTags: ContactRow[] = base.map((c) => ({ ...c, tags: [] }));
    const ids = base.map((c) => c.id);
    if (base.length) {
      const { data: links } = await aidwar
        .from("contact_tags")
        .select("contact_id, tags(id, name, color)")
        .eq("organization_id", organizationId)
        .in("contact_id", ids);
      const map = new Map<string, TagRow[]>();
      for (const link of (links as unknown as { contact_id: string; tags: TagRow | null }[]) ??
        []) {
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

    // The page's extra columns: newest chat, and what each spent in the shop.
    if (!ids.length) {
      setLastChat({});
      setSpent({});
      return;
    }
    const [chats, orders] = await Promise.all([
      Promise.resolve(
        aidwar
          .from("conversations")
          .select("contact_id, last_message_at")
          .eq("organization_id", organizationId)
          .in("contact_id", ids),
      ).catch(() => ({ data: null })),
      canSeeOrders && hasOrders
        ? Promise.resolve(
            aidwar
              .from("orders")
              .select("contact_id, total, currency, cancelled_at")
              .eq("organization_id", organizationId)
              .in("contact_id", ids)
              .limit(1000),
          ).catch(() => ({ data: null }))
        : Promise.resolve({ data: null }),
    ]);
    setLastChat(
      latestChatByContact(
        (chats.data as { contact_id: string | null; last_message_at: string | null }[] | null) ??
          [],
      ),
    );
    setSpent(spentByContact((orders.data as OrderLite[] | null) ?? []));
  }, [organizationId, page, debounced, filters, segments, canSeeOrders, hasOrders]);

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

  const filtered = anyFilters(filters, debounced);
  const chips = useMemo(
    () =>
      filterChips(filters, {
        tags: Object.fromEntries(allTags.map((t) => [t.id, t.name])),
        segments: Object.fromEntries(segments.map((s) => [s.id, s.name])),
      }),
    [filters, allTags, segments],
  );
  const showSpent = canSeeOrders && hasOrders;
  const setFilter = (next: CustomerFilters) => {
    setFilters(next);
    setPage(0);
  };

  async function exportCsv() {
    setExporting(true);
    let query = aidwar
      .from("contacts")
      .select("name, phone, opt_in_status, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(10000);
    if (debounced) query = query.or(`name.ilike.%${debounced}%,phone.ilike.%${debounced}%`);
    if (filters.optIn !== "all") query = query.eq("opt_in_status", filters.optIn);
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
        tag: filters.tagId,
        opt_in: filters.optIn,
        segment: filters.segmentId,
      },
    });
  }

  const selectedIds = Array.from(checked);
  const clearSelection = () => setChecked(new Set());

  /** Batch 36's bulk opt-in, exactly as the classic list's BulkOptInBar sends it. */
  async function markSelected() {
    setBusy(true);
    const res = await callApi<BulkOptInResult>("/api/contacts/opt-in", {
      body: { action: "bulk", organization_id: organizationId, contact_ids: selectedIds },
    });
    setBusy(false);
    if (res.error || !res.data) {
      toast.error(res.error ?? "We couldn't update these contacts.");
      return;
    }
    toast.success(bulkOptInSummary(res.data));
    clearSelection();
    void load();
  }

  /** The drawer's own tag write (contact_tags upsert), for each ticked customer without the tag. */
  async function addTag(tag: TagRow) {
    const tagsOf = Object.fromEntries(contacts.map((c) => [c.id, c.tags.map((t) => t.id)]));
    const links = tagLinks(organizationId, tag.id, selectedIds, tagsOf);
    if (!links.length) {
      toast.success(`Everyone selected already has “${tag.name}”.`);
      return;
    }
    setBusy(true);
    const { error: tagErr } = await aidwar
      .from("contact_tags")
      .upsert(links, { onConflict: "contact_id,tag_id" });
    setBusy(false);
    if (tagErr) {
      toast.error("We couldn't add that tag.");
      return;
    }
    toast.success(
      `Added “${tag.name}” to ${links.length.toLocaleString("en-IN")} ${links.length === 1 ? "customer" : "customers"}.`,
    );
    clearSelection();
    void load();
  }

  const toggle = (id: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allOnPage = contacts.length > 0 && contacts.every((c) => checked.has(c.id));
  const toggleAll = (on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const c of contacts) {
        if (on) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });

  const addButton = (
    <AddContactDialog
      organizationId={organizationId}
      onCreated={() => {
        setPage(0);
        void load();
      }}
      trigger={<Button>Add customer</Button>}
    />
  );

  return (
    <div className="nd-view-enter">
      <PageHeader
        title="Contacts"
        description="Everyone who has your number: tags, opt-in, their last chat and what they bought."
        actions={
          <>
            <PermissionGate allowed={canImport} reason={permissionDeniedReason("Import contacts")}>
              <GuidedImportDialog organizationId={organizationId} onImported={() => void load()} />
            </PermissionGate>
            <PermissionGate allowed={canEdit} reason={permissionDeniedReason("Edit contacts")}>
              {addButton}
            </PermissionGate>
          </>
        }
      />

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full wide:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone"
              className="h-9 rounded-full pl-9"
              aria-label="Search contacts"
            />
          </div>
          {chips.map((c) => (
            <span key={c.key} className={cn(chipClass, "pr-1.5 hover:bg-surface")}>
              {c.label}
              <button
                type="button"
                onClick={() => setFilter(clearFilter(filters, c.key))}
                aria-label={`Remove filter ${c.label}`}
                className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-ground hover:text-foreground focus-visible:outline-2 focus-visible:outline-aiden"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger className={chipClass}>+ Filter</DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Opt-in</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {(["opted_in", "unknown", "opted_out"] as OptInStatus[]).map((k) => (
                    <DropdownMenuItem key={k} onSelect={() => setFilter({ ...filters, optIn: k })}>
                      {OPT_IN_CHIP[k].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Tag</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  {allTags.length ? (
                    allTags.map((t) => (
                      <DropdownMenuItem
                        key={t.id}
                        onSelect={() => setFilter({ ...filters, tagId: t.id })}
                      >
                        {t.name}
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                      No tags yet
                    </DropdownMenuLabel>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {hasOrders ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Bought in the last…</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {BOUGHT_DAYS.map((d) => (
                      <DropdownMenuItem
                        key={d}
                        onSelect={() => setFilter({ ...filters, boughtDays: d })}
                      >
                        {d} days
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              {segments.length ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Saved segment</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                    {segments.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onSelect={() => setFilter({ ...filters, segmentId: s.id })}
                      >
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex flex-wrap items-center gap-1 wide:ml-auto">
            {canExport ? (
              <Button variant="ghost" onClick={() => void exportCsv()} disabled={exporting}>
                <Download className="h-4 w-4" aria-hidden="true" />
                {exporting ? "Exporting…" : "Export CSV"}
              </Button>
            ) : null}
            {canEdit ? (
              <MarkAllUnknownOptedIn organizationId={organizationId} onDone={() => void load()} />
            ) : null}
          </div>
        </div>

        {error ? (
          <ErrorState message={error} />
        ) : loading ? (
          <TableSkeleton rows={8} />
        ) : total === 0 && !filtered ? (
          <EmptyState
            icon={ContactIcon}
            title="No customers yet"
            description="Import your customers to start reaching them, or add your first one by hand."
            action={canEdit ? addButton : undefined}
          />
        ) : (
          <div className="overflow-hidden rounded-[20px] border border-line bg-surface phone:border-0 phone:bg-transparent">
            {contacts.length === 0 ? (
              <NoResults message="No customers match these filters." />
            ) : (
              <>
                {/* Desktop: the preview's table. */}
                <div className="overflow-x-auto phone:hidden">
                  <table className="w-full min-w-[760px] border-collapse">
                    <caption className="sr-only">Your customers</caption>
                    <thead>
                      <tr className="text-left text-sm font-semibold text-muted-foreground">
                        {canEdit ? (
                          <th scope="col" className="w-12 border-b border-line py-3.5 pl-5 pr-2">
                            <Checkbox
                              aria-label="Select all customers on this page"
                              checked={allOnPage}
                              onCheckedChange={(v) => toggleAll(v === true)}
                            />
                          </th>
                        ) : null}
                        <th scope="col" className="border-b border-line px-4 py-3.5 font-semibold">
                          Customer
                        </th>
                        <th scope="col" className="border-b border-line px-4 py-3.5 font-semibold">
                          Tags
                        </th>
                        <th scope="col" className="border-b border-line px-4 py-3.5 font-semibold">
                          Messages
                        </th>
                        <th scope="col" className="border-b border-line px-4 py-3.5 font-semibold">
                          Last chat
                        </th>
                        {showSpent ? (
                          <th
                            scope="col"
                            className="border-b border-line px-4 py-3.5 font-semibold"
                          >
                            Spent
                          </th>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.map((c) => {
                        const label = c.name || c.phone;
                        return (
                          <tr
                            key={c.id}
                            onClick={() => setSelected(c)}
                            className={cn(
                              "cursor-pointer border-b border-line transition-colors duration-200 last:border-b-0 hover:bg-ground",
                              checked.has(c.id) && "bg-ground",
                            )}
                          >
                            {canEdit ? (
                              <td className="py-3 pl-5 pr-2" onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  aria-label={`Select ${label}`}
                                  checked={checked.has(c.id)}
                                  onCheckedChange={(v) => toggle(c.id, v === true)}
                                />
                              </td>
                            ) : null}
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelected(c);
                                }}
                                className="flex items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                              >
                                <ToneAvatar seed={c.id} label={label} />
                                <span className="flex min-w-0 flex-col">
                                  <b className="truncate font-semibold text-foreground">
                                    {c.name || "Unnamed customer"}
                                  </b>
                                  <small className="text-[0.8125rem] text-muted-foreground">
                                    {c.phone}
                                  </small>
                                </span>
                              </button>
                            </td>
                            <td className="px-4 py-3">
                              <TagChips tags={c.tags} />
                            </td>
                            <td className="px-4 py-3">
                              <OptInChip status={c.opt_in_status} />
                            </td>
                            <td className="px-4 py-3 text-[0.9375rem] text-muted-foreground">
                              {lastChatLabel(lastChat[c.id])}
                            </td>
                            {showSpent ? (
                              <td className="tabular px-4 py-3 text-[0.9375rem]">
                                {spentLabel(spent[c.id])}
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Phone: each customer as a card. */}
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0 wide:hidden">
                  {contacts.map((c) => {
                    const label = c.name || c.phone;
                    return (
                      <li
                        key={c.id}
                        className={cn(
                          "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-2xl border border-line bg-surface p-3",
                          checked.has(c.id) && "border-aiden",
                        )}
                      >
                        {canEdit ? (
                          <Checkbox
                            className="mt-3"
                            aria-label={`Select ${label}`}
                            checked={checked.has(c.id)}
                            onCheckedChange={(v) => toggle(c.id, v === true)}
                          />
                        ) : (
                          <span />
                        )}
                        <div className="flex min-w-0 flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => setSelected(c)}
                            className="flex min-w-0 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                          >
                            <ToneAvatar seed={c.id} label={label} />
                            <span className="flex min-w-0 flex-col">
                              <b className="truncate font-semibold text-foreground">
                                {c.name || "Unnamed customer"}
                              </b>
                              <small className="text-[0.8125rem] text-muted-foreground">
                                {c.phone}
                              </small>
                            </span>
                          </button>
                          {c.tags.length ? <TagChips tags={c.tags} /> : null}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                            <OptInChip status={c.opt_in_status} />
                            <span>Last chat {lastChatLabel(lastChat[c.id])}</span>
                            {showSpent ? (
                              <span className="tabular text-foreground">
                                {spentLabel(spent[c.id])}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <div className="phone:mt-3 phone:rounded-2xl phone:border phone:border-line phone:bg-surface">
              <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </div>
          </div>
        )}

        {breakdown && breakdown.length ? (
          <section aria-labelledby="nd-sources" className="flex flex-col gap-2">
            <h2 id="nd-sources" className="m-0 font-display text-lg font-semibold">
              Where your customers come from
            </h2>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {breakdown.map((r) => (
                <li
                  key={r.source}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm"
                >
                  <span className="font-semibold">{sourceLabel(r.source)}</span>
                  <span className="tabular text-muted-foreground">
                    {Number(r.contacts).toLocaleString("en-IN")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {canEdit && selectedIds.length ? (
        <div
          role="region"
          aria-label="Selected customers"
          className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2.5 rounded-2xl bg-ink py-2.5 pl-[18px] pr-3 text-ink-foreground shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-300 motion-reduce:animate-none phone:bottom-[calc(84px+env(safe-area-inset-bottom))] phone:w-full"
        >
          <span className="tabular font-semibold phone:flex-1 phone:basis-[60%]" aria-live="polite">
            {selectedLabel(selectedIds.length)}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className="order-2 phone:flex-1 border-muted-foreground bg-transparent text-ink-foreground hover:bg-ink-foreground/10 hover:text-ink-foreground"
              >
                <Tag className="h-4 w-4" aria-hidden="true" />
                Add tag
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="center"
              side="top"
              className="max-h-72 w-56 overflow-y-auto"
            >
              {allTags.length ? (
                allTags.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => void addTag(t)}>
                    {t.name}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  No tags yet. Open a customer to create one.
                </DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void markSelected()}
            className="order-2 phone:flex-1 border-muted-foreground bg-transparent text-ink-foreground hover:bg-ink-foreground/10 hover:text-ink-foreground"
          >
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
            {busy ? "Updating…" : "Mark as opted in"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={clearSelection}
            className="order-1 text-ink-foreground hover:bg-ink-foreground/10 hover:text-ink-foreground wide:order-3"
          >
            Clear
          </Button>
          <span className="order-4 text-xs text-ink-foreground/80 phone:hidden">
            Opted-out customers stay opted out.
          </span>
        </div>
      ) : null}

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
        extra={
          selected ? (
            <CustomerSummary
              organizationId={organizationId}
              contact={selected}
              canSeeOrders={canSeeOrders}
            />
          ) : null
        }
        {...(isPhone ? { side: "bottom" as const } : {})}
      />
    </div>
  );
}
