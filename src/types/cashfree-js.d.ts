// @cashfreepayments/cashfree-js ships no types: the parts AiDwar uses.
declare module "@cashfreepayments/cashfree-js" {
  export type CashfreeMode = "sandbox" | "production";
  export type CashfreeResult = {
    error?: { message?: string };
    redirect?: boolean;
    paymentDetails?: unknown;
  };
  export interface CashfreeInstance {
    checkout(options: {
      paymentSessionId: string;
      redirectTarget?: "_self" | "_blank" | "_top" | "_modal";
    }): Promise<CashfreeResult>;
    subscriptionsCheckout(options: {
      subsSessionId: string;
      redirectTarget?: "_self" | "_blank" | "_top";
    }): Promise<CashfreeResult>;
  }
  export function load(options: { mode: CashfreeMode }): Promise<CashfreeInstance | null>;
}
