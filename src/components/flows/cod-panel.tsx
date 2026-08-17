import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, PackageCheck } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  COD_PERIODS,
  COD_STATUS_CLASSES,
  COD_STATUS_LABELS,
  confirmationRate,
  formatMoney,
  shopifyOrderUrl,
  summarise,
  type CodRow,
} from "@/lib/cod";
import { formatDateTime } from "@/lib/flows";

/**
 * What customers actually said about their cash-on-delivery orders.
 *
 * Only recorded answers are reported — no projected return rate, no claimed
 * savings. Cancellations are recorded in AiDwar only, which the "Action needed"
 * list says out loud, because AiDwar cannot change anything in Shopify.
 */
export function CodPanel({
  organizationId,
  timezone,
}: {
  organizationId: string;
  timezone: string;
}) {
  const [days, setDays] = useState("30");
  const [rows, setRows] = useState<CodRow[] | null>(null);
  const [shops, setShops] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    const since = new Date(Date.now() - Number(days) * 24 * 3600_000).toISOString();
    const [codRes, intRes] = await Promise.all([
      aidwar
        .from("cod_confirmations")
        .select(
          "id, order_id, status, asked_at, responded_at, created_at, orders(order_number, total, currency, external_id, integration_id), contacts(name, phone)",
        )
        .eq("organization_id", organizationId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500),
      aidwar
        .from("integrations")
        .select("id, shop_domain")
        .eq("organization_id", organizationId),
    ]);

    if (codRes.error) {
      setError("We couldn't load your cash-on-delivery answers. Please try again.");
      setRows([]);
      return;
    }
    setRows((codRes.data as unknown as CodRow[]) ?? []);
    const map: Record<string, string> = {};
    for (const row of ((intRes.data as { id: string; shop_domain: string }[]) ?? [])) {
      map[row.id] = row.shop_domain;
    }
    setShops(map);
  }, [organizationId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => summarise(rows ?? []), [rows]);
  const rate = confirmationRate(totals);
  const actionNeeded = useMemo(
    () => (rows ?? []).filter((r) => r.status === "cancelled" || r.status === "no_response"),
    [rows],
  );

  if (error) return <ErrorState message={error} />;

  return (
    <section
      aria-labelledby="cod-heading"
      className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="cod-heading" className="text-lg font-semibold text-foreground">
            Cash-on-delivery answers
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            We ask every cash-on-delivery customer on WhatsApp to confirm before you ship. Below is
            exactly what they answered — nothing is estimated.
          </p>
        </div>
        <div className="w-full sm:w-48">
          <Label htmlFor="cod-period" className="text-xs text-muted-foreground">
            Period
          </Label>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger id="cod-period" className="mt-1 min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COD_PERIODS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {rows === null ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cash-on-delivery orders we asked about" value={totals.asked} />
            <Stat label="Customers who confirmed" value={totals.confirmed} />
            <Stat label="Orders customers told us not to ship" value={totals.cancelled} />
            <Stat label="Orders nobody answered" value={totals.noResponse} />
          </dl>

          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label="Confirmed out of everyone asked"
              value={rate === null ? "—" : `${rate}%`}
            />
            <Stat
              label="Value you didn't ship — customers said no"
              value={formatMoney(totals.cancelledValue, totals.currency)}
            />
            <Stat
              label="Value you didn't ship — nobody answered"
              value={formatMoney(totals.noResponseValue, totals.currency)}
            />
          </dl>

          <div className="mt-6">
            <h3 className="text-sm font-semibold text-foreground">Action needed</h3>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              These answers are recorded in AiDwar only. Your Shopify orders are unchanged — open
              each one in Shopify to cancel or hold it yourself.
            </p>

            {actionNeeded.length === 0 ? (
              <div className="mt-3">
                <EmptyState
                  icon={PackageCheck}
                  title="Nothing waiting on you"
                  description="No customer has asked you to hold a cash-on-delivery order in this period."
                />
              </div>
            ) : (
              <ul className="mt-3 list-none space-y-3 p-0">
                {actionNeeded.map((row) => {
                  const url = shopifyOrderUrl(
                    row.orders?.integration_id ? shops[row.orders.integration_id] : null,
                    row.orders?.external_id,
                  );
                  return (
                    <li
                      key={row.id}
                      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-foreground">
                            Order {row.orders?.order_number ?? "—"}
                          </p>
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${COD_STATUS_CLASSES[row.status]}`}
                          >
                            {COD_STATUS_LABELS[row.status]}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {row.contacts?.name?.trim() || row.contacts?.phone || "Unknown customer"}
                          {" · "}
                          {formatMoney(Number(row.orders?.total ?? 0) || 0, row.orders?.currency ?? null)}
                          {" · "}
                          {formatDateTime(row.responded_at ?? row.created_at, timezone)}
                        </p>
                      </div>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          Open in Shopify
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">
                            order {row.orders?.order_number ?? ""} (opens in a new tab)
                          </span>
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <dd className="text-xl font-bold tracking-tight text-foreground">{value}</dd>
      <dt className="mt-0.5 text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}
