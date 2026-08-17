import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, IndianRupee, Megaphone, RefreshCw, Workflow } from "lucide-react";
import { AnalyticsRevenue } from "@/components/analytics/analytics-revenue";
import { ErrorState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
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

/**
 * Receipts — what each campaign and flow earned, and what it cost.
 *
 * Every number here comes from the same reporting functions the Analytics page
 * uses; nothing is aggregated in the browser except the totals row. Where a
 * message hasn't reported a billable status yet, the ratio is greyed and
 * labelled rather than shown as if it were final.
 */

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

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
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const withTax = (spent: number, gst: number) => spent * (1 + gst / 100);

type Totals = {
  messages_sent: number;
  delivered: number;
  read_count: number;
  clicked: number;
  orders: number;
  revenue: number;
  spent: number;
  cost_complete: boolean;
};

function sumRows(rows: AttributionSourceRow[]): Totals {
  return rows.reduce<Totals>(
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

/** Revenue per rupee spent — greyed and labelled when the cost isn't final. */
function Ratio({
  revenue,
  spent,
  complete,
}: {
  revenue: number;
  spent: number;
  complete: boolean;
}) {
  if (spent <= 0) {
    return (
      <span className="text-muted-foreground" title="Nothing billable yet">
        —
      </span>
    );
  }
  const value = revenue / spent;
  const text = `₹${value.toFixed(value >= 10 ? 0 : 1)} back per ₹1`;
  if (!complete) {
    return (
      <span className="text-muted-foreground">
        <span className="line-through decoration-muted-foreground/60">{text}</span>
        <span className="mt-0.5 block text-xs">Cost data incomplete</span>
      </span>
    );
  }
  return <span className="font-medium text-foreground">{text}</span>;
}

export function ReceiptsView({
  organizationId,
  timezone,
}: {
  organizationId: string;
  timezone: string;
}) {
  const [days, setDays] = useState(30);
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
    const label = RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`;
    const period: Period = periodForDays(timezone, days, label);
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
  }, [organizationId, timezone, days, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(
    () => rows.filter((r) => Number(r.messages_sent) > 0 || Number(r.orders) > 0),
    [rows],
  );
  const totals = useMemo(() => sumRows(active), [active]);
  const currency = summary?.currency ?? active[0]?.currency ?? "INR";
  const stepsFor = (row: AttributionSourceRow) =>
    steps.filter((s) => s.source_id === row.source_id && s.source_type === row.source_type);

  if (error) return <ErrorState description={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-44 rounded-full" aria-label="Time period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.days} value={String(r.days)}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {multiple ? (
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="w-56 rounded-full" aria-label="WhatsApp number">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All numbers</SelectItem>
              {numbers.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {numberLabel(n)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <section
        aria-labelledby="receipts-table-heading"
        className="rounded-2xl border border-border/70 bg-card shadow-sm"
      >
        <div className="border-b border-border/60 p-5 sm:p-6">
          <h2 id="receipts-table-heading" className="text-base font-semibold text-foreground">
            Every campaign and flow, side by side
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            What you sent, what people did with it, and what Meta charged you. Tax is added at{" "}
            {gst}% — change that in Settings. Open a row to see each message inside it.
          </p>
        </div>

        {loading ? (
          <div className="space-y-3 p-5 sm:p-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : active.length === 0 ? (
          <div className="p-10 text-center">
            <IndianRupee className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 font-medium text-foreground">Nothing sent in this period</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Send a campaign or switch on a flow, and its earnings and costs will appear here.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop: a real table, keyboard reachable, with proper headers. */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Sales and message costs for each campaign and flow in the selected period
                </caption>
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Created
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Sent
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Delivered
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Read
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Clicked
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Orders
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Revenue
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Spent
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Spent incl. tax
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Revenue per ₹1 spent
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
                      <>
                        <tr key={key} className="border-b border-border/50 align-top">
                          <th scope="row" className="px-4 py-3 text-left font-normal">
                            <button
                              type="button"
                              className="flex items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-expanded={isOpen}
                              onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                            >
                              {isOpen ? (
                                <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                              )}
                              <span>
                                <span className="font-medium text-foreground">{row.name}</span>
                                <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                                  {row.source_type === "flow" ? "Automatic message" : "Campaign"}
                                  {children.length > 0
                                    ? ` · ${children.length} message${children.length === 1 ? "" : "s"}`
                                    : ""}
                                </span>
                              </span>
                            </button>
                          </th>
                          <td className="px-4 py-3 text-muted-foreground">
                            {dayLabel(row.created_at)}
                          </td>
                          <td className="px-4 py-3 text-right">{Number(row.messages_sent).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{Number(row.delivered).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{Number(row.read_count).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{Number(row.clicked).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{Number(row.orders).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-medium">
                            {money(Number(row.revenue), cur)}
                          </td>
                          <td className="px-4 py-3 text-right">{money(Number(row.spent), cur)}</td>
                          <td className="px-4 py-3 text-right">
                            {money(withTax(Number(row.spent), gst), cur)}
                          </td>
                          <td className="px-4 py-3 text-right">
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
                                className="border-b border-border/40 bg-muted/30 text-xs"
                              >
                                <th scope="row" className="px-4 py-2 pl-12 text-left font-normal">
                                  {s.step_order ? `Message ${s.step_order}: ` : ""}
                                  {s.name}
                                </th>
                                <td className="px-4 py-2" />
                                <td className="px-4 py-2 text-right">{Number(s.messages_sent).toLocaleString()}</td>
                                <td className="px-4 py-2 text-right">{Number(s.delivered).toLocaleString()}</td>
                                <td className="px-4 py-2 text-right">{Number(s.read_count).toLocaleString()}</td>
                                <td className="px-4 py-2 text-right">{Number(s.clicked).toLocaleString()}</td>
                                <td className="px-4 py-2 text-right">{Number(s.orders).toLocaleString()}</td>
                                <td className="px-4 py-2 text-right">
                                  {money(Number(s.revenue), s.currency ?? currency)}
                                </td>
                                <td className="px-4 py-2 text-right">
                                  {money(Number(s.spent), s.currency ?? currency)}
                                </td>
                                <td className="px-4 py-2 text-right">
                                  {money(withTax(Number(s.spent), gst), s.currency ?? currency)}
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <Ratio
                                    revenue={Number(s.revenue)}
                                    spent={Number(s.spent)}
                                    complete={s.cost_complete}
                                  />
                                </td>
                              </tr>
                            ))
                          : null}
                      </>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/40 font-medium">
                    <th scope="row" className="px-4 py-3 text-left">
                      Everything together
                    </th>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right">{totals.messages_sent.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{totals.delivered.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{totals.read_count.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{totals.clicked.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{totals.orders.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{money(totals.revenue, currency)}</td>
                    <td className="px-4 py-3 text-right">{money(totals.spent, currency)}</td>
                    <td className="px-4 py-3 text-right">
                      {money(withTax(totals.spent, gst), currency)}
                    </td>
                    <td className="px-4 py-3 text-right">
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

            {/* Mobile: the same rows as cards. */}
            <ul className="divide-y divide-border/60 lg:hidden">
              {active.map((row) => {
                const key = `${row.source_type}-${row.source_id}`;
                const isOpen = Boolean(open[key]);
                const children = stepsFor(row);
                const cur = row.currency ?? currency;
                return (
                  <li key={key} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-foreground">{row.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.source_type === "flow" ? "Automatic message" : "Campaign"} · created{" "}
                          {dayLabel(row.created_at)}
                        </p>
                      </div>
                      <Badge variant="outline">{money(Number(row.revenue), cur)}</Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Sent</dt>
                        <dd>{Number(row.messages_sent).toLocaleString()}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Delivered</dt>
                        <dd>{Number(row.delivered).toLocaleString()}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Read</dt>
                        <dd>{Number(row.read_count).toLocaleString()}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Clicked</dt>
                        <dd>{Number(row.clicked).toLocaleString()}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Orders</dt>
                        <dd>{Number(row.orders).toLocaleString()}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Spent</dt>
                        <dd>{money(Number(row.spent), cur)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Spent incl. tax</dt>
                        <dd>{money(withTax(Number(row.spent), gst), cur)}</dd>
                      </div>
                      <div className="col-span-2 flex justify-between border-t border-border/60 pt-2">
                        <dt className="text-muted-foreground">Revenue per ₹1 spent</dt>
                        <dd>
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
                          className="mt-3 rounded-full px-2"
                          aria-expanded={isOpen}
                          onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                        >
                          {isOpen ? (
                            <ChevronDown className="mr-1 h-4 w-4" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="mr-1 h-4 w-4" aria-hidden="true" />
                          )}
                          {isOpen ? "Hide" : "Show"} each message ({children.length})
                        </Button>
                        {isOpen ? (
                          <ul className="mt-2 space-y-2">
                            {children.map((s) => (
                              <li
                                key={`${key}-${s.step_id ?? s.name}`}
                                className="rounded-lg bg-muted/40 p-3 text-xs"
                              >
                                <p className="font-medium text-foreground">
                                  {s.step_order ? `Message ${s.step_order}: ` : ""}
                                  {s.name}
                                </p>
                                <p className="mt-1 text-muted-foreground">
                                  {Number(s.messages_sent).toLocaleString()} sent ·{" "}
                                  {Number(s.read_count).toLocaleString()} read ·{" "}
                                  {Number(s.orders).toLocaleString()} orders ·{" "}
                                  {money(Number(s.revenue), s.currency ?? currency)} in ·{" "}
                                  {money(withTax(Number(s.spent), gst), s.currency ?? currency)} out
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

              <li className="bg-muted/40 p-4">
                <p className="font-medium text-foreground">Everything together</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Revenue</dt>
                    <dd>{money(totals.revenue, currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Spent incl. tax</dt>
                    <dd>{money(withTax(totals.spent, gst), currency)}</dd>
                  </div>
                  <div className="col-span-2 flex justify-between border-t border-border/60 pt-2">
                    <dt className="text-muted-foreground">Revenue per ₹1 spent</dt>
                    <dd>
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
