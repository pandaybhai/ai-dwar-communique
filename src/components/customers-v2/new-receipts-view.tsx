import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, Megaphone, RefreshCw, Workflow } from "lucide-react";
import { AnalyticsRevenue } from "@/components/analytics/analytics-revenue";
import { DateRangePicker } from "@/components/receipts/date-range-picker";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { numberLabel } from "@/lib/whatsapp-numbers";
import { buildReceiptsCsv, downloadCsv } from "@/lib/receipts-csv";
import {
  fetchAttributionSources,
  fetchAttributionSteps,
  fetchAttributionSummary,
  fetchCostSettings,
  makeFilters,
  periodForDays,
  type AttributionSourceRow,
  type AttributionStepRow,
  type AttributionSummary,
  type Period,
} from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { ratioText, sumReceiptRows, withTax } from "./customers-v2";

/**
 * Batch 48: Customers → Sales from chats in the new design. The Receipts
 * page's data, read the same way (the attribution functions Analytics uses,
 * the workspace's GST rate); only the totals row is added up here, as before.
 */

function money(amount: number, currency: string | null): string {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: value !== 0 && Math.abs(value) < 100 ? 2 : 0,
    }).format(value);
  } catch {
    return `${currency ?? ""} ${value.toLocaleString()}`.trim();
  }
}

function dayLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function Ratio({
  revenue,
  spent,
  complete,
}: {
  revenue: number;
  spent: number;
  complete: boolean;
}) {
  const text = ratioText(revenue, spent);
  if (!text) return <span className="text-muted-foreground">Nothing billable yet</span>;
  if (!complete) {
    return (
      <span className="text-muted-foreground">
        <span className="line-through">{text}</span>
        <span className="mt-0.5 block text-xs">Cost data incomplete</span>
      </span>
    );
  }
  return <span className="font-semibold text-foreground">{text}</span>;
}

const n = (v: number | string) => Number(v).toLocaleString("en-IN");

