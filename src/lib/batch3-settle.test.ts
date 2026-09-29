import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp, type FakeRpc } from "./test-support/fake-db";

const h = vi.hoisted(() => ({
  activate: vi.fn(async () => true),
  db: null as null | { supabase: unknown },
}));
vi.mock("@/lib/plan-purchase.server", () => ({ activatePlanFromPayment: h.activate }));
vi.mock("@/lib/invoices.server", () => ({
  loadSupplier: async () => ({ sac_messaging: "998599" }),
  buildInvoice: async () => ({ error: "not in tests" }),
  issueInvoice: async () => ({ error: "not in tests" }),
  markPaid: async () => {},
  invoiceForPayment: async () => ({ error: "not in tests" }),
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/razorpay.server", () => ({
  razorpayWebhookSecret: async () => "secret",
  verifyWebhookSignature: () => true,
}));

import {
  amountProblem,
  capturedFromWebhook,
  expectedGrossPaise,
  isSettleError,
  settlePayment,
} from "./billing.server";
import { Route as WebhookRoute } from "../routes/api/public/razorpay-webhook";

const PAYMENT = {
  id: "pay-1",
  organization_id: "org-1",
  status: "pending",
  amount: 2000,
  currency: "INR",
  credit_pack_id: null,
  coupon_id: null,
  purpose: "credit_purchase",
  raw: { pack_amount: 2000, gst: 360, gross: 2360, bonus: 100, pack_name: "Starter" },
};

const webhook = (paise: number, status = "captured") => ({
  event: "payment_link.paid",
  payload: {
    payment: { entity: { id: "pay_rzp_1", amount: paise, currency: "INR", status, method: "upi", vpa: "a@upi" } },
    payment_link: { entity: { id: "plink_1", amount_paid: paise, notes: { payment_id: "pay-1" } } },
  },
});

type Opts = {
  payment?: Record<string, unknown>;
  ledger?: string[];
  applyError?: { code?: string; message: string } | null;
  paidError?: { message: string } | null;
  claimLost?: boolean;
};

function world(o: Opts = {}) {
  const log: string[] = [];
  const db = fakeDb(
    (op: FakeOp) => {
      if (op.table === "payments" && op.kind === "select") return { data: { ...PAYMENT, ...(o.payment ?? {}) }, error: null };
      if (op.table === "payments" && op.kind === "update") {
        const p = op.payload as Record<string, unknown>;
        if (p["status"] === "paid") {
          log.push("paid");
          return { data: null, error: o.paidError ?? null };
        }
        const raw = (p["raw"] ?? {}) as Record<string, unknown>;
        if (raw["settle_claimed_at"] && op.filters.some(([n]) => n === "or")) {
          log.push("claim");
          return { data: o.claimLost ? [] : [{ id: "pay-1" }], error: null };
        }
        log.push(raw["settle_error"] ? "release" : raw["amount_check"] ? "amount_check" : "raw");
        return { data: null, error: null };
      }
      if (op.table === "wallet_ledger") {
        const type = op.filters.find(([n, a]) => n === "eq" && a[0] === "entry_type")?.[1][1] as string;
        return { data: (o.ledger ?? []).includes(type) ? [{ id: "l1" }] : [], error: null };
      }
      if (op.table === "coupons" && op.kind === "select")
        return { data: { id: "cp-1", kind: "bonus_credits", value: 50, uses: 3 }, error: null };
      if (op.table === "coupons" && op.kind === "update") {
        log.push("coupon_use");
        return { data: null, error: null };
      }
      if (op.table === "billing_notifications") {
        log.push(`notify:${(op.payload as { audience: string }).audience}`);
        return { data: null, error: null };
      }
      return undefined;
    },
    (call: FakeRpc) => {
      if (call.name === "wallet_apply") {
        log.push(`credit:${call.args["p_type"]}`);
        return { data: "entry", error: o.applyError ?? null };
      }
      return undefined;
    },
  );
  return { ...db, log };
}

const notifications = (db: ReturnType<typeof world>) =>
  db.ops.filter((op) => op.table === "billing_notifications").map((op) => op.payload as Record<string, unknown>);

beforeEach(() => {
  h.activate.mockReset();
  h.activate.mockResolvedValue(true);
});

