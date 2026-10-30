import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/billing";
import {
  confirmCashfreeReturn,
  openCashfreeCheckout,
  type CashfreeCheckout,
} from "@/lib/cashfree-checkout";
import { getPublicGstMode } from "@/lib/public-plans.functions";

const TITLE = "Pay — AiDwar";
const DESCRIPTION = "Pay your AiDwar invoice securely with Cashfree.";

/**
 * One payment's pay page: the link inside a plan-fee invoice notice, and the
 * "Finish payment" link. Opens Cashfree's checkout; when the customer comes
 * back (?return=1) our server asks Cashfree whether it was paid.
 */
export const Route = createFileRoute("/pay/$paymentId")({
  ssr: false,
  // Batch 55: "incl. 18% GST" only while AiDwar is GST-registered.
  loader: () => getPublicGstMode(),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PayPage,
});

type Due = {
  status: "paid" | "pending" | "failed";
  amount: number;
  currency: string;
  label: string;
  checkout: CashfreeCheckout | null;
};

const POLL_MS = 3000;
const POLL_TRIES = 20;

function PayPage() {
  const { paymentId } = useParams({ from: "/pay/$paymentId" });
  const gstRegistered = Route.useLoaderData()?.gst_registered === true;
  const [due, setDue] = useState<Due | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/public/cashfree-pay?payment_id=${encodeURIComponent(paymentId)}`,
    ).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (Due & { error?: string }) | null;
    if (!res?.ok || !body || body.error) {
      setError(body?.error ?? "We couldn't load this payment. Please try again.");
      return null;
    }
    setDue(body);
    return body;
  }, [paymentId]);

  // Back from Cashfree: our server confirms with Cashfree, a few times if needed.
  useEffect(() => {
    let cancelled = false;
    const returning = new URLSearchParams(window.location.search).has("return");
    void (async () => {
      const first = await load();
      if (!returning || !first || first.status === "paid") return;
      setChecking(true);
      for (let i = 0; i < POLL_TRIES && !cancelled; i++) {
        const status = await confirmCashfreeReturn(paymentId);
        if (status === "paid" || status === "failed") break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!cancelled) {
        await load();
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, paymentId]);

  async function pay() {
    if (!due?.checkout) return;
    setBusy(true);
    const problem = await openCashfreeCheckout(due.checkout);
    setBusy(false);
    if (problem) setError(problem);
  }

  return (
    <AuthShell
      title={due?.status === "paid" ? "Paid — thank you" : "Pay AiDwar"}
      subtitle={due ? due.label : "Secure payment by Cashfree."}
      footer={
        <Link to="/app/billing" className="font-medium text-primary hover:underline">
          Go to Billing
        </Link>
      }
    >
      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : !due ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
            <p className="text-xs text-muted-foreground">
              {gstRegistered ? "Amount (incl. 18% GST)" : "Amount"}
            </p>
            <p className="font-heading text-2xl font-bold">{money(due.amount, due.currency)}</p>
          </div>
          {due.status === "paid" ? (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Payment received. Your invoice is on its way.
            </p>
          ) : checking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking your payment with Cashfree…
            </p>
          ) : due.checkout ? (
            <>
              {due.status === "failed" ? (
                <p className="text-sm text-muted-foreground">
                  The last try didn't go through. You can pay again.
                </p>
              ) : null}
              <Button className="w-full rounded-full" onClick={() => void pay()} disabled={busy}>
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-2 h-4 w-4" />
                )}
                Pay {money(due.amount, due.currency)}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              This payment link has closed. Open Billing in AiDwar to pay, or write to us and we'll
              send a fresh link.
            </p>
          )}
        </div>
      )}
    </AuthShell>
  );
}
