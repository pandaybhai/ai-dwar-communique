import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";

/**
 * Refunds of Cashfree payments — Super Admin only (Billing -> workspace ->
 * Payments). Each refund is recorded on the payment (raw.refunds,
 * raw.refunded_amount), and moves money only through paths that already exist:
 *   - credits bought with it come off the wallet through the signed
 *     'adjustment' (Batch 26a, wallet_apply), only for a credit purchase;
 *   - a credit note against the payment's tax invoice through issueCreditNote
 *     (refund_mode 'none': the money goes back to the card/bank, not the wallet).
 *
 * Order: wallet first (a refund never leaves while its credits stay spendable),
 * then Cashfree; if Cashfree refuses, the credits are put back.
 */

type AnyRecord = Record<string, unknown>;

export type RefundRecord = {
  refund_id: string;
  amount: number;
  reason: string;
  status: string;
  cf_refund_id: string | null;
  requested_by: string;
  requested_at: string;
  wallet_adjusted: number;
  credit_note: string | null;
  note?: string;
};

/** Refunds that still count against the payment (a refused one doesn't). */
function liveRefunds(raw: AnyRecord): RefundRecord[] {
  return ((raw["refunds"] ?? []) as RefundRecord[]).filter(
    (r) => !["failed", "cancelled", "rejected"].includes(String(r.status).toLowerCase()),
  );
}

export function refundedSoFar(raw: AnyRecord): number {
  return round2(liveRefunds(raw).reduce((sum, r) => sum + Number(r.amount ?? 0), 0));
}

/** What the customer paid for this payment (GST included). */
export function paidGross(payment: AnyRecord): number {
  const raw = (payment["raw"] ?? {}) as AnyRecord;
  const gross = Number(raw["gross_amount"] ?? raw["gross"] ?? Number.NaN);
  return Number.isFinite(gross) && gross > 0 ? round2(gross) : 0;
}

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

/** Credits that came into the wallet with this payment (pack, bonus, coupon). */
async function creditsGranted(supabase: SupabaseClient, payment: AnyRecord): Promise<number> {
  const { data } = await supabase
    .from("wallet_ledger")
    .select("amount, entry_type")
    .eq("reference_type", "payment")
    .eq("reference_id", String(payment["id"]))
    .in("entry_type", ["credit_purchase", "bonus_credits", "coupon_credits"]);
  const fromLedger = round2(
    ((data ?? []) as AnyRecord[]).reduce((s, r) => s + Math.abs(Number(r["amount"] ?? 0)), 0),
  );
  if (fromLedger > 0) return fromLedger;
  const raw = (payment["raw"] ?? {}) as AnyRecord;
  return round2(Number(raw["pack_amount"] ?? payment["amount"] ?? 0) + Number(raw["bonus"] ?? 0));
}

async function saveRefunds(
  supabase: SupabaseClient,
  paymentId: string,
  mutate: (raw: AnyRecord) => AnyRecord,
) {
  const { data } = await supabase.from("payments").select("raw").eq("id", paymentId).maybeSingle();
  const raw = mutate(((data as { raw?: AnyRecord } | null)?.raw ?? {}) as AnyRecord);
  raw["refunded_amount"] = refundedSoFar(raw);
  await supabase.from("payments").update({ raw }).eq("id", paymentId);
}