describe("(3) amount checks", () => {
  it("expected gross comes from the figures frozen on the payment", () => {
    expect(expectedGrossPaise({ gross: 2360 })).toBe(236000);
    expect(expectedGrossPaise({ gross_amount: 5898.82 })).toBe(589882);
    expect(expectedGrossPaise({})).toBeNull();
  });
  it("captured amount from the payment entity, else the link", () => {
    expect(capturedFromWebhook(webhook(236000)).paise).toBe(236000);
    expect(capturedFromWebhook({ payload: { payment_link: { entity: { amount_paid: 1000 } } } }).paise).toBe(1000);
  });
  it("mismatch, missing figures, wrong status or currency are problems", () => {
    const c = (paise: number | null, status: string | null = "captured", currency: string | null = "INR") => ({ paise, status, currency });
    expect(amountProblem(236000, c(236000), "INR")).toBeNull();
    expect(amountProblem(236000, c(100), "INR")).toMatch(/captured 100/);
    expect(amountProblem(null, c(236000), "INR")).toMatch(/no expected/);
    expect(amountProblem(236000, c(null), "INR")).toMatch(/no captured/);
    expect(amountProblem(236000, c(236000, "authorized"), "INR")).toMatch(/authorized/);
    expect(amountProblem(236000, c(236000, "captured", "USD"), "INR")).toMatch(/currency/);
  });
});

describe("(3) settlePayment", () => {
  it("credits first, then marks paid", async () => {
    const db = world();
    const out = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(out.credited).toBe(true);
    expect(db.log.slice(0, 4)).toEqual(["claim", "credit:credit_purchase", "credit:bonus_credits", "paid"]);
    const credit = db.rpcs.find((r) => r.args["p_type"] === "credit_purchase")!;
    expect(credit.args["p_amount"]).toBe(2000);
    expect(credit.args["p_metadata"]).toEqual({ payment_id: "pay-1" });
    // Unchanged: the top-up task and the merchant's notice; no failure alert.
    expect(notifications(db).map((n) => `${n["audience"]}:${n["kind"]}`)).toEqual([
      "admin:topup_due",
      "client:credits_added",
    ]);
  });

  it("a failed credit leaves the payment unpaid, releases the claim, tells an admin and throws (retryable)", async () => {
    const db = world({ applyError: { message: "boom" } });
    const err = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000)).catch((e) => e);
    expect(isSettleError(err)).toBe(true);
    expect(db.log).not.toContain("paid");
    expect(db.log).toContain("release");
    expect(notifications(db)).toEqual([
      expect.objectContaining({ audience: "admin", kind: "settle_failed" }),
    ]);
  });

  it("the same failure again doesn't alert admins twice", async () => {
    const db = world({
      applyError: { message: "boom" },
      payment: { raw: { ...PAYMENT.raw, settle_error: "wallet_apply credit_purchase failed: boom" } },
    });
    await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000)).catch(() => null);
    expect(notifications(db)).toHaveLength(0);
  });

  it("a retry after a partial credit doesn't credit twice", async () => {
    const db = world({ ledger: ["credit_purchase"] });
    await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(db.log.filter((l) => l.startsWith("credit:"))).toEqual(["credit:bonus_credits"]);
    expect(db.log).toContain("paid");
  });

  it("a unique conflict from the ledger index counts as already credited", async () => {
    const db = world({ applyError: { code: "23505", message: "duplicate" } });
    const out = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(out.credited).toBe(true);
    expect(db.log).toContain("paid");
  });

  it("if marking paid fails the error is raised (the credits already in stay single on retry)", async () => {
    const db = world({ paidError: { message: "down" } });
    await expect(settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000))).rejects.toSatisfy(isSettleError);
  });

  it("a captured amount that doesn't match is never credited or marked paid; admins are told", async () => {
    const db = world();
    const out = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(100));
    expect(out.credited).toBe(false);
    expect(db.rpcs).toHaveLength(0);
    expect(db.log).toEqual(["amount_check", "notify:admin"]);
    expect(String(notifications(db)[0]!["payload"] && (notifications(db)[0]!["payload"] as Record<string, unknown>)["reason"])).toMatch(/amount mismatch/);
  });

  it("an authorised (not captured) payment isn't credited", async () => {
    const db = world();
    await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000, "authorized"));
    expect(db.rpcs).toHaveLength(0);
    expect(db.log).not.toContain("paid");
  });

  it("another delivery holding the claim: this one does nothing", async () => {
    const db = world({ claimLost: true });
    const out = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(out.credited).toBe(false);
    expect(db.rpcs).toHaveLength(0);
    expect(db.log).not.toContain("paid");
  });

  it("a coupon's credits and its use are counted once per payment", async () => {
    const db = world({ payment: { coupon_id: "cp-1" } });
    await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(db.log.slice(0, 6)).toEqual([
      "claim",
      "credit:credit_purchase",
      "credit:bonus_credits",
      "credit:coupon_credits",
      "coupon_use",
      "raw",
    ]);
    expect(db.log[6]).toBe("paid");
    const coupon = db.rpcs.find((r) => r.args["p_type"] === "coupon_credits")!;
    expect(coupon.args["p_metadata"]).toEqual({ coupon_id: "cp-1", payment_id: "pay-1" });

    const retry = world({
      payment: { coupon_id: "cp-1", raw: { ...PAYMENT.raw, coupon_counted: true } },
      ledger: ["credit_purchase", "bonus_credits", "coupon_credits"],
    });
    await settlePayment(retry.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(retry.rpcs.filter((r) => r.name === "wallet_apply")).toHaveLength(0);
    expect(retry.log).not.toContain("coupon_use");
    expect(retry.log).toContain("paid");
  });

  it("unchanged: an already-paid payment is left alone", async () => {
    const db = world({ payment: { status: "paid" } });
    const out = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook(236000));
    expect(out.credited).toBe(false);
    expect(db.log).toEqual([]);
  });

  it("plan purchase: marked paid only after the plan is activated", async () => {
    const plan = { purpose: "plan_fee", raw: { kind: "plan_purchase", plan_version_id: "pv1", gross_amount: 5898.82 } };
    const ok = world({ payment: plan });
    await settlePayment(ok.supabase, "pay-1", "pay_rzp_1", webhook(589882));
    expect(ok.log).toEqual(["claim", "paid"]);
    expect(ok.rpcs).toHaveLength(0);

    h.activate.mockResolvedValue(false);
    const bad = world({ payment: plan });
    await expect(settlePayment(bad.supabase, "pay-1", "pay_rzp_1", webhook(589882))).rejects.toSatisfy(isSettleError);
    expect(bad.log).not.toContain("paid");
  });
});

