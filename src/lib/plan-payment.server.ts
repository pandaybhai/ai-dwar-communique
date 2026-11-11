import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";
import { chargeFor } from "@/lib/gst-mode";
import {
  billingDayFor,
  defaultPeriodStart,
  isDateOnly,
  isPlanPaymentMethod,
  methodLabel,
  planPaymentFigures,
  planPeriod,
  type PlanFeeInvoiceRow,
  type PlanPaymentPreview,
  type RecordPlanPaymentResult,
} from "@/lib/plan-payment";

export type { PlanPaymentPreview, RecordPlanPaymentResult };

/**
 * Batch 68: "Record plan payment" — a plan fee the workspace paid outside the
 * gateway (bank transfer, UPI, cheque, cash), recorded by a Super Admin.
 *
 * Nothing here is a second billing path. In order:
 *   1. the period's plan-fee invoice: the one already there (not void), else
 *      raisePlanFeeInvoice — the same build and numbering invoicePlanFee uses
 *      (plan line + statement lines), just without a payment link;
 *   2. a payments row (provider 'manual', purpose 'plan_fee') settled through
 *      settlePayment's existing plan_fee + invoice_id branch, so markPaid
 *      pays the invoice and lifts dunning (past_due / paused / locked →
 *      active through restoreAfterPayment). Nothing goes to the wallet; money
 *      beyond the invoice is left unapplied on the payment and shown;
 *   3. organizations.billing_day = the period's day (≤ 28), so runPlanBilling
 *      invoices the next period on its date;
 *   4. the paid invoice's PDF ("Paid via Bank transfer ref …") delivered once
 *      through deliverInvoice.
 * The same period and reference again does nothing new. Plan, features,
 * overrides, GST mode, rates and the wallet are never touched.
 */

type Input = {
  actorId: string;
  organizationId: string;
  periodStart?: string | null;
  amount?: number | null;
  reference?: string | null;
};

export const INTERNAL_REFUSAL =
  "This is an internal workspace (we don't bill it), so a plan payment can't be recorded for it. Switch \"Internal workspace\" off first if it should be billed.";

async function requireSuper(supabase: SupabaseClient, actorId: string): Promise<void> {
  const { PermissionError } = await import("@/lib/billing.server");
  const { data } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", actorId)
    .maybeSingle();
  if ((data as { is_super_admin?: boolean } | null)?.is_super_admin !== true) {
    throw new PermissionError("super_admin", "This is a platform-owner action.");
  }
}

/** Today's date in India (the period and "paid on" are India dates). */
export function indiaToday(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

const cleanRef = (v: unknown) =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 120) : "";

