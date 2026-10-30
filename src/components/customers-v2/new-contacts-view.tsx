import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCheck,
  Contact as ContactIcon,
  Download,
  Megaphone,
  Search,
  Tag,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { handPickedSummary, saveHandPicked } from "@/lib/hand-picked";
import { downloadCsv, toCsv } from "@/lib/csv";
import { logActivity } from "@/lib/activity";
import { callApi } from "@/lib/whatsapp-client";
import { permissionDeniedReason } from "@/lib/permissions";
import { sourceLabel, type ContactRow, type OptInStatus, type TagRow } from "@/lib/contacts";
import type { SegmentRow } from "@/lib/segments";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { Pagination } from "@/components/data-pagination";
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
import { Skeleton } from "@/components/ui/skeleton";
import { NumberTicker } from "@/components/design-v2";
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
import { CustomerNotes, canWriteNotes } from "./customer-notes";
import { GuidedImportDialog } from "./import-guided";
import { contactsCopy as t, drawerCopy, markAllCopy } from "./copy";
import { PAGINATION_WORDS } from "@/components/design-v2/copy";
import {
  BOUGHT_DAYS,
  NO_FILTERS,
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
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-ground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden phone:h-11";

/** Batch 57: blocks arrive one after another (styles.css .nd-rise, off under reduced motion). */
const rise = (d: number) => ({ className: "nd-rise", style: { "--d": d } as CSSProperties });

/** A 16px tick box with a 44px tap area around it (the box itself doesn't grow). */
const tickClass = "relative after:absolute after:-inset-3.5 after:content-['']";

/** The bulk bar's buttons on ink, 44px tall on a phone. */
const onInk =
  "order-2 phone:h-11 phone:flex-1 border-muted-foreground bg-transparent text-ink-foreground hover:bg-ink-foreground/10 hover:text-ink-foreground";

/** Shimmer rows in the list's own shape while it loads. */
function ListSkeleton() {
  return (
    <div
      className="flex flex-col rounded-[20px] border border-line bg-surface phone:gap-2.5 phone:border-0 phone:bg-transparent"
      aria-busy="true"
      aria-label={t.loading}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0 phone:rounded-2xl phone:border phone:bg-surface phone:p-3 phone:last:border-b"
        >
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-28 max-w-full" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full wide:block" />
          <Skeleton className="hidden h-4 w-24 wide:block" />
        </div>
      ))}
    </div>
  );
}

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
  if (!tags.length) return <span className="text-sm text-muted-foreground">{t.noTags}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="rounded-full bg-aiden-soft px-2.5 py-1 text-[0.8125rem] font-semibold text-aiden-deep"
        >
          {tag.name}
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
  // Batch 51: "Send campaign" saves the ticked customers as a segment, then opens the wizard.
  const campaignsFlag = useFeatureFlag("campaigns");
  const canSendCampaign =
    campaignsFlag.enabled && can("segments.manage") && can("campaigns.create");
  const navigate = useNavigate();
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
      setError(t.loadFailed);
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
      toast.error(t.downloadFailed);
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
      toast.error(res.error ?? t.bulk.markFailed);
      return;
    }
    toast.success(bulkOptInSummary(res.data));
    clearSelection();
    void load();
  }

  /**
   * Batch 51: the ticked customers become a hand-picked segment (opted-out
   * ones left out), and the campaign wizard opens with it chosen. The wizard
   * does everything else: who is reachable, the cost and the wallet check.
   */
  async function sendCampaign() {
    setBusy(true);
    const { data: who } = await aidwar.auth.getUser();
    const res = await saveHandPicked(aidwar, {
      organizationId,
      userId: who.user?.id ?? null,
      contactIds: selectedIds,
      segmentId: crypto.randomUUID(),
      now: new Date(),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    void logActivity("segment_created", organizationId, {
      hand_picked: true,
      contacts: res.saved,
      opted_out_left_out: res.optedOut,
    });
    toast.success(handPickedSummary(res.saved, res.optedOut));
    clearSelection();
    void navigate({ to: "/app/campaigns", search: { segment: res.segmentId } });
  }

  /** The drawer's own tag write (contact_tags upsert), for each ticked customer without the tag. */
  async function addTag(tag: TagRow) {
    const tagsOf = Object.fromEntries(contacts.map((c) => [c.id, c.tags.map((t) => t.id)]));
    const links = tagLinks(organizationId, tag.id, selectedIds, tagsOf);
    if (!links.length) {
      toast.success(t.bulk.alreadyTagged(tag.name));
      return;
    }
    setBusy(true);
    const { error: tagErr } = await aidwar
      .from("contact_tags")
      .upsert(links, { onConflict: "contact_id,tag_id" });
    setBusy(false);
    if (tagErr) {
      toast.error(t.bulk.tagFailed);
      return;
    }
    toast.success(t.bulk.tagged(tag.name, links.length));
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
      trigger={<Button className="phone:h-11">{t.add}</Button>}
    />
  );
  const importButton = (
    <GuidedImportDialog
      organizationId={organizationId}
      onImported={() => void load()}
      label={t.importList}
    />
  );
  const showEveryone = () => {
    setSearch("");
    setDebounced("");
    setFilter(NO_FILTERS);
  };

  return (
    <div className="nd-view-enter">
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <>
            <PermissionGate allowed={canImport} reason={permissionDeniedReason("Import contacts")}>
              {importButton}
            </PermissionGate>
            <PermissionGate allowed={canEdit} reason={permissionDeniedReason("Edit contacts")}>
              {addButton}
            </PermissionGate>
          </>
        }
      />

      <div className="flex flex-col gap-5">
        <div {...rise(0)}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full wide:w-64">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="h-9 rounded-full pl-9 phone:h-11"
                aria-label={t.searchLabel}
              />
            </div>
            {chips.map((c) => (
              <span key={c.key} className={cn(chipClass, "pr-1.5 hover:bg-surface")}>
                {c.label}
                <button
                  type="button"
                  onClick={() => setFilter(clearFilter(filters, c.key))}
                  aria-label={t.removeFilter(c.label)}
                  className="relative grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors duration-200 after:absolute after:-inset-2.5 after:content-[''] hover:bg-ground hover:text-foreground focus-visible:outline-2 focus-visible:outline-aiden"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger className={chipClass}>{t.addFilter}</DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{t.filterOptIn}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {(["opted_in", "unknown", "opted_out"] as OptInStatus[]).map((k) => (
                      <DropdownMenuItem
                        key={k}
                        onSelect={() => setFilter({ ...filters, optIn: k })}
                      >
                        {OPT_IN_CHIP[k].label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{t.filterTag}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                    {allTags.length ? (
                      allTags.map((tag) => (
                        <DropdownMenuItem
                          key={tag.id}
                          onSelect={() => setFilter({ ...filters, tagId: tag.id })}
                        >
                          {tag.name}
                        </DropdownMenuItem>
                      ))
                    ) : (
                      <DropdownMenuLabel className="font-normal text-muted-foreground">
                        {t.noTagsYet}
                      </DropdownMenuLabel>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {hasOrders ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{t.filterBought}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {BOUGHT_DAYS.map((d) => (
                        <DropdownMenuItem
                          key={d}
                          onSelect={() => setFilter({ ...filters, boughtDays: d })}
                        >
                          {t.days(d)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {segments.length ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{t.filterGroup}</DropdownMenuSubTrigger>
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
                <Button
                  variant="ghost"
                  className="phone:h-11"
                  onClick={() => void exportCsv()}
                  disabled={exporting}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {exporting ? t.downloading : t.download}
                </Button>
              ) : null}
              {canEdit ? (
                <MarkAllUnknownOptedIn
                  organizationId={organizationId}
                  onDone={() => void load()}
                  words={markAllCopy}
                  buttonClassName="rounded-full phone:h-11"
                />
              ) : null}
            </div>
          </div>
        </div>

        <div {...rise(1)}>
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : loading ? (
            <ListSkeleton />
          ) : total === 0 && !filtered ? (
            <EmptyState
              icon={ContactIcon}
              art="people"
              title={t.empty.title}
              description={t.empty.description}
              action={canImport ? importButton : canEdit ? addButton : undefined}
            />
          ) : (
            <div className="overflow-hidden rounded-[20px] border border-line bg-surface phone:border-0 phone:bg-transparent">
              {contacts.length === 0 ? (
                <EmptyState
                  icon={ContactIcon}
                  variant="plain"
                  art="people"
                  title={t.noMatch.title}
                  description={t.noMatch.description}
                  action={
                    <Button variant="outline" className="phone:h-11" onClick={showEveryone}>
                      {t.noMatch.action}
                    </Button>
                  }
                />
              ) : (
                <>
                  {/* Desktop: the preview's table. */}
                  <div className="overflow-x-auto phone:hidden">
                    <table className="w-full min-w-[760px] border-collapse">
                      <caption className="sr-only">{t.tableCaption}</caption>
                      <thead>
                        <tr className="text-left text-sm font-semibold text-muted-foreground">
                          {canEdit ? (
                            <th scope="col" className="w-12 border-b border-line py-3.5 pl-5 pr-2">
                              <Checkbox
                                aria-label={t.selectAll}
                                checked={allOnPage}
                                onCheckedChange={(v) => toggleAll(v === true)}
                              />
                            </th>
                          ) : null}
                          <th
                            scope="col"
                            className="border-b border-line px-4 py-3.5 font-semibold"
                          >
                            {t.col.customer}
                          </th>
                          <th
                            scope="col"
                            className="border-b border-line px-4 py-3.5 font-semibold"
                          >
                            {t.col.tags}
                          </th>
                          <th
                            scope="col"
                            className="border-b border-line px-4 py-3.5 font-semibold"
                          >
                            {t.col.messages}
                          </th>
                          <th
                            scope="col"
                            className="border-b border-line px-4 py-3.5 font-semibold"
                          >
                            {t.col.lastChat}
                          </th>
                          {showSpent ? (
                            <th
                              scope="col"
                              className="border-b border-line px-4 py-3.5 font-semibold"
                            >
                              {t.col.spent}
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
                                    aria-label={t.select(label)}
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
                                      {c.name || t.noName}
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
                            "nd-lift grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-2xl border border-line bg-surface p-3",
                            checked.has(c.id) && "border-aiden",
                          )}
                        >
                          {canEdit ? (
                            <Checkbox
                              className={cn("mt-3", tickClass)}
                              aria-label={t.select(label)}
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
                              className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                            >
                              <ToneAvatar seed={c.id} label={label} />
                              <span className="flex min-w-0 flex-col">
                                <b className="truncate font-semibold text-foreground">
                                  {c.name || t.noName}
                                </b>
                                <small className="text-[0.8125rem] text-muted-foreground">
                                  {c.phone}
                                </small>
                              </span>
                            </button>
                            {c.tags.length ? <TagChips tags={c.tags} /> : null}
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                              <OptInChip status={c.opt_in_status} />
                              <span>{t.lastChat(lastChatLabel(lastChat[c.id]))}</span>
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
                <Pagination
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onPageChange={setPage}
                  words={PAGINATION_WORDS}
                />
              </div>
            </div>
          )}
        </div>

        {breakdown && breakdown.length ? (
          <section
            aria-labelledby="nd-sources"
            className="nd-rise flex flex-col gap-2"
            style={{ "--d": 2 } as CSSProperties}
          >
            <h2 id="nd-sources" className="m-0 font-display text-lg font-semibold">
              {t.sourcesTitle}
            </h2>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {breakdown.map((r) => (
                <li
                  key={r.source}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm"
                >
                  <span className="font-semibold">{sourceLabel(r.source)}</span>
                  <NumberTicker
                    value={Number(r.contacts) || 0}
                    className="tabular text-muted-foreground"
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* The bulk bar: sticky inside the work area, whose bottom padding already
          clears the phone's bottom bar (and the home indicator), so these
          offsets put it 16px above the window's edge / 12px above that bar. */}
      {canEdit && selectedIds.length ? (
        <div
          role="region"
          aria-label={t.bulk.region}
          className="sticky -bottom-8 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2.5 rounded-2xl bg-ink py-2.5 pl-[18px] pr-3 text-ink-foreground shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-300 motion-reduce:animate-none phone:-bottom-2 phone:w-full"
        >
          <span className="tabular font-semibold phone:flex-1 phone:basis-[60%]" aria-live="polite">
            {selectedLabel(selectedIds.length)}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy} className={onInk}>
                <Tag className="h-4 w-4" aria-hidden="true" />
                {t.bulk.addTag}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="center"
              side="top"
              className="max-h-72 w-56 overflow-y-auto"
            >
              {allTags.length ? (
                allTags.map((tag) => (
                  <DropdownMenuItem key={tag.id} onSelect={() => void addTag(tag)}>
                    {tag.name}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {t.bulk.noTagsYet}
                </DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void markSelected()}
            className={onInk}
          >
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
            {busy ? t.bulk.saving : t.bulk.markYes}
          </Button>
          {canSendCampaign ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void sendCampaign()}
              className={onInk}
            >
              <Megaphone className="h-4 w-4" aria-hidden="true" />
              {t.bulk.sendCampaign}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={clearSelection}
            className="order-1 text-ink-foreground hover:bg-ink-foreground/10 hover:text-ink-foreground phone:h-11 wide:order-3"
          >
            {t.bulk.clear}
          </Button>
          <span className="order-4 text-xs text-ink-foreground/80 phone:hidden">{t.bulk.note}</span>
        </div>
      ) : null}

      <ContactDrawer
        contact={selected}
        organizationId={organizationId}
        allTags={allTags}
        canDelete={canDeleteContacts}
        onClose={() => setSelected(null)}
        words={drawerCopy}
        roomy
        onChanged={() => {
          void loadTags();
          void loadBreakdown();
          void load();
        }}
        extra={
          selected ? (
            <>
              <CustomerSummary
                organizationId={organizationId}
                contact={selected}
                canSeeOrders={canSeeOrders}
              />
              <CustomerNotes
                organizationId={organizationId}
                contactId={selected.id}
                canWrite={canWriteNotes(can)}
              />
            </>
          ) : null
        }
        {...(isPhone ? { side: "bottom" as const } : {})}
      />
    </div>
  );
}