describe("(3) Razorpay webhook retries a failed settlement", () => {
  type Post = (a: { request: Request }) => Promise<Response>;
  const post = (WebhookRoute.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
  const call = (body: unknown) =>
    post({
      request: new Request("http://x/api/public/razorpay-webhook", {
        method: "POST",
        headers: { "x-razorpay-signature": "sig", "x-razorpay-event-id": "evt_1" },
        body: JSON.stringify(body),
      }),
    });

  const hook = (o: Opts & { eventRow?: "new" | "failed_before" | "done_before" }) => {
    const base = world(o);
    const db = fakeDb(
      (op) => {
        if (op.table === "webhook_events" && op.kind === "insert")
          return o.eventRow === "new" || !o.eventRow
            ? { data: { id: "we-1" }, error: null }
            : { data: null, error: { code: "23505", message: "dup" } };
        if (op.table === "webhook_events" && op.kind === "update" && op.filters.some(([n]) => n === "not"))
          return { data: o.eventRow === "failed_before" ? { id: "we-1" } : null, error: null };
        return undefined;
      },
    );
    // Route the money tables to the payment world, events to this one.
    const client = {
      from: (t: string) => (t === "webhook_events" ? db.supabase.from(t) : base.supabase.from(t)),
      rpc: (n: string, a: Record<string, unknown>) => base.supabase.rpc(n, a),
    };
    h.db = { supabase: client };
    return { base, db };
  };

  it("a failed credit answers 500 so Razorpay delivers again", async () => {
    const { base } = hook({ applyError: { message: "boom" } });
    const res = await call(webhook(236000));
    expect(res.status).toBe(500);
    expect(base.log).not.toContain("paid");
  });

  it("the redelivery of an event that failed is processed again", async () => {
    const { base } = hook({ eventRow: "failed_before" });
    const res = await call(webhook(236000));
    expect(res.status).toBe(200);
    expect(base.log).toContain("paid");
  });

  it("unchanged: a replay of an event that succeeded is dropped", async () => {
    const { base } = hook({ eventRow: "done_before" });
    const res = await call(webhook(236000));
    expect(res.status).toBe(200);
    expect(base.log).toEqual([]);
  });

  it("unchanged: a mismatch still answers 200 (a human decides, retrying won't help)", async () => {
    const { base } = hook({});
    const res = await call(webhook(100));
    expect(res.status).toBe(200);
    expect(base.log).not.toContain("paid");
  });
});