export async function refundPayment(
  supabase: SupabaseClient,
  input: { actorId: string; paymentId: string; amount: number; reason: string },
  deps: { config?: import("@/lib/cashfree.server").CashfreeConfig | null } = {},
): Promise<{ ok: true; refund: RefundRecord } | { error: string }> {
  await requireSuper(supabase, input.actorId);
  const amount = round2(Number(input.amount));
  const reason = input.reason.trim();
  if (!(amount > 0)) return { error: "Enter a refund amount above zero." };
  if (reason.length < 3) return { error: "A refund always needs a reason." };

  const { data: found } = await supabase
    .from("payments")
    .select("id, organization_id, provider, purpose, status, amount, currency, raw")
    .eq("id", input.paymentId)
    .maybeSingle();
  const payment = (found ?? null) as AnyRecord | null;
  if (!payment) return { error: "That payment no longer exists." };
  if (payment["provider"] !== "cashfree")
    return { error: "Only Cashfree payments can be refunded from here." };
  if (payment["status"] !== "paid") return { error: "Only a paid payment can be refunded." };

  const raw = (payment["raw"] ?? {}) as AnyRecord;
  const gross = paidGross(payment);
  const left = round2(gross - refundedSoFar(raw));
  if (amount > left)
    return { error: `That's more than is left to refund: ₹${Math.max(left, 0)} at most.` };

  const { cashfreeConfig, createRefund } = await import("@/lib/cashfree.server");
  const { PAYMENTS_NOT_CONFIGURED } = await import("@/lib/razorpay.server");
  const config = deps.config === undefined ? cashfreeConfig() : deps.config;
  if (!config) return { error: PAYMENTS_NOT_CONFIGURED };

  const organizationId = String(payment["organization_id"]);
  const refundId = `rf_${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 40);
  const record: RefundRecord = {
    refund_id: refundId,
    amount,
    reason: reason.slice(0, 300),
    status: "requested",
    cf_refund_id: null,
    requested_by: input.actorId,
    requested_at: new Date().toISOString(),
    wallet_adjusted: 0,
    credit_note: null,
  };

  // Credits bought with this payment come off the wallet in proportion, before
  // any money goes back — through the signed adjustment, nothing new.
  let walletDebit = 0;
  if (payment["purpose"] === "credit_purchase") {
    const { data: version, error: versionError } = await supabase.rpc("wallet_apply_version");
    if (versionError || Number(version ?? 0) < 2) {
      return {
        error:
          "Refunds of credits need the Batch 26a wallet update (20261065) applied to the database first.",
      };
    }
    const granted = await creditsGranted(supabase, payment);
    walletDebit = gross > 0 ? round2((granted * amount) / gross) : 0;
    if (walletDebit > 0) {
      const { error } = await supabase.rpc("wallet_apply", {
        p_org: organizationId,
        p_type: "adjustment",
        p_amount: -walletDebit,
        p_ref_type: "payment_refund",
        p_ref_id: input.paymentId,
        p_description: `Refund of payment — ${reason}`.slice(0, 200),
        p_metadata: {
          refund_id: refundId,
          refunded_payment_id: input.paymentId,
          gateway: "cashfree",
        },
        p_actor: input.actorId,
      });
      if (error) {
        return {
          error: error.message.includes("INSUFFICIENT_CREDITS")
            ? "The workspace has already spent those credits — the refund would take its balance below the overdraft limit."
            : "We couldn't take the credits back off the wallet, so nothing was refunded. Please try again.",
        };
      }
      record.wallet_adjusted = walletDebit;
    }
  }

  const refund = await createRefund(config, input.paymentId, { refundId, amount, note: reason });
  if (!refund.ok) {
    if (walletDebit > 0) {
      const { error } = await supabase.rpc("wallet_apply", {
        p_org: organizationId,
        p_type: "adjustment",
        p_amount: walletDebit,
        p_ref_type: "payment_refund",
        p_ref_id: input.paymentId,
        p_description: "Refund didn't go through — credits put back",
        p_metadata: { refund_id: refundId, refunded_payment_id: input.paymentId, reversal: true },
        p_actor: input.actorId,
      });
      if (error)
        console.error("[refunds] credits not put back", input.paymentId, refundId, error.message);
    }
    await saveRefunds(supabase, input.paymentId, (r) => ({
      ...r,
      refunds: [
        ...((r["refunds"] ?? []) as RefundRecord[]),
        { ...record, status: "failed", wallet_adjusted: 0, note: refund.error ?? "refused" },
      ],
    }));
    return { error: refund.error ?? "Cashfree didn't accept that refund." };
  }

  record.cf_refund_id =
    refund.body["cf_refund_id"] !== undefined ? String(refund.body["cf_refund_id"]) : null;
  record.status = String(refund.body["refund_status"] ?? "PENDING").toLowerCase();

  // The GST side: a credit note against the payment's tax invoice — or, once
  // it was re-issued without GST (Batch 55), against its no-GST invoice.
  const { data: saleInvoices } = await supabase
    .from("invoices")
    .select("id, kind")
    .eq("payment_id", input.paymentId)
    .in("kind", ["tax_invoice", "invoice"])
    .neq("status", "void")
    .order("created_at", { ascending: true })
    .limit(5);
  const sales = (saleInvoices ?? []) as AnyRecord[];
  const invoice = [...sales].reverse().find((r) => r["kind"] === "invoice") ?? sales[0] ?? null;
  if (invoice) {
    const { issueCreditNote } = await import("@/lib/credit-notes.server");
    const note = await issueCreditNote(supabase, {
      invoiceId: String((invoice as AnyRecord)["id"]),
      amount,
      reason: `Refund — ${reason}`,
      refundToWallet: false,
      actorId: input.actorId,
    });
    if ("error" in note) record.note = `credit note not issued: ${note.error}`;
    else record.credit_note = note.number;
  } else {
    record.note = "no tax invoice found for this payment — issue the credit note by hand";
  }

  await saveRefunds(supabase, input.paymentId, (r) => ({
    ...r,
    refunds: [...((r["refunds"] ?? []) as RefundRecord[]), record],
  }));
  await supabase.from("activity_log").insert({
    organization_id: organizationId,
    user_id: input.actorId,
    action: "payment_refunded",
    details: {
      payment_id: input.paymentId,
      refund_id: refundId,
      amount,
      wallet_adjusted: walletDebit,
      credit_note: record.credit_note,
    },
  });
  return { ok: true, refund: record };
}

/** REFUND_STATUS_WEBHOOK: the refund's status is recorded on its payment — nothing else moves. */
export async function recordRefundStatus(
  supabase: SupabaseClient,
  refund: AnyRecord,
): Promise<void> {
  const paymentId = typeof refund["order_id"] === "string" ? (refund["order_id"] as string) : null;
  const refundId = typeof refund["refund_id"] === "string" ? (refund["refund_id"] as string) : null;
  const { OUR_ORDER_ID } = await import("@/lib/cashfree-billing.server");
  if (!paymentId || !refundId || !OUR_ORDER_ID.test(paymentId)) return;
  const { data, error } = await supabase
    .from("payments")
    .select("id, raw")
    .eq("id", paymentId)
    .eq("provider", "cashfree")
    .maybeSingle();
  if (error) {
    const { SettleError } = await import("@/lib/billing.server");
    throw new SettleError(`refund status read failed: ${error.message}`);
  }
  if (!data) return;
  const raw = ((data as AnyRecord)["raw"] ?? {}) as AnyRecord;
  const refunds = ((raw["refunds"] ?? []) as RefundRecord[]).map((r) =>
    r.refund_id === refundId
      ? {
          ...r,
          status: String(refund["refund_status"] ?? r.status).toLowerCase(),
          cf_refund_id:
            r.cf_refund_id ??
            (refund["cf_refund_id"] !== undefined ? String(refund["cf_refund_id"]) : null),
          ...(refund["status_description"]
            ? { note: String(refund["status_description"]).slice(0, 300) }
            : {}),
        }
      : r,
  );
  const known = refunds.some((r) => r.refund_id === refundId);
  const next: AnyRecord = {
    ...raw,
    refunds: known
      ? refunds
      : [
          ...refunds,
          // A refund made in the Cashfree dashboard: recorded, nothing adjusted.
          {
            refund_id: refundId,
            amount: round2(Number(refund["refund_amount"] ?? 0)),
            reason: String(refund["refund_note"] ?? "refund made outside AiDwar").slice(0, 300),
            status: String(refund["refund_status"] ?? "").toLowerCase(),
            cf_refund_id:
              refund["cf_refund_id"] !== undefined ? String(refund["cf_refund_id"]) : null,
            requested_by: "cashfree",
            requested_at: String(refund["created_at"] ?? new Date().toISOString()),
            wallet_adjusted: 0,
            credit_note: null,
            note: "made outside AiDwar: wallet and credit note not adjusted",
          } satisfies RefundRecord,
        ],
  };
  next["refunded_amount"] = refundedSoFar(next);
  const { error: writeError } = await supabase
    .from("payments")
    .update({ raw: next })
    .eq("id", paymentId);
  if (writeError) {
    const { SettleError } = await import("@/lib/billing.server");
    throw new SettleError(`refund status not recorded: ${writeError.message}`);
  }
}
