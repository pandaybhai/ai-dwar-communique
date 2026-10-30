import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Receipt, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { money } from "@/lib/billing";
import { gstSwitchBlock } from "@/lib/gst-mode";
import { callApi } from "@/lib/whatsapp-client";

type GstSettings = {
  gst_registered: boolean;
  supplier_gstin: string | null;
  supplier_pan: string | null;
  demo_values: boolean;
  column_ready: boolean;
};

type GstInvoice = {
  id: string;
  organization_name: string | null;
  invoice_number: string;
  purpose: string | null;
  status: string;
  issue_date: string | null;
  taxable_value: number;
  gst: number;
  total: number;
  amount_paid: number;
  blocked: string | null;
  reissued_as: string | null;
};

function day(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Batch 55: Super Admin > Billing > GST. The one switch that decides whether
 * AiDwar charges GST (off until Meezoy Ventures is registered), the supplier
 * GSTIN/PAN, and the past GST invoices with "Re-issue without GST" — one at a
 * time, each confirmed; nothing is re-issued on its own. Every save and every
 * re-issue is logged with the actor on the server.
 */
export function GstTab() {
  const [settings, setSettings] = useState<GstSettings | null>(null);
  const [registered, setRegistered] = useState(false);
  const [gstin, setGstin] = useState("");
  const [pan, setPan] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<GstInvoice[] | null>(null);
  const [confirmFor, setConfirmFor] = useState<GstInvoice | null>(null);
  const [reissuing, setReissuing] = useState(false);

  const load = useCallback(async () => {
    const [s, i] = await Promise.all([
      callApi<GstSettings>("/api/admin/billing", { body: { action: "gst_settings" } }),
      callApi<{ invoices: GstInvoice[] }>("/api/admin/billing", {
        body: { action: "gst_invoices" },
      }),
    ]);
    if (s.error || !s.data) {
      setError(s.error ?? "We couldn't load the GST settings.");
      return;
    }
    setError(null);
    setSettings(s.data);
    setRegistered(s.data.gst_registered);
    setGstin(s.data.demo_values ? "" : (s.data.supplier_gstin ?? ""));
    setPan(s.data.demo_values ? "" : (s.data.supplier_pan ?? ""));
    setInvoices(i.data?.invoices ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchBlock = registered ? gstSwitchBlock(gstin) : null;

  const save = async () => {
    setSaving(true);
    const { data, error: saveError } = await callApi<GstSettings>("/api/admin/billing", {
      body: {
        action: "save_gst_settings",
        gst_registered: registered,
        supplier_gstin: gstin || null,
        supplier_pan: pan || null,
      },
    });
    setSaving(false);
    if (saveError || !data) {
      toast.error(saveError ?? "The GST settings could not be saved.");
      return;
    }
    toast.success(
      data.gst_registered ? "GST is on: 18% is added from now." : "Saved — no GST is charged.",
    );
    await load();
  };

  const reissue = async () => {
    if (!confirmFor) return;
    setReissuing(true);
    const { data, error: reissueError } = await callApi<{
      credit_note: string;
      invoice_number: string;
      wallet_credit: number;
    }>("/api/admin/billing", {
      body: { action: "reissue_without_gst", invoice_id: confirmFor.id, confirmed: true },
    });
    setReissuing(false);
    if (reissueError || !data) {
      toast.error(reissueError ?? "The invoice couldn't be re-issued.");
      return;
    }
    toast.success(
      `Credit note ${data.credit_note}, new invoice ${data.invoice_number}, ${money(data.wallet_credit)} back to the wallet.`,
    );
    setConfirmFor(null);
    await load();
  };

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorState message={error} />
        <Button variant="outline" className="rounded-full" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!settings) return <TableSkeleton rows={4} />;

  const eligible = (invoices ?? []).filter((r) => !r.blocked);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-foreground">GST</h3>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {settings.gst_registered
                ? "AiDwar is GST-registered: 18% GST is added to plan fees and credit packs, and every invoice is a tax invoice with the GSTIN below."
                : "AiDwar is not GST-registered: plans, credit packs and payment links charge the price as it is, and invoices carry no GST and no GSTIN."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="gst-registered"
              checked={registered}
              onCheckedChange={setRegistered}
              aria-label="Charge GST"
            />
            <Label htmlFor="gst-registered">Charge GST (registered)</Label>
          </div>
        </div>

        <Alert variant="warning" className="mt-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Only switch this on after GST registration</AlertTitle>
          <AlertDescription>
            Charging GST without a registration is not allowed. Turn it on only once the
            registration certificate is in hand and its GSTIN is entered here. From that moment
            every new plan fee, credit pack and invoice adds 18% GST; payments already started keep
            the amount they were started with. Every change is logged with your name.
          </AlertDescription>
        </Alert>

        {settings.demo_values ? (
          <p className="mt-3 text-sm text-destructive">
            The stored GSTIN/PAN are the demo values (36AAACM0000D1Z5 / AAACM0000D). They are never
            printed; migration 20261290 clears them.
          </p>
        ) : null}
        {!settings.column_ready ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Migration 20261290 isn't applied yet, so GST stays off (no GST is charged) until it is.
          </p>
        ) : null}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="supplier-gstin">Supplier GSTIN</Label>
            <Input
              id="supplier-gstin"
              value={gstin}
              maxLength={15}
              placeholder="From the registration certificate"
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="supplier-pan">Supplier PAN (optional)</Label>
            <Input
              id="supplier-pan"
              value={pan}
              maxLength={10}
              placeholder="Printed on invoices when set"
              onChange={(e) => setPan(e.target.value.toUpperCase())}
            />
          </div>
        </div>
        {switchBlock ? <p className="mt-2 text-sm text-destructive">{switchBlock}</p> : null}
        <div className="mt-4 flex justify-end">
          <Button
            className="rounded-full"
            onClick={() => void save()}
            disabled={saving || Boolean(switchBlock)}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save GST settings
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="font-semibold text-foreground">Invoices issued with GST</h3>
            <p className="text-sm text-muted-foreground">
              {eligible.length === 0
                ? "None can be re-issued right now."
                : `${eligible.length} can be re-issued without GST. Nothing happens until you choose one.`}
            </p>
          </div>
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        </div>
        {!invoices || invoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No GST invoices"
            description="No invoice has ever charged GST."
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-border/70 bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Workspace</th>
                  <th className="px-3 py-2">For</th>
                  <th className="px-3 py-2 text-right">Base</th>
                  <th className="px-3 py-2 text-right">GST</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-border/60 align-top">
                    <td className="px-3 py-2 text-muted-foreground">{day(inv.issue_date)}</td>
                    <td className="px-3 py-2 font-medium">{inv.invoice_number}</td>
                    <td className="px-3 py-2">{inv.organization_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      {inv.purpose === "plan_fee"
                        ? "Plan fee"
                        : inv.purpose === "credit_purchase"
                          ? "Credits"
                          : inv.purpose}
                    </td>
                    <td className="px-3 py-2 text-right">{money(inv.taxable_value)}</td>
                    <td className="px-3 py-2 text-right">{money(inv.gst)}</td>
                    <td className="px-3 py-2 text-right font-medium">{money(inv.total)}</td>
                    <td className="px-3 py-2 text-right">
                      {inv.blocked ? (
                        <span className="text-xs text-muted-foreground">{inv.blocked}</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                          onClick={() => setConfirmFor(inv)}
                        >
                          Re-issue without GST
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={confirmFor !== null}
        onOpenChange={(open) => (!open && !reissuing ? setConfirmFor(null) : null)}
      >
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Re-issue {confirmFor?.invoice_number} without GST?</DialogTitle>
            <DialogDescription>
              For {confirmFor?.organization_name ?? "this workspace"}. This issues a credit note for
              the whole {money(confirmFor?.total ?? 0)}, a new invoice for{" "}
              {money(confirmFor?.taxable_value ?? 0)} with no GST (sent to the customer), and puts
              the {money(confirmFor?.gst ?? 0)} of GST back in their wallet as credits. It can't be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmFor(null)} disabled={reissuing}>
              Cancel
            </Button>
            <Button className="rounded-full" onClick={() => void reissue()} disabled={reissuing}>
              {reissuing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Re-issue without GST
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
