import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Loader2, RefreshCw, Send, Receipt } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/billing";
import { callApi } from "@/lib/whatsapp-client";

type AdminInvoice = {
  id: string;
  organization_id: string;
  organization_name: string | null;
  invoice_number: string | null;
  kind: string;
  purpose: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  amount_paid: number;
  currency: string;
  pdf_path: string | null;
  pay_url: string | null;
  whatsapp_at: string | null;
  pdf_error: string | null;
  payment_id: string | null;
};

type Reconciliation = {
  payments_without_invoice: {
    id: string;
    organization_name: string | null;
    purpose: string;
    amount: number;
    paid_at: string | null;
  }[];
  invoices_without_payment: {
    id: string;
    organization_name: string | null;
    invoice_number: string | null;
    purpose: string;
    status: string;
    total: number;
    due_date: string | null;
  }[];
};

const STATUS: Record<string, string> = {
  issued: "bg-amber-100 text-amber-800",
  partially_paid: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  void: "bg-muted text-muted-foreground",
  draft: "bg-muted text-muted-foreground",
};

function day(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function InvoicesTab() {
  const [rows, setRows] = useState<AdminInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [purpose, setPurpose] = useState("");
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [creditFor, setCreditFor] = useState<AdminInvoice | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [reconLoading, setReconLoading] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await callApi<{ invoices: AdminInvoice[] }>("/api/admin/billing", {
      body: { action: "invoices", status, purpose, month, search },
    });
    if (error || !data) {
      setError(error ?? "We couldn't load invoices.");
      return;
    }
    setError(null);
    setRows(data.invoices);
  }, [status, purpose, month, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRecon = async () => {
    setReconLoading(true);
    const { data, error } = await callApi<Reconciliation>("/api/admin/billing", {
      body: { action: "invoice_reconciliation" },
    });
    setReconLoading(false);
    if (error || !data) {
      toast.error(error ?? "We couldn't run the reconciliation.");
      return;
    }
    setRecon(data);
  };

  const act = async (
    key: string,
    body: Record<string, unknown>,
    onOk: (data: Record<string, unknown>) => void,
  ) => {
    setBusy(key);
    const { data, error } = await callApi<Record<string, unknown>>("/api/admin/billing", { body });
    setBusy(null);
    if (error || !data) {
      toast.error(error ?? "That didn't work. Please try again.");
      return;
    }
    onOk(data);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="inv-status" className="text-xs text-muted-foreground">
            Status
          </Label>
          <select
            id="inv-status"
            className="mt-1 h-9 rounded-lg border border-input bg-background px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            <option value="issued">Due</option>
            <option value="partially_paid">Part paid</option>
            <option value="paid">Paid</option>
            <option value="void">Cancelled</option>
            <option value="draft">Draft</option>
          </select>
        </div>
        <div>
          <Label htmlFor="inv-purpose" className="text-xs text-muted-foreground">
            For
          </Label>
          <select
            id="inv-purpose"
            className="mt-1 h-9 rounded-lg border border-input bg-background px-2 text-sm"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          >
            <option value="">All</option>
            <option value="plan_fee">Plan fee</option>
            <option value="credit_purchase">Credits</option>
          </select>
        </div>
        <div>
          <Label htmlFor="inv-month" className="text-xs text-muted-foreground">
            Month
          </Label>
          <Input
            id="inv-month"
            type="month"
            className="mt-1 h-9 w-[160px]"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="inv-search" className="text-xs text-muted-foreground">
            Invoice no.
          </Label>
          <Input
            id="inv-search"
            placeholder="AD/2026-27/…"
            className="mt-1 h-9 w-[200px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={busy === "backfill"}
          onClick={() =>
            void act("backfill", { action: "issue_pending_invoices" }, (d) => {
              const issued = (d["issued"] as string[]) ?? [];
              const pdfs = (d["pdfs_regenerated"] as string[]) ?? [];
              toast.success(
                `${issued.length} issued, ${pdfs.length} PDFs regenerated${
                  ((d["failed"] as unknown[]) ?? []).length ? ", some failed — see reconciliation" : ""
                }.`,
              );
              void load();
            })
          }
        >
          {busy === "backfill" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Issue pending
        </Button>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {rows === null ? (
        <TableSkeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No invoices match"
          description="Loosen the filters, or issue pending invoices to raise any that are missing."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="border-b border-border/70 bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Workspace</th>
                <th className="px-3 py-2">For</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Taxable</th>
                <th className="px-3 py-2 text-right">GST</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Sent</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const gst = Number(inv.cgst) + Number(inv.sgst) + Number(inv.igst);
                const canCredit = inv.kind === "tax_invoice" && inv.invoice_number && inv.status !== "void" && inv.status !== "draft";
                return (
                  <tr key={inv.id} className="border-t border-border/60 align-top">
                    <td className="px-3 py-2 text-muted-foreground">{day(inv.issue_date)}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{inv.invoice_number ?? "Draft"}</div>
                      {inv.pdf_error ? (
                        <div className="text-xs text-destructive">PDF: {inv.pdf_error}</div>
                      ) : !inv.pdf_path ? (
                        <div className="text-xs text-muted-foreground">No PDF yet</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{inv.organization_name ?? "—"}</td>
                    <td className="px-3 py-2">{inv.purpose === "plan_fee" ? "Plan fee" : inv.purpose === "credit_purchase" ? "Credits" : inv.purpose}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[inv.status] ?? "bg-muted"}`}>
                        {inv.status.replace("_", " ")}
                      </span>
                      {inv.status === "issued" && inv.due_date ? (
                        <div className="mt-1 text-xs text-muted-foreground">Due {day(inv.due_date)}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{money(Number(inv.taxable_value), inv.currency)}</td>
                    <td className="px-3 py-2 text-right">
                      {money(gst, inv.currency)}
                      <div className="text-xs text-muted-foreground">{Number(inv.igst) > 0 ? "IGST" : gst > 0 ? "CGST+SGST" : "nil"}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{money(Number(inv.total), inv.currency)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{inv.whatsapp_at ? day(inv.whatsapp_at) : "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full"
                          title="Download PDF"
                          disabled={busy === `pdf:${inv.id}` || !inv.invoice_number}
                          onClick={() =>
                            void act(`pdf:${inv.id}`, { action: "invoice_pdf_url", invoice_id: inv.id }, (d) =>
                              window.open(String(d["url"]), "_blank", "noopener"),
                            )
                          }
                        >
                          {busy === `pdf:${inv.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full"
                          title="Regenerate PDF"
                          disabled={busy === `regen:${inv.id}` || !inv.invoice_number}
                          onClick={() =>
                            void act(`regen:${inv.id}`, { action: "regenerate_invoice_pdf", invoice_id: inv.id }, () => {
                              toast.success("PDF regenerated.");
                              void load();
                            })
                          }
                        >
                          {busy === `regen:${inv.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full"
                          title="Resend on WhatsApp"
                          disabled={busy === `send:${inv.id}` || !inv.invoice_number || inv.status === "void"}
                          onClick={() =>
                            void act(`send:${inv.id}`, { action: "resend_invoice", invoice_id: inv.id }, () => {
                              toast.success("Invoice sent.");
                              void load();
                            })
                          }
                        >
                          {busy === `send:${inv.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full"
                          title="Issue credit note"
                          disabled={!canCredit}
                          onClick={() => setCreditFor(inv)}
                        >
                          <Receipt className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">Reconciliation</h3>
            <p className="text-sm text-muted-foreground">
              Money received with no tax invoice, and invoices with no money against them.
            </p>
          </div>
          <Button variant="outline" size="sm" className="rounded-full" disabled={reconLoading} onClick={() => void loadRecon()}>
            {reconLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {recon ? "Refresh" : "Run check"}
          </Button>
        </div>
        {recon ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium">Payments without invoice ({recon.payments_without_invoice.length})</h4>
              {recon.payments_without_invoice.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">Every paid payment has its invoice.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {recon.payments_without_invoice.map((p) => (
                    <li key={p.id} className="flex justify-between gap-2 border-t py-1">
                      <span>{p.organization_name ?? "—"} · {p.purpose === "plan_fee" ? "Plan fee" : "Credits"} · {day(p.paid_at)}</span>
                      <span className="font-medium">{money(Number(p.amount))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className="text-sm font-medium">Invoices without payment ({recon.invoices_without_payment.length})</h4>
              {recon.invoices_without_payment.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">Nothing outstanding without a payment trail.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {recon.invoices_without_payment.map((i) => (
                    <li key={i.id} className="flex justify-between gap-2 border-t py-1">
                      <span>{i.organization_name ?? "—"} · {i.invoice_number ?? "Draft"} · {i.status.replace("_", " ")}{i.due_date ? ` · due ${day(i.due_date)}` : ""}</span>
                      <span className="font-medium">{money(Number(i.total))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </section>

      <CreditNoteDialog
        invoice={creditFor}
        onClose={() => setCreditFor(null)}
        onIssued={() => {
          setCreditFor(null);
          void load();
        }}
      />
    </div>
  );
}

function CreditNoteDialog({
  invoice,
  onClose,
  onIssued,
}: {
  invoice: AdminInvoice | null;
  onClose: () => void;
  onIssued: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (invoice) {
      setAmount(String(invoice.total));
      setReason("");
      setRefund(true);
    }
  }, [invoice]);

  const submit = async () => {
    if (!invoice) return;
    setSaving(true);
    const { data, error } = await callApi<{ number: string; refunded: boolean }>("/api/admin/billing", {
      body: {
        action: "issue_credit_note",
        invoice_id: invoice.id,
        amount: Number(amount),
        reason,
        refund_to_wallet: refund,
      },
    });
    setSaving(false);
    if (error || !data) {
      toast.error(error ?? "We couldn't issue the credit note.");
      return;
    }
    toast.success(`Credit note ${data.number} issued${data.refunded ? " and credited to the wallet" : ""}.`);
    onIssued();
  };

  return (
    <Dialog open={Boolean(invoice)} onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="rounded-2xl">
        <DialogHeader>
          <DialogTitle>Issue credit note</DialogTitle>
          <DialogDescription>
            Against {invoice?.invoice_number} for {invoice?.organization_name ?? "this workspace"}. GST is split
            the same way as the invoice; the refund goes to the wallet ledger, never a card.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="cn-amount">Amount (incl. GST)</Label>
            <Input id="cn-amount" type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">
              Up to {invoice ? money(Number(invoice.total), invoice.currency) : "—"}.
            </p>
          </div>
          <div>
            <Label htmlFor="cn-reason">Reason</Label>
            <Textarea id="cn-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this credit is being issued — it prints on the note." />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
            <span>Credit the amount to the workspace wallet</span>
            <Switch checked={refund} onCheckedChange={setRefund} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={() => void submit()} disabled={saving || !reason.trim() || !(Number(amount) > 0)}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Issue credit note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
