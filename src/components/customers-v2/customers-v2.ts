import type { AttributionSourceRow } from "@/lib/analytics";
import type { OptInStatus } from "@/lib/contacts";
import { importCopy, listCopy, optInCopy } from "./copy";

/**
 * Batch 48: the new Customers screens (docs/design/preview.html #customers),
 * behind `new_design`. Pure helpers, so the rules are tested without a page.
 * Every read and write goes where the classic Contacts page sends it.
 */

/** The opt-in chip in plain words (Batch 57): "Said yes" / "No answer yet" / "Said no". */
export const OPT_IN_CHIP: Record<OptInStatus, { label: string; className: string }> = {
  opted_in: { label: optInCopy.opted_in.chip, className: "bg-aiden-soft text-aiden-deep" },
  unknown: { label: optInCopy.unknown.chip, className: "bg-gold-bg text-gold-ink" },
  opted_out: {
    label: optInCopy.opted_out.chip,
    className: "bg-danger-soft text-danger-soft-foreground",
  },
};

/** "Bought in the last N days": what the + Filter menu offers (shop orders only). */
export const BOUGHT_DAYS = [30, 90, 180] as const;
export type BoughtDays = (typeof BOUGHT_DAYS)[number];

export type CustomerFilters = {
  optIn: OptInStatus | "all";
  tagId: string | "all";
  /** A saved segment, used as a saved view (the classic "All contacts" select). */
  segmentId: string | "all";
  boughtDays: BoughtDays | null;
};

export const NO_FILTERS: CustomerFilters = {
  optIn: "all",
  tagId: "all",
  segmentId: "all",
  boughtDays: null,
};

/** ?opt_in=unknown (the flows reachability warning's link) starts with that chip on. */
export function initialFilters(optIn: string | undefined): CustomerFilters {
  return optIn === "opted_in" || optIn === "opted_out" || optIn === "unknown"
    ? { ...NO_FILTERS, optIn }
    : NO_FILTERS;
}

export type FilterChip = { key: keyof CustomerFilters; label: string };

/** The chips on show, in the preview's order: opt-in, tag, bought, saved view. */
export function filterChips(
  f: CustomerFilters,
  names: { tags: Record<string, string>; segments: Record<string, string> },
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.optIn !== "all") chips.push({ key: "optIn", label: optInCopy[f.optIn].long });
  if (f.tagId !== "all")
    chips.push({ key: "tagId", label: listCopy.tagChip(names.tags[f.tagId] ?? "…") });
  if (f.boughtDays) chips.push({ key: "boughtDays", label: listCopy.boughtChip(f.boughtDays) });
  if (f.segmentId !== "all")
    chips.push({ key: "segmentId", label: listCopy.groupChip(names.segments[f.segmentId] ?? "…") });
  return chips;
}

export function clearFilter(f: CustomerFilters, key: keyof CustomerFilters): CustomerFilters {
  return { ...f, [key]: NO_FILTERS[key] };
}

export function hasFilters(f: CustomerFilters, search: string): boolean {
  return (
    Boolean(search) ||
    f.optIn !== "all" ||
    f.tagId !== "all" ||
    f.segmentId !== "all" ||
    f.boughtDays !== null
  );
}

/** The first day (ISO) an order counts for "bought in the last N days". */
export function boughtSince(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** Ids in every list given (null = no limit from that filter); [] when they don't meet. */
export function intersectIds(...lists: Array<string[] | null>): string[] | null {
  const real = lists.filter((l): l is string[] => l !== null);
  if (!real.length) return null;
  const [first, ...rest] = real;
  const sets = rest.map((l) => new Set(l));
  return Array.from(new Set(first)).filter((id) => sets.every((s) => s.has(id)));
}

/** "26 min ago", "just now", "3 hours ago", "2 days ago", else the date. */
export function lastChatLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return listCopy.noChat;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return listCopy.noChat;
  const min = Math.round((now - t) / 60000);
  if (min < 1) return listCopy.justNow;
  if (min < 60) return listCopy.minAgo(min);
  const hrs = Math.round(min / 60);
  if (hrs < 24) return listCopy.hoursAgo(hrs);
  const days = Math.round(hrs / 24);
  if (days < 7) return listCopy.daysAgo(days);
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Each contact's newest chat time, from their conversations. */
export function latestChatByContact(
  rows: Array<{ contact_id: string | null; last_message_at: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.contact_id || !r.last_message_at) continue;
    const prev = out[r.contact_id];
    if (!prev || new Date(r.last_message_at) > new Date(prev))
      out[r.contact_id] = r.last_message_at;
  }
  return out;
}