/** This workspace's recorded manual plan payments (raw kept server-side). */
async function manualPlanPayments(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("payments")
    .select("id, status, amount, raw, created_at")
    .eq("organization_id", organizationId)
    .eq("provider", "manual")
    .eq("purpose", "plan_fee")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`payments read failed: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

function sameRecording(row: Record<string, unknown>, periodStart: string, reference: string) {
  const raw = (row["raw"] ?? {}) as Record<string, unknown>;
  return (
    raw["period_start"] === periodStart &&
    String(raw["reference"] ?? "").toLowerCase() === reference.toLowerCase()
  );
}

/** This period's plan-fee invoices (not void), oldest first — invoicePlanFee's own lookup. */
async function periodInvoices(supabase: SupabaseClient, organizationId: string, start: string) {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, total, amount_paid, payment_id, sent, kind, created_at")
    .eq("organization_id", organizationId)
    .eq("purpose", "plan_fee")
    .eq("period_start", start)
    .neq("status", "void")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(2);
  if (error) throw new Error(`invoice read failed: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

/** An unpaid gateway payment (a Cashfree / Razorpay link) still open on this invoice. */
async function openGatewayLink(supabase: SupabaseClient, invoiceId: string): Promise<boolean> {
  const { data } = await supabase
    .from("payments")
    .select("id, provider, status, raw")
    .eq("purpose", "plan_fee")
    .in("status", ["created", "pending"])
    .limit(50);
  return ((data ?? []) as Record<string, unknown>[]).some(
    (p) =>
      p["provider"] !== "manual" &&
      ((p["raw"] ?? {}) as Record<string, unknown>)["invoice_id"] === invoiceId,
  );
}

/**
 * Everything the sheet shows before saving, and what the save works from.
 * Refusals come back as { error }.
 */
export async function planPaymentPreview(
  supabase: SupabaseClient,
  input: Input,
): Promise<PlanPaymentPreview | { error: string }> {
  await requireSuper(supabase, input.actorId);
  if (!input.organizationId) return { error: "Which workspace?" };

  const { isInternalWorkspace } = await import("@/lib/internal-workspace.server");
  if (await isInternalWorkspace(supabase, input.organizationId)) return { error: INTERNAL_REFUSAL };

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select(
      "id, name, plan_version_id, plan_status, trial_ends_at, billing_day, billing_enabled_at",
    )
    .eq("id", input.organizationId)
    .maybeSingle();
  if (orgError || !org) return { error: "We couldn't read this workspace." };
  if (!org["plan_version_id"]) {
    return { error: "This workspace has no plan. Assign the plan first, then record its payment." };
  }

  const [{ data: version }, { data: settings }] = await Promise.all([
    supabase
      .from("plan_versions")
      .select("*")
      .eq("id", org["plan_version_id"] as string)
      .maybeSingle(),
    supabase
      .from("organization_billing_settings")
      .select("plan_fee_override")
      .eq("organization_id", input.organizationId)
      .maybeSingle(),
  ]);
  // The same figure invoicePlanFee charges: the override, else the plan's price.
  const listed = version?.["price_monthly"] as number | null | undefined;
  const override = settings?.["plan_fee_override"] as number | null | undefined;
  const fee = override ?? (listed === null || listed === undefined ? null : Number(listed));
  if (fee === null || fee === undefined) return { error: "This plan has no monthly price." };
  if (!(Number(fee) > 0)) return { error: "This plan is free: there is no plan fee to record." };

  let planName = "Plan";
  const embedded = (version?.["plans"] ?? null) as Record<string, unknown> | null;
  if (embedded?.["name"]) planName = String(embedded["name"]);
  else if (version?.["plan_id"]) {
    const { data: plan } = await supabase
      .from("plans")
      .select("name")
      .eq("id", version["plan_id"] as string)
      .maybeSingle();
    if (plan?.["name"]) planName = String(plan["name"]);
  }
  const versionNo = version?.["version"] ?? version?.["version_number"] ?? null;

  const { loadGstRegistered } = await import("@/lib/gst-mode.server");
  const gstRegistered = await loadGstRegistered(supabase);
  if (gstRegistered === null) {
    return { error: "We couldn't read the GST setting just now. Try again in a minute." };
  }

  const billingDay = Number(org["billing_day"] ?? 1) || 1;
  const { data: allPlanInvoices, error: listError } = await supabase
    .from("invoices")
    .select("period_start, status, total, amount_paid")
    .eq("organization_id", input.organizationId)
    .eq("purpose", "plan_fee")
    .neq("status", "void")
    .limit(500);
  if (listError) return { error: "We couldn't read this workspace's invoices." };
  const defaultStart = defaultPeriodStart(
    (allPlanInvoices ?? []) as PlanFeeInvoiceRow[],
    billingDay,
    indiaToday(),
  );

  const start = input.periodStart ? input.periodStart : defaultStart;
  if (!isDateOnly(start)) return { error: "Enter the period start as a date." };
  const period = planPeriod(start);

  const [existing] = await periodInvoices(supabase, input.organizationId, start);
  const invoice = existing
    ? {
        id: String(existing["id"]),
        invoice_number: (existing["invoice_number"] as string | null) ?? null,
        status: String(existing["status"]),
        total: Number(existing["total"] ?? 0),
        amount_paid: Number(existing["amount_paid"] ?? 0),
        open_payment_link: await openGatewayLink(supabase, String(existing["id"])),
      }
    : null;

  const reference = cleanRef(input.reference);
  const recorded = reference
    ? (await manualPlanPayments(supabase, input.organizationId)).find((p) =>
        sameRecording(p, start, reference),
      )
    : undefined;

  // Without an amount yet, the sheet starts from what is owed.
  const owed = invoice ? round2(invoice.total - invoice.amount_paid) : null;
  const owedNow = owed ?? chargeFor(Number(fee), gstRegistered).total;
  const figures = planPaymentFigures({
    base: Number(fee),
    gstRegistered,
    received: Number(input.amount ?? 0) > 0 ? Number(input.amount) : owedNow,
    owed,
  });

  // Batch 69: a period whose invoice is paid in full says so (and by what),
  // never a difference against an invoice that owes nothing.
  let paid: PlanPaymentPreview["paid"] = null;
  if (invoice && invoice.amount_paid + 0.01 >= invoice.total) {
    const paymentId = (existing?.["payment_id"] as string | null) ?? null;
    const { data: payment } = paymentId
      ? await supabase
          .from("payments")
          .select("provider, method, provider_payment_id, raw")
          .eq("id", paymentId)
          .maybeSingle()
      : { data: null };
    const raw = (payment?.["raw"] ?? {}) as Record<string, unknown>;
    const provider = (payment?.["provider"] as string | null) ?? null;
    paid = {
      invoice_number: invoice.invoice_number,
      reference:
        (raw["reference"] as string | undefined) ??
        (payment?.["provider_payment_id"] as string | null) ??
        null,
      method:
        provider === "manual"
          ? methodLabel(String(payment?.["method"] ?? ""))
          : provider === "cashfree"
            ? "Cashfree"
            : provider === "razorpay"
              ? "Razorpay"
              : null,
      excess: provider === "manual" ? Number(raw["excess"] ?? 0) : 0,
    };
  }

  const warnings: string[] = [];
  if (invoice?.open_payment_link) {
    warnings.push(
      "This invoice also has an open online payment link. Tell them not to pay it as well.",
    );
  }
  if (org["plan_status"] === "trial") {
    warnings.push(
      "This workspace is still on trial. Recording the payment doesn't end the trial: use Assign plan with status Active for that.",
    );
  }
  if (!org["billing_enabled_at"]) {
    warnings.push(
      "Billing isn't switched on for this workspace, so the monthly run won't invoice the next period.",
    );
  }

  return {
    organization_name: String(org["name"] ?? ""),
    plan_name: planName,
    plan_version: versionNo === null || versionNo === undefined ? null : `v${String(versionNo)}`,
    plan_status: (org["plan_status"] as string | null) ?? null,
    trial_ends_at: (org["trial_ends_at"] as string | null) ?? null,
    billing_day: billingDay,
    new_billing_day: billingDayFor(start),
    default_period_start: defaultStart,
    period,
    plan_fee: Number(fee),
    fee_from: override !== null && override !== undefined ? "override" : "plan",
    gst_registered: gstRegistered,
    figures,
    invoice,
    already_recorded: recorded
      ? {
          payment_id: String(recorded["id"]),
          reference: String(
            ((recorded["raw"] ?? {}) as Record<string, unknown>)["reference"] ?? "",
          ),
        }
      : null,
    paid,
    billing_enabled: Boolean(org["billing_enabled_at"]),
    warnings,
  };
}

export type RecordPlanPaymentInput = Input & {
  method: string;
  paidOn: string;
  note?: string | null;
};

/** The save. Idempotent per (workspace, period, reference). */
export async function recordPlanPayment(
  supabase: SupabaseClient,
  input: RecordPlanPaymentInput,
): Promise<RecordPlanPaymentResult> {
  await requireSuper(supabase, input.actorId);

  const reference = cleanRef(input.reference);
  const amount = round2(Number(input.amount ?? 0));
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  if (!isDateOnly(input.periodStart)) return { error: "Enter the period start as a date." };
  if (!(amount > 0)) return { error: "Enter the amount received." };
  if (!isPlanPaymentMethod(input.method)) return { error: "Choose how they paid." };
  if (!reference) return { error: "Enter the payment reference (UTR, UPI or cheque number)." };
  if (!isDateOnly(input.paidOn)) return { error: "Enter the date it was paid." };
  if (input.paidOn > indiaToday()) return { error: "The paid-on date can't be in the future." };

  const preview = await planPaymentPreview(supabase, { ...input, reference, amount });
  if ("error" in preview) return preview;
  const period = preview.period;

  // Same period, same reference: finish anything left over, add nothing.
  const prior = (await manualPlanPayments(supabase, input.organizationId)).find((p) =>
    sameRecording(p, period.start, reference),
  );
  if (prior?.["status"] === "paid") {
    const raw = (prior["raw"] ?? {}) as Record<string, unknown>;
    const { data: inv } = await supabase
      .from("invoices")
      .select("id, invoice_number, status")
      .eq("id", String(raw["invoice_id"] ?? ""))
      .maybeSingle();
    return {
      ok: true,
      already: true,
      payment_id: String(prior["id"]),
      invoice_id: String(raw["invoice_id"] ?? ""),
      invoice_number: (inv?.["invoice_number"] as string | null) ?? null,
      invoice_status: String(inv?.["status"] ?? ""),
      reference: String(raw["reference"] ?? reference),
      period: { start: period.start, end: period.end },
      applied: Number(raw["applied"] ?? 0),
      excess: Number(raw["excess"] ?? 0),
      short: Number(raw["short"] ?? 0),
      billing_day: preview.new_billing_day,
      delivered: Boolean(raw["delivered_at"]),
    };
  }

  if (preview.invoice && preview.invoice.amount_paid + 0.01 >= preview.invoice.total) {
    return {
      error: `Invoice ${preview.invoice.invoice_number ?? ""} for ${period.start} is already paid. Pick another period.`,
    };
  }

  // 1. The period's invoice: the one there, else raised the invoicePlanFee way.
  let invoiceId: string;
  if (preview.invoice) {
    invoiceId = preview.invoice.id;
    if (!preview.invoice.invoice_number) {
      const { issueInvoice } = await import("@/lib/invoices.server");
      const issued = await issueInvoice(supabase, invoiceId, { deliver: false });
      if ("error" in issued) return { error: issued.error };
    }
  } else {
    const { raisePlanFeeInvoice } = await import("@/lib/plan-billing.server");
    const raised = await raisePlanFeeInvoice(
      supabase,
      input.organizationId,
      { start: period.start, end: period.end },
      { createdBy: input.actorId },
    );
    if ("error" in raised) {
      // The monthly run may have raised this period's invoice a moment ago.
      const [raced] = await periodInvoices(supabase, input.organizationId, period.start);
      if (!raced) return { error: `We couldn't raise the invoice: ${raised.error}` };
      invoiceId = String(raced["id"]);
    } else {
      invoiceId = raised.invoice_id;
    }
  }

  const { data: invRow, error: invError } = await supabase
    .from("invoices")
    .select("id, invoice_number, total, amount_paid, status, sent")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invError || !invRow) return { error: "We couldn't read the invoice." };
  const owed = round2(Number(invRow["total"] ?? 0) - Number(invRow["amount_paid"] ?? 0));
  const figures = planPaymentFigures({
    base: preview.plan_fee,
    gstRegistered: preview.gst_registered,
    received: amount,
    owed,
  });
  const alreadySent = Boolean(((invRow["sent"] ?? {}) as Record<string, unknown>)["whatsapp_at"]);

  // 2. The payment, settled through settlePayment's plan_fee + invoice_id branch.
  let paymentId: string;
  if (prior) {
    paymentId = String(prior["id"]); // an earlier save that didn't finish settling
  } else {
    const { data: org } = await supabase
      .from("organizations")
      .select("billing_account_id")
      .eq("id", input.organizationId)
      .maybeSingle();
    const { data: payment, error: payError } = await supabase
      .from("payments")
      .insert({
        organization_id: input.organizationId,
        billing_account_id: (org?.["billing_account_id"] as string | null) ?? null,
        provider: "manual",
        method: input.method,
        purpose: "plan_fee",
        amount,
        currency: "INR",
        status: "created",
        raw: {
          manual: true,
          invoice_id: invoiceId,
          reference,
          note: note || null,
          period: `${period.start} to ${period.end}`,
          period_start: period.start,
          period_end: period.end,
          paid_on: input.paidOn,
          gross_amount: amount,
          applied: figures.applied,
          excess: figures.excess,
          short: figures.short,
          recorded_by: input.actorId,
        },
        created_by: input.actorId,
      })
      .select("id")
      .single();
    if (payError || !payment) return { error: "We couldn't record that payment." };
    paymentId = String(payment["id"]);
  }

  const { settlePayment } = await import("@/lib/billing.server");
  try {
    await settlePayment(
      supabase,
      paymentId,
      null,
      { source: "manual_plan_payment", recorded_by: input.actorId },
      {
        paise: Math.round(amount * 100),
        status: "captured",
        currency: "INR",
        method: input.method,
        methodDetail: reference,
        orderId: null,
      },
    );
  } catch (error) {
    return {
      error: `The payment is saved but couldn't be settled: ${String((error as Error)?.message ?? error).slice(0, 200)}. Save again to retry.`,
    };
  }
  const { data: settled } = await supabase
    .from("payments")
    .select("status, raw")
    .eq("id", paymentId)
    .maybeSingle();
  if (settled?.["status"] !== "paid") {
    return { error: "The payment is saved but wasn't settled. Save again to retry." };
  }
  // settlePayment stamps now; the money arrived on the paid-on date.
  const settledRaw = (settled["raw"] ?? {}) as Record<string, unknown>;
  await supabase
    .from("payments")
    .update({ paid_at: `${input.paidOn}T12:00:00+05:30` })
    .eq("id", paymentId)
    .eq("provider", "manual");

  const { data: paidInv } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, sent")
    .eq("id", invoiceId)
    .maybeSingle();
  const invoiceStatus = String(paidInv?.["status"] ?? "");

  // The PDF names how it was paid ("Paid via Bank transfer ref …") — only once
  // the invoice is paid in full — and no longer carries a payment link.
  if (invoiceStatus === "paid") {
    const sent = { ...((paidInv?.["sent"] ?? {}) as Record<string, unknown>) };
    if (sent["pay_url"]) sent["pay_url_before_paid"] = sent["pay_url"];
    delete sent["pay_url"];
    sent["payment_ref"] = reference;
    sent["payment_gateway"] = methodLabel(input.method);
    await supabase.from("invoices").update({ sent }).eq("id", invoiceId);
    const { ensureInvoicePdf } = await import("@/lib/invoices.server");
    await ensureInvoicePdf(supabase, invoiceId, { force: true });
  }

  // 3. The next run invoices the next period on its date.
  const billingDay = preview.new_billing_day;
  if (billingDay !== preview.billing_day) {
    await supabase
      .from("organizations")
      .update({ billing_day: billingDay })
      .eq("id", input.organizationId);
  }

  // 4. The paid invoice, once.
  let delivered = Boolean(settledRaw["delivered_at"]);
  if (!delivered) {
    const { deliverInvoice } = await import("@/lib/invoices.server");
    const out = await deliverInvoice(supabase, invoiceId, {
      fallbackToQueue: true,
      ...(alreadySent ? { explicit: true } : {}),
    });
    delivered = out.ok;
    await supabase
      .from("payments")
      .update({
        raw: {
          ...settledRaw,
          delivered_at: new Date().toISOString(),
          delivery: out.ok ? "whatsapp" : `queued (${out.error.slice(0, 80)})`,
        },
      })
      .eq("id", paymentId);
  }

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: "plan_payment_recorded",
    details: {
      payment_id: paymentId,
      invoice_id: invoiceId,
      invoice_number: (paidInv?.["invoice_number"] as string | null) ?? null,
      period_start: period.start,
      period_end: period.end,
      amount,
      applied: figures.applied,
      excess: figures.excess,
      method: input.method,
      reference,
      paid_on: input.paidOn,
      billing_day_from: preview.billing_day,
      billing_day_to: billingDay,
    },
  });

  return {
    ok: true,
    already: false,
    payment_id: paymentId,
    invoice_id: invoiceId,
    invoice_number: (paidInv?.["invoice_number"] as string | null) ?? null,
    invoice_status: invoiceStatus,
    reference,
    period: { start: period.start, end: period.end },
    applied: figures.applied,
    excess: figures.excess,
    short: figures.short,
    billing_day: billingDay,
    delivered,
  };
}
