import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Loader2, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { money } from "@/lib/billing";
import { callApi } from "@/lib/whatsapp-client";

type InvoiceRow = {
  id: string;
  invoice_number: string | null;
  kind: string;
  purpose: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  total: number;
  amount_paid: number;
  currency: string;
  pdf_path: string | null;
  roi_snapshot: { attributed_revenue?: number; total_cost?: number } | null;
};

type AutoPay = {
  enabled: boolean;
  status: string | null;
  cycle: string | null;
  next_charge_at: string | null;
  cancel_at_period_end: boolean;
  short_url: string | null;
};

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  issued: { label: "Due", tone: "bg-amber-100 text-amber-800" },
  paid: { label: "Paid", tone: "bg-emerald-100 text-emerald-800" },
  partially_paid: { label: "Part paid", tone: "bg-amber-100 text-amber-800" },
  void: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
};

const KIND_COPY: Record<string, string> = {
  tax_invoice: "Tax invoice",
  proforma: "Proforma",
  credit_note: "Credit note",
};

function day(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function InvoicesPanel({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [autopay, setAutopay] = useState<AutoPay | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await callApi<{ invoices: InvoiceRow[]; autopay: AutoPay }>(
      `/api/billing/invoices?organization_id=${organizationId}`,
      { method: "GET" },
    );
    setLoading(false);
    if (error || !data) {
      setFailed(error ?? "We couldn't load your invoices just now.");
      return;
    }
    setFailed(null);
    setInvoices(data.invoices);
    setAutopay(data.autopay);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async (invoice: InvoiceRow) => {
    setBusy(invoice.id);
    const { data, error } = await callApi<{ url: string }>("/api/billing/invoices", {
      method: "POST",
      body: { organization_id: organizationId, action: "download", invoice_id: invoice.id },
    });
    setBusy(null);
    if (error || !data?.url) {
      toast.error(error ?? "We couldn't open that invoice. Please try again.");
      return;
    }
    window.open(data.url, "_blank", "noopener");
  };

  const setupAutoPay = async () => {
    setBusy("autopay");
    const { data, error } = await callApi<{ url: string }>("/api/billing/invoices", {
      method: "POST",
      body: { organization_id: organizationId, action: "autopay_setup", cycle: "monthly" },
    });
    setBusy(null);
    if (error || !data?.url) {
      toast.error(error ?? "We couldn't set up auto-pay. Please try again.");
      return;
    }
    window.location.href = data.url;
  };

  const cancelAutoPay = async () => {
    setBusy("autopay");
    const { error } = await callApi("/api/billing/invoices", {
      method: "POST",
      body: { organization_id: organizationId, action: "autopay_cancel" },
    });
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Auto-pay will stop at the end of this billing period.");
    void load();
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Auto-pay
          </CardTitle>
          {autopay?.enabled ? (
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">On</Badge>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {autopay?.enabled ? (
            <>
              <p className="text-sm text-muted-foreground">
                Your plan fee is paid automatically
                {autopay.next_charge_at ? `, next on ${day(autopay.next_charge_at)}` : ""}. You'll
                get an invoice every time it runs.
                {autopay.cancel_at_period_end
                  ? " It's set to stop at the end of this period."
                  : ""}
              </p>
              {can("billing.pay") && !autopay.cancel_at_period_end ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={busy === "autopay"}
                  onClick={() => void cancelAutoPay()}
                >
                  {busy === "autopay" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Turn off auto-pay
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Set up auto-pay once and your monthly plan fee is taken care of — no missed
                payments, no paused campaigns. You can turn it off any time.
              </p>
              {can("billing.pay") ? (
                <Button
                  size="sm"
                  className="rounded-full"
                  disabled={busy === "autopay"}
                  onClick={() => void setupAutoPay()}
                >
                  {busy === "autopay" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Set up auto-pay
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Ask an owner or admin to set this up — it needs the "Pay" permission.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {failed ? (
            <EmptyState
              icon={FileText}
              title="We couldn't load your invoices"
              description={failed}
              action={
                <Button variant="outline" className="rounded-full" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          ) : invoices.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description="Every payment and plan fee gets a GST invoice here, ready to download."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2">Date</th>
                    <th className="py-2">Invoice</th>
                    <th className="py-2">For</th>
                    <th className="py-2">Status</th>
                    <th className="py-2 text-right">Amount</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => {
                    const status = STATUS_COPY[invoice.status] ?? {
                      label: invoice.status,
                      tone: "bg-muted text-muted-foreground",
                    };
                    const roi = invoice.roi_snapshot;
                    return (
                      <tr key={invoice.id} className="border-t align-top">
                        <td className="py-3 text-muted-foreground">{day(invoice.issue_date)}</td>
                        <td className="py-3">
                          <div className="font-medium">{invoice.invoice_number ?? "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {KIND_COPY[invoice.kind] ?? invoice.kind}
                          </div>
                        </td>
                        <td className="py-3">
                          <div>
                            {invoice.purpose === "plan_fee"
                              ? "Plan fee"
                              : invoice.purpose === "credit_purchase"
                                ? "Credits"
                                : invoice.purpose}
                          </div>
                          {invoice.period_start ? (
                            <div className="text-xs text-muted-foreground">
                              {day(invoice.period_start)} – {day(invoice.period_end)}
                            </div>
                          ) : null}
                          {roi && Number(roi.attributed_revenue ?? 0) > 0 ? (
                            <div className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-700">
                              <TrendingUp className="h-3 w-3" />
                              {money(Number(roi.attributed_revenue), invoice.currency)} earned this
                              period
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}
                          >
                            {status.label}
                          </span>
                          {invoice.status === "issued" && invoice.due_date ? (
                            <div className="mt-1 text-xs text-muted-foreground">
                              Due {day(invoice.due_date)}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3 text-right font-medium">
                          {money(Number(invoice.total), invoice.currency)}
                        </td>
                        <td className="py-3 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full"
                            disabled={busy === invoice.id}
                            onClick={() => void download(invoice)}
                          >
                            {busy === invoice.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                            <span className="sr-only">Download invoice</span>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
