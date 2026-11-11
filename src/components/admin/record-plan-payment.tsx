import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/whatsapp-client";
import { money } from "@/lib/billing";
import {
  PLAN_PAYMENT_METHODS,
  dayText,
  differenceText,
  paidNotice,
  planPaymentPanel,
  savedResultLines,
  type PlanPaymentPreview,
  type RecordPlanPaymentResult,
} from "@/lib/plan-payment";

/**
 * Batch 68: Super Admin "Record plan payment" — a plan fee paid by bank
 * transfer, UPI, cheque or cash (recordPlanPayment, plan-payment.server.ts).
 * The preview is always on screen before the save; the save raises or uses
 * the period's invoice, settles it and sends the paid invoice once.
 */

const indiaToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border/50 py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm text-foreground">{children}</span>
    </div>
  );
}

export function RecordPlanPayment({
  organizationId,
  onRecorded,
}: {
  organizationId: string;
  onRecorded?: () => void;
}) {
  const [periodStart, setPeriodStart] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(indiaToday());
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PlanPaymentPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Extract<RecordPlanPaymentResult, { ok: true }> | null>(null);
  const seq = useRef(0);

  const check = useCallback(
    async (values: { periodStart: string; amount: string; reference: string }) => {
      const mine = ++seq.current;
      setChecking(true);
      const { data, error } = await callApi<PlanPaymentPreview & { error?: string }>(
        "/api/admin/billing",
        {
          body: {
            action: "plan_payment_preview",
            organization_id: organizationId,
            period_start: values.periodStart || null,
            amount: values.amount.trim() ? Number(values.amount) : null,
            reference: values.reference.trim() || null,
          },
        },
      );
      if (mine !== seq.current) return;
      setChecking(false);
      if (error || data?.error || !data) {
        setPreview(null);
        setPreviewError(error ?? data?.error ?? "We couldn't work out this payment.");
        return;
      }
      setPreviewError(null);
      setPreview(data);
      if (!values.periodStart) setPeriodStart(data.default_period_start);
    },
    [organizationId],
  );

  // The preview follows what is typed (period, amount, reference).
  useEffect(() => {
    const t = setTimeout(
      () => void check({ periodStart, amount, reference }),
      periodStart ? 350 : 0,
    );
    return () => clearTimeout(t);
  }, [check, periodStart, amount, reference]);

  const amountOk = Number(amount) > 0;
  const blocked =
    !preview ||
    !amountOk ||
    !reference.trim() ||
    !paidOn ||
    checking ||
    (preview.invoice !== null &&
      preview.invoice.amount_paid + 0.01 >= preview.invoice.total &&
      !preview.already_recorded);

  async function save() {
    if (!preview) return;
    setSaving(true);
    const { data, error } = await callApi<RecordPlanPaymentResult>("/api/admin/billing", {
      body: {
        action: "record_plan_payment",
        organization_id: organizationId,
        period_start: preview.period.start,
        amount: Number(amount),
        method,
        reference: reference.trim(),
        paid_on: paidOn,
        note: note.trim() || null,
      },
    });
    setSaving(false);
    if (error || !data || "error" in data) {
      toast.error(error ?? (data && "error" in data ? data.error : null) ?? "That didn't work.");
      return;
    }
    setDone(data);
    toast.success(
      data.already
        ? "Already recorded: nothing changed."
        : `Recorded. Invoice ${data.invoice_number ?? ""} is ${data.invoice_status === "paid" ? "paid" : "part paid"}.`,
    );
    // Batch 69: the saved result stands on its own (planPaymentPanel shows it,
    // never the preview). The preview is refreshed underneath, so the moment
    // anything is changed the card says "This period is paid", not the
    // figures it had before the save.
    onRecorded?.();
    void check({ periodStart: preview.period.start, amount, reference });
  }

  /** Any change after a save starts a fresh preview. */
  const edit = (set: (value: string) => void) => (e: { target: { value: string } }) => {
    setDone(null);
    set(e.target.value);
  };

  const fig = preview?.figures;
  const panel = planPaymentPanel(preview, done);
  const diff = fig ? differenceText(fig, money) : null;

  return (
    <div className="space-y-4" data-testid="record-plan-payment">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rpp-period" className="text-xs font-medium text-muted-foreground">
            Period starts on
          </Label>
          <Input id="rpp-period" type="date" value={periodStart} onChange={edit(setPeriodStart)} />
          <p className="text-xs text-muted-foreground">
            Their next unpaid period is filled in. Change it if they paid for another month.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rpp-amount" className="text-xs font-medium text-muted-foreground">
            Amount received (Rs)
          </Label>
          <Input
            id="rpp-amount"
            inputMode="decimal"
            placeholder={fig ? String(fig.total) : ""}
            value={amount}
            onChange={edit(setAmount)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rpp-method" className="text-xs font-medium text-muted-foreground">
            How they paid
          </Label>
          <select
            id="rpp-method"
            value={method}
            onChange={edit(setMethod)}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
          >
            {PLAN_PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rpp-ref" className="text-xs font-medium text-muted-foreground">
            Reference
          </Label>
          <Input
            id="rpp-ref"
            placeholder="UTR, UPI or cheque number"
            value={reference}
            onChange={edit(setReference)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rpp-paid-on" className="text-xs font-medium text-muted-foreground">
            Paid on
          </Label>
          <Input
            id="rpp-paid-on"
            type="date"
            max={indiaToday()}
            value={paidOn}
            onChange={edit(setPaidOn)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="rpp-note" className="text-xs font-medium text-muted-foreground">
            Note (optional)
          </Label>
          <Textarea id="rpp-note" rows={2} value={note} onChange={edit(setNote)} />
        </div>
      </div>

      {previewError ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {previewError}
        </p>
      ) : null}

      {panel === "paid" && preview?.paid ? (
        <div
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
          data-testid="record-plan-payment-paid"
        >
          <p className="flex items-start gap-2 font-medium text-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            {paidNotice(preview.paid)}
          </p>
          <p className="mt-1 text-muted-foreground">
            {preview.plan_name}
            {preview.plan_version ? ` ${preview.plan_version}` : ""},{" "}
            {dayText(preview.period.start)} to {dayText(preview.period.end)}
            {preview.paid.method ? `, paid by ${preview.paid.method}` : ""}. Nothing to record: pick
            another period for a new payment.
          </p>
          {preview.paid.excess > 0 ? (
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              {money(preview.paid.excess)} received over the invoice is left unapplied (not added to
              the wallet).
            </p>
          ) : null}
          {preview.warnings.map((w) => (
            <p key={w} className="mt-2 flex items-start gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      ) : null}

      {panel === "preview" && preview && fig ? (
        <div
          className="rounded-xl border border-border/70 bg-muted/30 p-4"
          data-testid="record-plan-payment-preview"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Before you save
          </p>
          <Row label="Plan">
            {preview.plan_name}
            {preview.plan_version ? ` ${preview.plan_version}` : ""}
          </Row>
          <Row label="Period">
            {dayText(preview.period.start)} to {dayText(preview.period.end)}
          </Row>
          <Row label="Plan fee">
            {money(preview.plan_fee)}
            <span className="text-xs text-muted-foreground">
              {preview.fee_from === "override" ? " (this workspace's own fee)" : " (plan price)"}
            </span>
          </Row>
          <Row label="GST">
            {preview.gst_registered ? `${money(fig.gst)} (18%)` : "None: we're not GST-registered"}
          </Row>
          <Row label="Invoice total">
            {money(preview.invoice ? preview.invoice.total : fig.total)}
          </Row>
          {preview.invoice && preview.invoice.amount_paid > 0 ? (
            <Row label="Already paid on it">{money(preview.invoice.amount_paid)}</Row>
          ) : null}
          <Row label="Amount received">{amountOk ? money(Number(amount)) : "Enter the amount"}</Row>
          {amountOk && diff ? (
            <Row label="Difference">
              <span className="text-amber-700 dark:text-amber-300">{diff}</span>
            </Row>
          ) : null}
          <Row label="Invoice">
            {preview.invoice
              ? `Uses ${preview.invoice.invoice_number ?? "the draft invoice"} (${preview.invoice.status})`
              : "A new plan-fee invoice is raised (no payment link)"}
          </Row>
          <Row label="Next invoice">
            {dayText(preview.period.next_start)}
            {preview.new_billing_day !== preview.billing_day
              ? ` (billing day ${preview.billing_day} → ${preview.new_billing_day})`
              : ` (billing day ${preview.billing_day})`}
          </Row>
          <p className="mt-3 text-xs text-muted-foreground">
            Saving marks the invoice paid, sends them the paid invoice once and logs it. The plan,
            its features and the wallet stay exactly as they are.
          </p>

          {preview.already_recorded ? (
            <p className="mt-3 flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              Already recorded with reference {preview.already_recorded.reference}. Saving again
              changes nothing.
            </p>
          ) : null}
          {preview.warnings.map((w) => (
            <p
              key={w}
              className="mt-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {w}
            </p>
          ))}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button disabled={blocked || saving} onClick={() => void save()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Record plan payment
            </Button>
            {checking ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>
        </div>
      ) : null}

      {panel === "saved" && done ? (
        <div
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
          data-testid="record-plan-payment-done"
        >
          {savedResultLines(done, money).map((line, i, all) => (
            <p
              key={line}
              className={
                i === 0
                  ? "font-medium text-foreground"
                  : i === all.length - 1
                    ? "mt-1 text-muted-foreground"
                    : "mt-1 text-amber-700 dark:text-amber-300"
              }
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
