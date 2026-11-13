import { allErrors, firstName, isExistingAccountError, type CheckoutValues } from "@/lib/page-999";
import type { BrowserMetaEvent } from "@/lib/meta-events";

/**
 * Batch 80: what happens when Pay is tapped in the /999 checkout sheet, in
 * order, with every outside call passed in (so the whole run is tested with
 * fakes and the sheet stays one screen):
 *
 *  1. the lead is saved once (source landing_999; the server's cookie
 *     remembers it);
 *  2. the account: the existing email + password sign-up (the same
 *     auth.signUp call /signup makes); an email that already has an account
 *     signs in with the typed password, else the sheet asks for it inline;
 *     a visitor already signed in skips both;
 *  3. the Basic plan's payment for their own workspace — made first, with the
 *     onboarding's own create path, when they have none;
 *  4. Cashfree's popup over the page; then our server confirms the order
 *     with Cashfree (GET order → settlePayment) before saying "paid".
 *
 * A failed or cancelled payment keeps the account (and workspace) without a
 * plan; nothing the buyer typed is lost — the sheet just offers Try again.
 */

export type Phase = "saving" | "account" | "workspace" | "opening" | "paying" | "confirming";

export const PHASE_TEXT: Record<Phase, string> = {
  saving: "Saving your details…",
  account: "Creating your account…",
  workspace: "Setting up your workspace…",
  opening: "Opening secure payment…",
  paying: "Waiting for your payment…",
  confirming: "Confirming your payment…",
};

export type CheckoutOutcome =
  | { kind: "paid"; paymentId: string; firstName: string }
  | { kind: "already"; firstName: string }
  | { kind: "field"; field: keyof CheckoutValues; error: string }
  | { kind: "needs_password"; message: string }
  | { kind: "failed"; message: string; paymentId: string | null }
  | { kind: "error"; message: string };

export type GatewaySession = { payment_session_id: string; mode: "sandbox" | "production" };

export type CheckoutDeps = {
  saveLead: (
    body: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string | undefined; field?: string | undefined }>;
  session: () => Promise<{ userId: string; token: string } | null>;
  signUp: (input: {
    email: string;
    password: string;
    phone: string;
    fullName: string;
  }) => Promise<{ userId: string | null; token: string | null; error: string | null }>;
  signIn: (input: {
    email: string;
    password: string;
  }) => Promise<{ userId: string | null; token: string | null; error: string | null }>;
  startPay: (
    token: string,
    body: Record<string, unknown>,
  ) => Promise<{
    status: number;
    body: {
      ok?: boolean;
      error?: string;
      code?: string;
      payment_id?: string;
      checkout?: GatewaySession | null;
      meta?: BrowserMetaEvent | null;
    };
  }>;
  createWorkspace: (businessName: string) => Promise<{ orgId: string } | { error: string }>;
  openGateway: (session: GatewaySession) => Promise<{ error: string | null }>;
  confirm: (paymentId: string) => Promise<"paid" | "pending" | "failed" | "unknown">;
  onRegistered?: (userId: string, phone: string) => void;
  onAddPaymentInfo?: (meta: BrowserMetaEvent) => void;
  wait?: (ms: number) => Promise<void>;
};

export const PAY_FAILED = "Payment didn't go through — try UPI again or another method.";
const CONFIRM_TRIES = 6;
const CONFIRM_GAP_MS = 1500;

export async function runCheckout(
  values: CheckoutValues & { honeypot?: string },
  deps: CheckoutDeps,
  opts: {
    report?: (phase: Phase) => void;
    /** The sheet already knows this email has an account: sign in, don't sign up. */
    existingAccount?: boolean;
    signedIn?: boolean;
  } = {},
): Promise<CheckoutOutcome> {
  const report = opts.report ?? (() => undefined);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const errors = allErrors(values, { signedIn: opts.signedIn === true });
  const firstBad = (Object.keys(errors) as Array<keyof CheckoutValues>)[0];
  if (firstBad) return { kind: "field", field: firstBad, error: errors[firstBad]! };
  // A hidden field no person fills: a bot gets nowhere and learns nothing.
  if ((values.honeypot ?? "").trim())
    return { kind: "failed", message: PAY_FAILED, paymentId: null };

  // 1. the lead
  report("saving");
  const lead = await deps.saveLead({
    phone: values.phone,
    name: values.name,
    business_name: values.business_name,
    action: "lead",
  });
  if (!lead.ok) {
    const field = lead.field as keyof CheckoutValues | undefined;
    if (field && field in values)
      return { kind: "field", field, error: lead.error ?? "Check this" };
    return { kind: "error", message: lead.error ?? "We couldn't save that. Please try again." };
  }

  // 2. the account
  let auth = await deps.session();
  if (!auth) {
    report("account");
    const email = values.email.trim();
    const tryIn = async () => {
      const signed = await deps.signIn({ email, password: values.password });
      return signed.userId && signed.token ? { userId: signed.userId, token: signed.token } : null;
    };
    if (opts.existingAccount) {
      auth = await tryIn();
      if (!auth) {
        return {
          kind: "needs_password",
          message: "That password doesn't match this email's AiDwar account. Try again.",
        };
      }
    } else {
      const made = await deps.signUp({
        email,
        password: values.password,
        phone: values.phone,
        fullName: values.name.trim().replace(/\s+/g, " "),
      });
      if (made.error) {
        if (!isExistingAccountError(made.error)) return { kind: "error", message: made.error };
        // The email already has an account: their typed password may be it.
        auth = await tryIn();
        if (!auth) {
          return {
            kind: "needs_password",
            message: "This email already has an AiDwar account — enter its password to continue.",
          };
        }
      } else if (made.userId && made.token) {
        deps.onRegistered?.(made.userId, values.phone);
        auth = { userId: made.userId, token: made.token };
      } else {
        return {
          kind: "error",
          message: "Check your email to confirm your account, then come back here to pay.",
        };
      }
    }
  }

  // 3. the payment (the workspace first, when there is none)
  report("opening");
  let started = await deps.startPay(auth.token, { phone: values.phone, action: "pay" });
  if (started.status === 409 && started.body.code === "needs_workspace") {
    report("workspace");
    const made = await deps.createWorkspace(values.business_name.trim().replace(/\s+/g, " "));
    if ("error" in made) return { kind: "error", message: made.error };
    report("opening");
    started = await deps.startPay(auth.token, {
      phone: values.phone,
      organization_id: made.orgId,
      action: "pay",
    });
  }
  if (started.status === 409 && started.body.code === "already_on_plan") {
    return { kind: "already", firstName: firstName(values.name) };
  }
  const paymentId = started.body.payment_id ?? null;
  if (!started.body.ok || !paymentId) {
    return {
      kind: "error",
      message: started.body.error ?? "We couldn't start the payment. Please try again.",
    };
  }
  if (started.body.meta) deps.onAddPaymentInfo?.(started.body.meta);
  if (!started.body.checkout) {
    return { kind: "failed", message: PAY_FAILED, paymentId };
  }

  // 4. Cashfree's popup, then our server's word
  report("paying");
  const opened = await deps.openGateway(started.body.checkout);
  report("confirming");
  let status = await deps.confirm(paymentId);
  for (let i = 1; i < CONFIRM_TRIES && (status === "pending" || status === "unknown"); i++) {
    if (opened.error && status !== "pending") break;
    await wait(CONFIRM_GAP_MS);
    status = await deps.confirm(paymentId);
  }
  if (status === "paid") return { kind: "paid", paymentId, firstName: firstName(values.name) };
  return { kind: "failed", message: PAY_FAILED, paymentId };
}
