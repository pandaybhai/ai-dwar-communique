import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, withGst } from "@/lib/billing";

/**
 * The monthly plan-fee run.
 *
 * Workspaces on auto-pay are charged by the provider and settled through the
 * webhook — this job leaves them alone. Everyone else gets an invoice and a
 * payment link on their billing day. Trials get a heads-up three days before
 * the trial ends rather than a surprise charge.
 */

type Counts = { invoiced: number; skipped: number; trial_notices: number; failed: number };

function today(): Date {
  return new Date();
}

/** Handles short months: a billing day of 28 is the highest we allow anyway. */
function isBillingDay(billingDay: number, date: Date): boolean {
  const day = date.getUTCDate();
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return day === Math.min(billingDay, last);
}

function periodFor(date: Date): { start: string; end: string } {
  const start = new Date(date);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function runPlanBilling(supabase: SupabaseClient): Promise<Counts> {
  const counts: Counts = { invoiced: 0, skipped: 0, trial_notices: 0, failed: 0 };
  const now = today();

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, billing_day, plan_status, plan_version_id, trial_ends_at, billing_account_id")
    .not("plan_version_id", "is", null)
    .in("plan_status", ["trial", "active", "past_due", "paused"])
    .limit(1000);

  const { notify } = await import("@/lib/billing.server");

  for (const row of (orgs ?? []) as Record<string, unknown>[]) {
    const organizationId = String(row["id"]);

    // Trial ending in three days: one friendly heads-up, once.
    const trialEnds = row["trial_ends_at"] as string | null;
    if (row["plan_status"] === "trial" && trialEnds) {
      const days = Math.ceil((new Date(trialEnds).getTime() - now.getTime()) / 864e5);
      if (days === 3) {
        await notify(supabase, {
          organizationId,
          audience: "client",
          kind: "trial_ending",
          payload: { days, ends_at: trialEnds },
        });
        counts.trial_notices += 1;
      }
      if (days > 0) {
        counts.skipped += 1;
        continue;
      }
    }

    const billingDay = Number(row["billing_day"] ?? 1);
    if (!isBillingDay(billingDay, now)) {
      counts.skipped += 1;
      continue;
    }

    // On auto-pay? The mandate charge and its invoice come from the webhook.
    const { data: mandate } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("organization_id", organizationId)
      .in("status", ["authenticated", "active"])
      .limit(1)
      .maybeSingle();
    if (mandate) {
      counts.skipped += 1;
      continue;
    }

    try {
      const result = await invoicePlanFee(supabase, organizationId, periodFor(now));
      if ("error" in result) counts.failed += 1;
      else counts.invoiced += 1;
    } catch {
      counts.failed += 1;
    }
  }

  return counts;
}

/** One workspace's plan fee: invoice, payment link, notice. Idempotent per period. */
export async function invoicePlanFee(
  supabase: SupabaseClient,
  organizationId: string,
  period: { start: string; end: string },
): Promise<{ invoice_id: string; pay_url: string | null } | { error: string }> {
  const { data: existing } = await supabase
    .from("invoices")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("purpose", "plan_fee")
    .eq("period_start", period.start)
    .neq("status", "void")
    .maybeSingle();
  if (existing) return { error: "already_invoiced" };

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, plan_version_id, billing_account_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org?.["plan_version_id"]) return { error: "no_plan" };

  const [{ data: version }, { data: settings }] = await Promise.all([
    supabase
      .from("plan_versions")
      .select("price_monthly, plans:plan_id(name)")
      .eq("id", org["plan_version_id"] as string)
      .maybeSingle(),
    supabase
      .from("organization_billing_settings")
      .select("plan_fee_override")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);

  const listed = version?.["price_monthly"] as number | null | undefined;
  const override = settings?.["plan_fee_override"] as number | null | undefined;
  const base = override ?? (listed === null || listed === undefined ? null : Number(listed));
  if (base === null || base === undefined) return { error: "no_price" };
  if (Number(base) <= 0) return { error: "free_plan" };

  const planName =
    ((version?.["plans"] as unknown as Record<string, unknown>)?.["name"] as string) ?? "Plan";

  const { loadSupplier, buildInvoice, issueInvoice } = await import("@/lib/invoices.server");
  const { buildStatementLines, planFeeRoiSnapshot } = await import("@/lib/billing-statement.server");
  const supplier = await loadSupplier(supabase);

  const previousStart = new Date(`${period.start}T00:00:00Z`);
  previousStart.setUTCMonth(previousStart.getUTCMonth() - 1);
  const statement = await buildStatementLines(
    supabase,
    organizationId,
    previousStart.toISOString(),
    `${period.start}T00:00:00Z`,
  );
  const roi = await planFeeRoiSnapshot(
    supabase,
    organizationId,
    previousStart.toISOString(),
    `${period.start}T00:00:00Z`,
  );

  const built = await buildInvoice(supabase, organizationId, {
    kind: "tax_invoice",
    purpose: "plan_fee",
    period,
    roi_snapshot: roi,
    lines: [
      {
        line_type: "plan",
        description: `${planName} plan — ${period.start} to ${period.end}`,
        sac_code: supplier.sac_platform,
        unit_price: Number(base),
      },
      ...statement,
    ],
  });
  if ("error" in built) return { error: built.error };

  const issued = await issueInvoice(supabase, built.invoice_id);
  if ("error" in issued) return { error: issued.error };

  const gross = withGst(Number(base)).total;
  const payUrl = await createPlanPaymentLink(supabase, {
    organizationId,
    invoiceId: built.invoice_id,
    invoiceNumber: issued.invoice_number,
    amount: gross,
    orgName: String(org["name"] ?? "your workspace"),
    billingAccountId: (org["billing_account_id"] as string | null) ?? null,
  });

  const { notify } = await import("@/lib/billing.server");
  await notify(supabase, {
    organizationId,
    audience: "client",
    kind: "invoice_issued",
    payload: {
      invoice_number: issued.invoice_number,
      amount: round2(gross),
      link: payUrl ?? "https://aidwar.in/app/billing",
    },
  });

  return { invoice_id: built.invoice_id, pay_url: payUrl };
}

async function createPlanPaymentLink(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    invoiceId: string;
    invoiceNumber: string;
    amount: number;
    orgName: string;
    billingAccountId: string | null;
  },
): Promise<string | null> {
  const { razorpayKeys, createPaymentLink } = await import("@/lib/razorpay.server");
  const keys = await razorpayKeys(supabase);
  if (!keys) return null;

  const { data: payment } = await supabase
    .from("payments")
    .insert({
      organization_id: input.organizationId,
      billing_account_id: input.billingAccountId,
      provider: "razorpay",
      purpose: "plan_fee",
      amount: round2(input.amount),
      currency: "INR",
      status: "created",
      raw: { invoice_id: input.invoiceId },
    })
    .select("id")
    .maybeSingle();
  if (!payment) return null;

  const { data: account } = input.billingAccountId
    ? await supabase
        .from("billing_accounts")
        .select("legal_name, billing_email, billing_phone")
        .eq("id", input.billingAccountId)
        .maybeSingle()
    : { data: null };

  const { link } = await createPaymentLink(keys, {
    amount: round2(input.amount),
    currency: "INR",
    description: `AiDwar plan fee — invoice ${input.invoiceNumber}`,
    reference: String(payment["id"]),
    customer: {
      name: (account?.["legal_name"] as string | null) ?? input.orgName,
      email: (account?.["billing_email"] as string | null) ?? null,
      contact: (account?.["billing_phone"] as string | null) ?? null,
    },
    callbackUrl: "https://aidwar.in/app/billing",
    notes: {
      payment_id: String(payment["id"]),
      invoice_id: input.invoiceId,
      org_id: input.organizationId,
    },
  });
  if (!link) return null;

  await supabase
    .from("payments")
    .update({ provider_payment_id: null, raw: { invoice_id: input.invoiceId, link: link.raw } })
    .eq("id", payment["id"] as string);
  await supabase.from("invoices").update({ payment_id: payment["id"] }).eq("id", input.invoiceId);

  return link.short_url || null;
}