export function NewReceiptsView({
  organizationId,
  timezone,
}: {
  organizationId: string;
  timezone: string;
}) {
  const [period, setPeriod] = useState<Period>(() => periodForDays(timezone, 30, "Last 30 days"));
  const [accountId, setAccountId] = useState<string>("all");
  const { numbers, multiple } = useWhatsAppNumbers({ activeOnly: false });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AttributionSourceRow[]>([]);
  const [steps, setSteps] = useState<AttributionStepRow[]>([]);
  const [summary, setSummary] = useState<AttributionSummary | null>(null);
  const [gst, setGst] = useState(18);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const filters = makeFilters(period, accountId === "all" ? null : accountId);
    const [sourceRes, stepRes, summaryRes, settingsRes] = await Promise.all([
      fetchAttributionSources(organizationId, filters),
      fetchAttributionSteps(organizationId, filters),
      fetchAttributionSummary(organizationId, filters),
      fetchCostSettings(organizationId),
    ]);
    const firstError =
      sourceRes.error ?? stepRes.error ?? summaryRes.error ?? settingsRes.error ?? null;
    if (firstError) setError(firstError);
    setRows(sourceRes.data ?? []);
    setSteps(stepRes.data ?? []);
    setSummary(summaryRes.data ?? null);
    setGst(Number(settingsRes.data?.gst_percent ?? 18));
    setLoading(false);
  }, [organizationId, period, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(
    () => rows.filter((r) => Number(r.messages_sent) > 0 || Number(r.orders) > 0),
    [rows],
  );
  const totals = useMemo(() => sumReceiptRows(active), [active]);
  const currency = summary?.currency ?? active[0]?.currency ?? "INR";
  const stepsFor = (row: AttributionSourceRow) =>
    steps.filter((s) => s.source_id === row.source_id && s.source_type === row.source_type);

  const exportCsv = () => {
    const selected = numbers.find((x) => x.id === accountId);
    const csv = buildReceiptsCsv({
      rows: active,
      steps,
      totals,
      gstPercent: gst,
      currency,
      period,
      numberLabel: selected ? numberLabel(selected) : "All numbers",
    });
    downloadCsv(`aidwar-receipts-${period.from}-to-${period.to}.csv`, csv);
  };

  if (error) return <ErrorState message={error} />;

  const th =
    "border-b border-line px-4 py-3.5 text-right text-sm font-semibold text-muted-foreground";
  const td = "px-4 py-3 text-right tabular";

  return (
    <div className="nd-view-enter flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker timezone={timezone} period={period} onChange={setPeriod} />
        {multiple ? (
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="w-56 rounded-full" aria-label="WhatsApp number">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All numbers</SelectItem>
              {numbers.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {numberLabel(x)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="flex items-center gap-1 wide:ml-auto">
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw
              className={cn("h-4 w-4", loading && "animate-spin motion-reduce:animate-none")}
              aria-hidden="true"
            />
            Refresh
          </Button>
          <Button variant="ghost" onClick={exportCsv} disabled={loading || active.length === 0}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export CSV
          </Button>
        </div>
      </div>

      <dl className="m-0 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Sales from your messages", value: money(totals.revenue, currency) },
          { label: "Orders", value: n(totals.orders) },
          {
            label: "Message charges incl. tax",
            value: money(withTax(totals.spent, gst), currency),
          },
          {
            label: "Back for every ₹1",
            value:
              ratioText(totals.revenue, totals.spent)?.replace(" back per ₹1", "") ?? "None yet",
            note: totals.spent > 0 && !totals.cost_complete ? "Cost data incomplete" : null,
          },
        ].map((k) => (
          <div key={k.label} className="rounded-[20px] border border-line bg-surface p-4">
            <dt className="text-sm text-muted-foreground">{k.label}</dt>
            <dd className="tabular m-0 mt-1 font-display text-2xl font-semibold">
              {loading ? <Skeleton className="h-7 w-24" /> : k.value}
            </dd>
            {"note" in k && k.note ? (
              <p className="m-0 mt-1 text-xs text-muted-foreground">{k.note}</p>
            ) : null}
          </div>
        ))}
      </dl>

      <section
        aria-labelledby="nd-receipts-heading"
        className="rounded-[20px] border border-line bg-surface"
      >
        <div className="border-b border-line p-5">
          <h2 id="nd-receipts-heading" className="m-0 font-display text-lg font-semibold">
            Every campaign and flow, side by side
          </h2>
          <p className="m-0 mt-1 text-[0.9375rem] text-muted-foreground">
            What you sent, what people did with it, and what Meta charged you. Tax is added at {gst}
            %; change that in Settings. Open a row to see each message inside it.
          </p>
        </div>

        {loading ? (
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : active.length === 0 ? (
          <div className="p-10 text-center">
            <p className="m-0 font-semibold text-foreground">Nothing sent in this period</p>
            <p className="m-0 mt-1 text-[0.9375rem] text-muted-foreground">
              Send a campaign or switch on a flow, and its earnings and costs will appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full border-collapse text-[0.9375rem]">
                <caption className="sr-only">
                  Sales and message costs for each campaign and flow in the selected period
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={cn(th, "text-left")}>
                      Name
                    </th>
                    <th scope="col" className={th}>
                      Sent
                    </th>
                    <th scope="col" className={th}>
                      Delivered
                    </th>
                    <th scope="col" className={th}>
                      Read
                    </th>
                    <th scope="col" className={th}>
                      Clicked
                    </th>
                    <th scope="col" className={th}>
                      Orders
                    </th>
                    <th scope="col" className={th}>
                      Revenue
                    </th>
                    <th scope="col" className={th}>
                      Spent
                    </th>
                    <th scope="col" className={th}>
                      Incl. tax
                    </th>
                    <th scope="col" className={th}>
                      Per ₹1 spent
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((row) => {
                    const key = `${row.source_type}-${row.source_id}`;
                    const isOpen = Boolean(open[key]);
                    const children = stepsFor(row);
                    const Icon = row.source_type === "flow" ? Workflow : Megaphone;
                    const cur = row.currency ?? currency;
                    return (
                      <Fragment key={key}>
                        <tr className="border-b border-line align-top transition-colors duration-200 hover:bg-ground">
                          <th scope="row" className="px-4 py-3 text-left font-normal">
                            <button
                              type="button"
                              className="flex items-start gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                              aria-expanded={isOpen}
                              onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                            >
                              {isOpen ? (
                                <ChevronDown className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
                              ) : (
                                <ChevronRight
                                  className="mt-1 h-4 w-4 shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                              <span>
                                <span className="font-semibold text-foreground">{row.name}</span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                                  {row.source_type === "flow" ? "Automatic message" : "Campaign"}
                                  {row.created_at ? `, ${dayLabel(row.created_at)}` : ""}
                                </span>
                              </span>
                            </button>
                          </th>
                          <td className={td}>{n(row.messages_sent)}</td>
                          <td className={td}>{n(row.delivered)}</td>
                          <td className={td}>{n(row.read_count)}</td>
                          <td className={td}>{n(row.clicked)}</td>
                          <td className={td}>{n(row.orders)}</td>
                          <td className={cn(td, "font-semibold")}>
                            {money(Number(row.revenue), cur)}
                          </td>
                          <td className={td}>{money(Number(row.spent), cur)}</td>
                          <td className={td}>{money(withTax(Number(row.spent), gst), cur)}</td>
                          <td className={td}>
                            <Ratio
                              revenue={Number(row.revenue)}
                              spent={Number(row.spent)}
                              complete={row.cost_complete}
                            />
                          </td>
                        </tr>
                        {isOpen
                          ? children.map((s) => (
                              <tr
                                key={`${key}-${s.step_id ?? s.name}`}
                                className="border-b border-line bg-ground text-sm"
                              >
                                <th scope="row" className="px-4 py-2 pl-11 text-left font-normal">
                                  {s.step_order ? `Message ${s.step_order}: ` : ""}
                                  {s.name}
                                </th>
                                <td className={td}>{n(s.messages_sent)}</td>
                                <td className={td}>{n(s.delivered)}</td>
                                <td className={td}>{n(s.read_count)}</td>
                                <td className={td}>{n(s.clicked)}</td>
                                <td className={td}>{n(s.orders)}</td>
                                <td className={td}>
                                  {money(Number(s.revenue), s.currency ?? currency)}
                                </td>
                                <td className={td}>
                                  {money(Number(s.spent), s.currency ?? currency)}
                                </td>
                                <td className={td}>
                                  {money(withTax(Number(s.spent), gst), s.currency ?? currency)}
                                </td>
                                <td className={td}>
                                  <Ratio
                                    revenue={Number(s.revenue)}
                                    spent={Number(s.spent)}
                                    complete={s.cost_complete}
                                  />
                                </td>
                              </tr>
                            ))
                          : null}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" className="px-4 py-3.5 text-left">
                      Everything together
                    </th>
                    <td className={td}>{n(totals.messages_sent)}</td>
                    <td className={td}>{n(totals.delivered)}</td>
                    <td className={td}>{n(totals.read_count)}</td>
                    <td className={td}>{n(totals.clicked)}</td>
                    <td className={td}>{n(totals.orders)}</td>
                    <td className={td}>{money(totals.revenue, currency)}</td>
                    <td className={td}>{money(totals.spent, currency)}</td>
                    <td className={td}>{money(withTax(totals.spent, gst), currency)}</td>
                    <td className={td}>
                      <Ratio
                        revenue={totals.revenue}
                        spent={totals.spent}
                        complete={totals.cost_complete}
                      />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Phone and tablet: the same rows as cards. */}
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0 lg:hidden">
              {active.map((row) => {
                const key = `${row.source_type}-${row.source_id}`;
                const isOpen = Boolean(open[key]);
                const children = stepsFor(row);
                const cur = row.currency ?? currency;
                return (
                  <li key={key} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="m-0 font-semibold text-foreground">{row.name}</p>
                        <p className="m-0 mt-0.5 text-sm text-muted-foreground">
                          {row.source_type === "flow" ? "Automatic message" : "Campaign"}
                          {row.created_at ? `, made ${dayLabel(row.created_at)}` : ""}
                        </p>
                      </div>
                      <span className="tabular shrink-0 rounded-full bg-aiden-soft px-2.5 py-1 text-sm font-semibold text-aiden-deep">
                        {money(Number(row.revenue), cur)}
                      </span>
                    </div>
                    <dl className="m-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                      {[
                        ["Sent", n(row.messages_sent)],
                        ["Delivered", n(row.delivered)],
                        ["Read", n(row.read_count)],
                        ["Clicked", n(row.clicked)],
                        ["Orders", n(row.orders)],
                        ["Spent", money(Number(row.spent), cur)],
                        ["Incl. tax", money(withTax(Number(row.spent), gst), cur)],
                      ].map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="tabular m-0">{value}</dd>
                        </div>
                      ))}
                      <div className="col-span-2 flex justify-between gap-2 border-t border-line pt-2">
                        <dt className="text-muted-foreground">Per ₹1 spent</dt>
                        <dd className="m-0 text-right">
                          <Ratio
                            revenue={Number(row.revenue)}
                            spent={Number(row.spent)}
                            complete={row.cost_complete}
                          />
                        </dd>
                      </div>
                    </dl>
                    {children.length > 0 ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 px-2"
                          aria-expanded={isOpen}
                          onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                          )}
                          {isOpen ? "Hide" : "Show"} each message ({children.length})
                        </Button>
                        {isOpen ? (
                          <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                            {children.map((s) => (
                              <li
                                key={`${key}-${s.step_id ?? s.name}`}
                                className="rounded-xl bg-ground p-3 text-sm"
                              >
                                <p className="m-0 font-semibold text-foreground">
                                  {s.step_order ? `Message ${s.step_order}: ` : ""}
                                  {s.name}
                                </p>
                                <p className="m-0 mt-1 text-muted-foreground">
                                  {n(s.messages_sent)} sent, {n(s.read_count)} read, {n(s.orders)}{" "}
                                  orders. {money(Number(s.revenue), s.currency ?? currency)} in,{" "}
                                  {money(withTax(Number(s.spent), gst), s.currency ?? currency)}{" "}
                                  out.
                                </p>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </>
                    ) : null}
                  </li>
                );
              })}
              <li className="bg-ground p-4">
                <p className="m-0 font-semibold text-foreground">Everything together</p>
                <dl className="m-0 mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Revenue</dt>
                    <dd className="tabular m-0">{money(totals.revenue, currency)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Incl. tax</dt>
                    <dd className="tabular m-0">{money(withTax(totals.spent, gst), currency)}</dd>
                  </div>
                  <div className="col-span-2 flex justify-between gap-2 border-t border-line pt-2">
                    <dt className="text-muted-foreground">Per ₹1 spent</dt>
                    <dd className="m-0 text-right">
                      <Ratio
                        revenue={totals.revenue}
                        spent={totals.spent}
                        complete={totals.cost_complete}
                      />
                    </dd>
                  </div>
                </dl>
              </li>
            </ul>
          </>
        )}
      </section>

      {/* Linked vs unlinked revenue, from the same functions the Analytics tab uses. */}
      <AnalyticsRevenue summary={summary} sources={active} loading={loading} />
    </div>
  );
}
