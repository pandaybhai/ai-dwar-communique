/**
 * Opens Cashfree's own checkout in the browser (@cashfreepayments/cashfree-js).
 * The server hands over only the session id and the mode (sandbox or
 * production, from CASHFREE_ENV); no key ever reaches the page. After paying,
 * Cashfree brings the customer back to the order's return_url, where our
 * server confirms the payment with Cashfree before anything is credited.
 */
export type CashfreeCheckout = { payment_session_id: string; mode: "sandbox" | "production" };
export type CashfreeSubscriptionCheckout = {
  subscription_session_id: string;
  mode: "sandbox" | "production";
};

async function cashfree(mode: "sandbox" | "production") {
  const { load } = await import("@cashfreepayments/cashfree-js");
  const instance = await load({ mode });
  if (!instance) throw new Error("The payment page couldn't load. Please try again.");
  return instance;
}

/** Resolves with an error message, or never (the page goes to Cashfree). */
export async function openCashfreeCheckout(checkout: CashfreeCheckout): Promise<string | null> {
  try {
    const instance = await cashfree(checkout.mode);
    const result = await instance.checkout({
      paymentSessionId: checkout.payment_session_id,
      redirectTarget: "_self",
    });
    return result?.error?.message ?? null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The payment page couldn't load. Please try again.";
  }
}

export async function openCashfreeSubscriptionCheckout(
  checkout: CashfreeSubscriptionCheckout,
): Promise<string | null> {
  try {
    const instance = await cashfree(checkout.mode);
    const result = await instance.subscriptionsCheckout({
      subsSessionId: checkout.subscription_session_id,
      redirectTarget: "_self",
    });
    return result?.error?.message ?? null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The auto-pay page couldn't load. Please try again.";
  }
}

/** Asks our server to confirm a returning payment with Cashfree (GET order). */
export async function confirmCashfreeReturn(
  paymentId: string,
): Promise<"paid" | "pending" | "failed" | "unknown"> {
  try {
    const res = await fetch("/api/public/cashfree-pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment_id: paymentId }),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    const status = body.status;
    return status === "paid" || status === "pending" || status === "failed" ? status : "unknown";
  } catch {
    return "unknown";
  }
}