export type OrderLite = {
  contact_id: string | null;
  total: number | string | null;
  currency: string | null;
  cancelled_at?: string | null;
};

/**
 * What each customer spent: the shop's synced orders (public.orders), not
 * cancelled, summed per currency (Batch 20: prices follow each currency).
 */
export function spentByContact(orders: OrderLite[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const o of orders) {
    if (!o.contact_id || o.cancelled_at) continue;
    const n = Number(o.total);
    if (o.total === null || !Number.isFinite(n)) continue;
    const cur = o.currency || "INR";
    const mine = (out[o.contact_id] ??= {});
    mine[cur] = (mine[cur] ?? 0) + n;
  }
  return out;
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-IN")}`;
  }
}

/** "₹41,200" (or "₹41,200 + $120"); "—" when nothing was bought. */
export function spentLabel(spent: Record<string, number> | undefined): string {
  const parts = Object.entries(spent ?? {}).filter(([, n]) => n > 0);
  if (!parts.length) return listCopy.nothingSpent;
  return parts.map(([cur, n]) => money(n, cur)).join(" + ");
}

/** "3 selected" in the bulk bar. */
export function selectedLabel(n: number): string {
  return listCopy.selected(n);
}

/**
 * Bulk "Add tag": the drawer's own write (one contact_tags row per contact),
 * for the ticked contacts that don't have the tag yet. contact_tags has no
 * update policy, so a row that exists is never sent again.
 */
export function tagLinks(
  organizationId: string,
  tagId: string,
  selected: string[],
  tagsOf: Record<string, string[]>,
): Array<{ contact_id: string; tag_id: string; organization_id: string }> {
  return selected
    .filter((id) => !(tagsOf[id] ?? []).includes(tagId))
    .map((id) => ({ contact_id: id, tag_id: tagId, organization_id: organizationId }));
}

/** The guided import's three steps (Batch 48), over the classic five. */
export const IMPORT_STEPS = importCopy.steps;
/** What each step asks, for the dialog's description. */
export const IMPORT_STEP_HINTS = importCopy.hints;

/** Classic step (1 upload, 2 map, 3 consent, 4 running, 5 done) → the guided step shown. */
export function guidedStep(classicStep: number): 1 | 2 | 3 {
  if (classicStep <= 1) return 1;
  if (classicStep === 2) return 2;
  return 3;
}

/** A flow run's state in plain words (Flows v2 statuses). */
export function flowRunLabel(status: string): string {
  const words = listCopy.flowRun;
  switch (status) {
    case "running":
      return words.running;
    case "waiting":
      return words.waiting;
    case "paused":
      return words.paused;
    case "done":
      return words.done;
    case "failed":
      return words.failed;
    case "expired":
      return words.expired;
    case "cancelled":
    case "ended":
      return words.ended;
    default:
      return status;
  }
}

/* Sales from chats (the Receipts page's sums, as the classic page adds them). */

export const withTax = (spent: number, gst: number) => spent * (1 + gst / 100);

export type ReceiptTotals = {
  messages_sent: number;
  delivered: number;
  read_count: number;
  clicked: number;
  orders: number;
  revenue: number;
  spent: number;
  cost_complete: boolean;
};

/** The "Everything together" row: the same sums as the classic Receipts page. */
export function sumReceiptRows(rows: AttributionSourceRow[]): ReceiptTotals {
  return rows.reduce<ReceiptTotals>(
    (acc, r) => ({
      messages_sent: acc.messages_sent + Number(r.messages_sent),
      delivered: acc.delivered + Number(r.delivered),
      read_count: acc.read_count + Number(r.read_count),
      clicked: acc.clicked + Number(r.clicked),
      orders: acc.orders + Number(r.orders),
      revenue: acc.revenue + Number(r.revenue),
      spent: acc.spent + Number(r.spent),
      cost_complete: acc.cost_complete && r.cost_complete,
    }),
    {
      messages_sent: 0,
      delivered: 0,
      read_count: 0,
      clicked: 0,
      orders: 0,
      revenue: 0,
      spent: 0,
      cost_complete: true,
    },
  );
}

/** "₹12 back per ₹1"; null when nothing billable yet. */
export function ratioText(revenue: number, spent: number): string | null {
  if (spent <= 0) return null;
  const value = revenue / spent;
  return listCopy.backPerRupee(value.toFixed(value >= 10 ? 0 : 1));
}
