import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 31 — Cashfree as AiDwar's own payment gateway. No live Cashfree and
 * no live database: Cashfree is a fake speaking its documented PG API
 * (x-api-version 2025-01-01), the webhooks are its documented sandbox
 * samples (test-support/cashfree-sandbox), the database is the in-memory one.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  perms: new Set<string>(),
  rzpKeys: { keyId: "rzp_test_x", keySecret: "rzp_test_secret_not_real" } as null | {
    keyId: string;
    keySecret: string;
  },
  createPaymentLink: vi.fn(),
  buildInvoice: vi.fn(),
  issueInvoice: vi.fn(),
  markPaid: vi.fn(),
  creditNote: vi.fn(),
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/permissions.server", () => ({
  hasPermission: async (_s: unknown, _o: string, _u: string, key: string) => h.perms.has(key),
}));
vi.mock("@/lib/invoices.server", () => ({
  loadSupplier: async () => ({ sac_messaging: "998599", sac_platform: "998314" }),
  buildInvoice: h.buildInvoice,
  issueInvoice: h.issueInvoice,
  markPaid: h.markPaid,
  invoiceForPayment: async () => ({ error: "not in tests" }),
}));
vi.mock("@/lib/credit-notes.server", () => ({ issueCreditNote: h.creditNote }));
vi.mock("@/lib/billing-statement.server", () => ({
  buildStatementLines: async () => [],
  planFeeRoiSnapshot: async () => null,
}));
vi.mock("@/lib/dunning.server", () => ({
  restoreAfterPayment: async () => {},
  lockWorkspace: async () => {},
}));
vi.mock("@/lib/razorpay.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./razorpay.server")>()),
  razorpayKeys: async () => h.rzpKeys,
  createPaymentLink: h.createPaymentLink,
}));

import {
  CASHFREE_API_VERSION,
  cashfreeConfig,
  cashfreeSignature,
  verifyCashfreeSignature,
  webhookTimestampFresh,
} from "./cashfree.server";
import {
  CASHFREE_WEBHOOK_URL,
  confirmCashfreePayment,
  paymentGateway,
  resetConfirmThrottle,
} from "./cashfree-billing.server";
import { refundPayment } from "./cashfree-refunds.server";
import {
  applyCashfreeSubscriptionEvent,
  getAutoPay,
  PAY_PER_PERIOD_NOTE,
  setupAutoPay,
} from "./subscriptions.server";
import { createCreditPurchase, isPermissionError, PermissionError } from "./billing.server";
import { APP_PUBLIC_URL } from "./app-url";
import { Route as WebhookRoute } from "../routes/api/public/cashfree-webhook";
import { Route as PayRoute } from "../routes/api/public/cashfree-pay";

const SAMPLE_DIR = new URL("./test-support/cashfree-sandbox/", import.meta.url);
const sample = (name: string) => readFileSync(new URL(name, SAMPLE_DIR), "utf8").replace(/\n$/, "");

const CLIENT_SECRET = "not-a-real-client-secret";
const WEBHOOK_SECRET = "not-a-real-webhook-secret";
const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const PAY = "33333333-3333-4333-8333-333333333333";
const SUPER = "44444444-4444-4444-8444-444444444444";

// ------------------------------------------------------------------ world

type World = MemoryDb & { flag: { on: boolean } };

/** Unique keys the real tables have: reserved at insert() time, so racing inserts collide. */
function uniqueOn(
  db: MemoryDb,
  table: string,
  cols: string[],
  when: (r: Row) => boolean = () => true,
) {
  const client = db.supabase as unknown as { from: (t: string) => Record<string, unknown> };
  const from = client.from.bind(client);
  const reserved = new Set<string>();
  client.from = (name: string) => {
    const b = from(name);
    if (name !== table) return b;
    const insert = b["insert"] as (p: unknown, o?: unknown) => unknown;
    b["insert"] = (p: unknown, o?: unknown) => {
      const rows = (Array.isArray(p) ? p : [p]) as Row[];
      const keyOf = (r: Row) => cols.map((c) => String(r[c])).join("|");
      const taken = rows.some(
        (r) =>
          when(r) &&
          cols.every((c) => r[c] != null) &&
          (reserved.has(keyOf(r)) || db.rows(table).some((x) => when(x) && keyOf(x) === keyOf(r))),
      );
      if (taken) {
        b["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: { code: "23505", message: `duplicate key on ${table}` },
          }).then(res, rej);
        return b;
      }
      for (const r of rows) if (when(r) && cols.every((c) => r[c] != null)) reserved.add(keyOf(r));
      return insert(p, o);
    };
    return b;
  };
}

function world(
  extra: Record<string, Row[]> = {},
  options: { flag?: boolean; failCredit?: number } = {},
): World {
  const flag = { on: options.flag ?? true };
  let failCredit = options.failCredit ?? 0;
  const db = memoryDb(
    {
      organizations: [
        {
          id: ORG,
          name: "Zoori Jewels",
          billing_account_id: "ba-1",
          plan_status: "active",
          plan_version_id: "pv-1",
        },
      ],
      billing_accounts: [
        { id: "ba-1", name: "Zoori", billing_email: "accounts@zoori.test", billing_whatsapp: null },
      ],
      organization_members: [{ organization_id: ORG, user_id: OWNER, role: "owner" }],
      profiles: [
        { id: OWNER, full_name: "Asha Rao", email: "asha@zoori.test", phone: "+91 98765 43210" },
        { id: SUPER, is_super_admin: true },
      ],
      wallet_balances: [{ organization_id: ORG, balance: 0 }],
      wallet_ledger: [],
      // Batch 55: these tests pin today's GST-registered figures.
      platform_settings: [{ id: true, gst_registered: true }],
      ...extra,
    },
    {
      org_flag_enabled: (a) => ({
        data: a["p_flag"] === "cashfree_billing" ? flag.on : true,
        error: null,
      }),
      wallet_apply_version: () => ({ data: 2, error: null }),
      wallet_apply: (a, d) => {
        if (failCredit > 0 && a["p_type"] === "credit_purchase") {
          failCredit -= 1;
          return { data: null, error: { message: "canceling statement due to statement timeout" } };
        }
        const ledger = d.rows("wallet_ledger");
        const once =
          a["p_ref_type"] === "payment" &&
          ["credit_purchase", "bonus_credits", "coupon_credits"].includes(String(a["p_type"]));
        // wallet_ledger_payment_credit_once
        if (
          once &&
          ledger.some(
            (l) =>
              l["reference_type"] === "payment" &&
              l["reference_id"] === a["p_ref_id"] &&
              l["entry_type"] === a["p_type"],
          )
        ) {
          return {
            data: null,
            error: { code: "23505", message: "wallet_ledger_payment_credit_once" },
          };
        }
        const balance = d.rows("wallet_balances").find((b) => b["organization_id"] === a["p_org"])!;
        // Batch 26a: 'adjustment' is signed, everything else here adds.
        const signed =
          a["p_type"] === "adjustment" ? Number(a["p_amount"]) : Math.abs(Number(a["p_amount"]));
        if (Number(balance["balance"]) + signed < 0)
          return { data: null, error: { message: "INSUFFICIENT_CREDITS" } };
        balance["balance"] = Math.round((Number(balance["balance"]) + signed) * 100) / 100;
        const id = `ledger-${ledger.length + 1}`;
        ledger.push({
          id,
          organization_id: a["p_org"],
          entry_type: a["p_type"],
          amount: a["p_amount"],
          reference_type: a["p_ref_type"],
          reference_id: a["p_ref_id"],
          metadata: a["p_metadata"],
        });
        return { data: id, error: null };
      },
    },
  );
  uniqueOn(db, "webhook_events", ["provider", "external_event_id"]);
  uniqueOn(db, "payments", ["provider_payment_id"], (r) => r["provider"] === "cashfree");
  h.db = { supabase: db.supabase };
  return Object.assign(db, { flag });
}

const creditPayment = (o: Row = {}): Row => ({
  id: PAY,
  organization_id: ORG,
  provider: "cashfree",
  purpose: "credit_purchase",
  status: "pending",
  amount: 2000,
  currency: "INR",
  credit_pack_id: null,
  coupon_id: null,
  created_at: new Date().toISOString(),
  raw: {
    pack_amount: 2000,
    gst: 360,
    gross: 2360,
    bonus: 100,
    pack_name: "Starter",
    cashfree: { env: "sandbox", order_id: PAY, payment_session_id: `session_${PAY}` },
  },
  ...o,
});

const credits = (db: MemoryDb) =>
  db
    .rows("wallet_ledger")
    .filter((l) => ["credit_purchase", "bonus_credits"].includes(String(l["entry_type"])));
const paymentRow = (db: MemoryDb, id = PAY) => db.rows("payments").find((p) => p["id"] === id)!;

// --------------------------------------------------------------- Cashfree

type FakeState = {
  orders: Map<string, Row>;
  payments: Map<string, Row[]>;
  refuseRefunds?: boolean;
};
type Call = { method: string; path: string; headers: Record<string, string>; body: Row | null };

function fakeCashfree(state: Partial<FakeState> = {}) {
  const s: FakeState = { orders: new Map(), payments: new Map(), ...state };
  const calls: Call[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Row) : null;
    calls.push({
      method,
      path: url.pathname,
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    });
    let m: RegExpMatchArray | null;
    if (method === "POST" && url.pathname === "/pg/orders") {
      const order = {
        cf_order_id: 2149460581,
        order_id: body!["order_id"],
        order_amount: body!["order_amount"],
        order_currency: body!["order_currency"],
        order_status: "ACTIVE",
        payment_session_id: `session_${String(body!["order_id"])}`,
        order_expiry_time: "2026-10-27T10:00:00+05:30",
      };
      s.orders.set(String(body!["order_id"]), order);
      return json(200, order);
    }
    if (method === "GET" && (m = url.pathname.match(/^\/pg\/orders\/([^/]+)$/))) {
      const order = s.orders.get(decodeURIComponent(m[1]!));
      return order
        ? json(200, order)
        : json(404, { message: "order not found", code: "order_not_found" });
    }
    if (method === "GET" && (m = url.pathname.match(/^\/pg\/orders\/([^/]+)\/payments$/))) {
      return json(200, s.payments.get(decodeURIComponent(m[1]!)) ?? []);
    }
    if (method === "POST" && (m = url.pathname.match(/^\/pg\/orders\/([^/]+)\/refunds$/))) {
      if (s.refuseRefunds)
        return json(400, { message: "refund amount is greater than refundable amount" });
      return json(200, {
        cf_refund_id: "88871234",
        cf_payment_id: "5114910000001",
        refund_id: body!["refund_id"],
        order_id: decodeURIComponent(m[1]!),
        refund_amount: body!["refund_amount"],
        refund_status: "PENDING",
      });
    }
    return json(404, { message: "no such route in the fake" });
  };
  vi.stubGlobal("fetch", fetchFn);
  return { state: s, calls };
}

/** A Cashfree SUCCESS payment, shaped like the sandbox sample, for our own order. */
function successPayment(amount: number, cfPaymentId = "5114910000001"): Row {
  const base = JSON.parse(sample("payment-success.json")) as { data: { payment: Row } };
  return { ...base.data.payment, cf_payment_id: cfPaymentId, payment_amount: amount };
}

/** The documented PAYMENT_SUCCESS sample, pointed at our payment and amount. */
function successWebhook(orderId: string, amount: number, cfPaymentId = "5114910000001"): string {
  const body = JSON.parse(sample("payment-success.json")) as { data: Row };
  body.data["order"] = { ...(body.data["order"] as Row), order_id: orderId, order_amount: amount };
  body.data["payment"] = successPayment(amount, cfPaymentId);
  return JSON.stringify(body);
}

function failedWebhook(
  orderId: string,
  type = "PAYMENT_FAILED_WEBHOOK",
  cfPaymentId = "5114910000002",
): string {
  const body = JSON.parse(sample("payment-failed.json")) as { type: string; data: Row };
  body.type = type;
  body.data["order"] = { ...(body.data["order"] as Row), order_id: orderId };
  body.data["payment"] = {
    ...(body.data["payment"] as Row),
    cf_payment_id: cfPaymentId,
    payment_status: type === "PAYMENT_USER_DROPPED_WEBHOOK" ? "USER_DROPPED" : "FAILED",
  };
  if (type === "PAYMENT_USER_DROPPED_WEBHOOK") {
    // A dropped checkout carries no error_details; with no message either, our own words stand.
    delete body.data["error_details"];
    delete (body.data["payment"] as Row)["payment_message"];
  }
  return JSON.stringify(body);
}

type Post = (a: { request: Request }) => Promise<Response>;
const postWebhook = (WebhookRoute.options as unknown as { server: { handlers: { POST: Post } } })
  .server.handlers.POST;
const payHandlers = (
  PayRoute.options as unknown as { server: { handlers: { GET: Post; POST: Post } } }
).server.handlers;

function deliver(raw: string, o: { secret?: string; timestamp?: string; signature?: string } = {}) {
  const timestamp = o.timestamp ?? String(Date.now());
  const signature = o.signature ?? cashfreeSignature(raw, timestamp, o.secret ?? CLIENT_SECRET);
  return postWebhook({
    request: new Request("https://aidwar.in/api/public/cashfree-webhook", {
      method: "POST",
      headers: {
        "x-webhook-signature": signature,
        "x-webhook-timestamp": timestamp,
        "content-type": "application/json",
      },
      body: raw,
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("CASHFREE_CLIENT_ID", "TEST-not-a-real-client-id");
  vi.stubEnv("CASHFREE_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("CASHFREE_ENV", "sandbox");
  vi.stubEnv("CASHFREE_WEBHOOK_SECRET", "");
  vi.stubEnv("CASHFREE_SUBSCRIPTIONS_ENABLED", "");
  h.perms = new Set(["billing.pay", "cashfree_billing.pay"]);
  h.rzpKeys = { keyId: "rzp_test_x", keySecret: "rzp_test_secret_not_real" };
  h.createPaymentLink.mockReset();
  h.createPaymentLink.mockResolvedValue({
    link: { id: "plink_1", short_url: "https://rzp.io/i/abc", raw: { id: "plink_1" } },
    error: null,
  });
  h.buildInvoice.mockReset();
  h.buildInvoice.mockResolvedValue({ invoice_id: "inv-1" });
  h.issueInvoice.mockReset();
  h.issueInvoice.mockResolvedValue({ invoice_number: "AD/2026-27/0001" });
  h.markPaid.mockReset();
  h.markPaid.mockResolvedValue({});
  h.creditNote.mockReset();
  h.creditNote.mockImplementation(async (_s: unknown, input: { amount: number }) => ({
    credit_note_id: "cn-1",
    number: "CN/2026-27/0001",
    amount: input.amount,
    refunded: false,
    pdf_path: null,
  }));
  resetConfirmThrottle();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------- signature

describe("webhook signature: base64(HMAC-SHA256(timestamp + raw body))", () => {
  // Computed outside the code under test (openssl; see cashfree-sandbox/README.md).
  const TS = "1736919970000";
  const SIGNED = {
    success: {
      plain: "0H3Y6Kf0DPhsLw9OhfWXQBJ9GczyUmnn+ACdPVe1Rjw=",
      dot: "TR3vXL9vnIQwq0LskYBhx7/OQcj6iB7Pg8xaWZVKJPM=",
      webhookSecret: "WlJTD4dnsPmxxRf5VCsoSxMdJIGvBj2oExnW7Nf6XFw=",
    },
    failed: { plain: "uR+bc405vHCcoxyJh0SSg7xyZH4kMD7ktg+jbF/TunU=" },
  };
  const success = sample("payment-success.json");

  it("the sandbox sample verifies with the client secret (timestamp + body, no separator)", () => {
    expect(verifyCashfreeSignature(success, TS, SIGNED.success.plain, CLIENT_SECRET)).toBe(true);
    expect(
      verifyCashfreeSignature(
        sample("payment-failed.json"),
        TS,
        SIGNED.failed.plain,
        CLIENT_SECRET,
      ),
    ).toBe(true);
    expect(cashfreeSignature(success, TS, CLIENT_SECRET)).toBe(SIGNED.success.plain);
  });

  it("which key and form matched is reported (for the logs), never the key", async () => {
    const { matchCashfreeSignature } = await import("./cashfree.server");
    const keys = [CLIENT_SECRET, WEBHOOK_SECRET];
    expect(matchCashfreeSignature(success, TS, SIGNED.success.plain, keys)).toEqual({
      key: "client_secret",
      form: "plain",
    });
    expect(matchCashfreeSignature(success, TS, SIGNED.success.dot, keys)).toEqual({
      key: "client_secret",
      form: "dot",
    });
    expect(matchCashfreeSignature(success, TS, SIGNED.success.webhookSecret, keys)).toEqual({
      key: "webhook_secret",
      form: "plain",
    });
    expect(matchCashfreeSignature(success, TS, "bm9wZQ==", keys)).toBeNull();
  });

  it('the "." form from Cashfree\'s pseudocode is accepted too', () => {
    expect(verifyCashfreeSignature(success, TS, SIGNED.success.dot, CLIENT_SECRET)).toBe(true);
  });

  it("CASHFREE_WEBHOOK_SECRET, when set and different, is accepted alongside the client secret", () => {
    const both = cashfreeConfig({
      CASHFREE_CLIENT_ID: "id",
      CASHFREE_CLIENT_SECRET: CLIENT_SECRET,
      CASHFREE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    })!;
    expect(both.webhookSecrets).toEqual([CLIENT_SECRET, WEBHOOK_SECRET]);
    expect(
      verifyCashfreeSignature(success, TS, SIGNED.success.webhookSecret, both.webhookSecrets),
    ).toBe(true);
    expect(verifyCashfreeSignature(success, TS, SIGNED.success.plain, both.webhookSecrets)).toBe(
      true,
    );
    // Not set, or the same value: the client secret only.
    const only = cashfreeConfig({
      CASHFREE_CLIENT_ID: "id",
      CASHFREE_CLIENT_SECRET: CLIENT_SECRET,
    })!;
    expect(only.webhookSecrets).toEqual([CLIENT_SECRET]);
    expect(
      verifyCashfreeSignature(success, TS, SIGNED.success.webhookSecret, only.webhookSecrets),
    ).toBe(false);
    const same = cashfreeConfig({
      CASHFREE_CLIENT_ID: "id",
      CASHFREE_CLIENT_SECRET: CLIENT_SECRET,
      CASHFREE_WEBHOOK_SECRET: CLIENT_SECRET,
    })!;
    expect(same.webhookSecrets).toEqual([CLIENT_SECRET]);
  });

  it("bad: a re-serialised body (2.00 -> 2), another timestamp, another key, empty parts", () => {
    const reserialised = JSON.stringify(JSON.parse(success));
    expect(reserialised).not.toBe(success);
    expect(verifyCashfreeSignature(reserialised, TS, SIGNED.success.plain, CLIENT_SECRET)).toBe(
      false,
    );
    expect(
      verifyCashfreeSignature(success, "1736919970001", SIGNED.success.plain, CLIENT_SECRET),
    ).toBe(false);
    expect(verifyCashfreeSignature(success, TS, SIGNED.success.plain, "another-secret")).toBe(
      false,
    );
    expect(verifyCashfreeSignature(success, TS, "", CLIENT_SECRET)).toBe(false);
    expect(verifyCashfreeSignature(success, "", SIGNED.success.plain, CLIENT_SECRET)).toBe(false);
    expect(verifyCashfreeSignature(success, TS, SIGNED.success.plain, [])).toBe(false);
  });

  it("stale: more than 5 minutes either way is refused; seconds are read as seconds", () => {
    const now = 1_793_000_000_000;
    expect(webhookTimestampFresh(String(now - 60_000), now)).toBe(true);
    expect(webhookTimestampFresh(String(now - 6 * 60_000), now)).toBe(false);
    expect(webhookTimestampFresh(String(now + 6 * 60_000), now)).toBe(false);
    expect(webhookTimestampFresh(String(Math.floor(now / 1000) - 30), now)).toBe(true);
    expect(webhookTimestampFresh("yesterday", now)).toBe(false);
    expect(webhookTimestampFresh(TS, now)).toBe(false);
  });

  it("the route: bad signature 401, stale timestamp 401, nothing stored or credited; good 200", async () => {
    const db = world({ payments: [creditPayment()] });
    const raw = successWebhook(PAY, 2360);
    expect((await deliver(raw, { signature: "bm90IGEgc2lnbmF0dXJl" })).status).toBe(401);
    expect((await deliver(raw, { secret: "another-secret" })).status).toBe(401);
    const old = String(Date.now() - 10 * 60_000);
    expect((await deliver(raw, { timestamp: old })).status).toBe(401);
    expect(db.rows("webhook_events")).toHaveLength(0);
    expect(credits(db)).toHaveLength(0);

    expect((await deliver(raw)).status).toBe(200);
    expect(paymentRow(db)["status"]).toBe("paid");
  });

  it("the route without Cashfree keys refuses everything", async () => {
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "");
    world({ payments: [creditPayment()] });
    expect((await deliver(successWebhook(PAY, 2360))).status).toBe(401);
  });
});

// ----------------------------------------------------- duplicate webhooks

describe("a duplicate webhook credits once", () => {
  it("the same PAYMENT_SUCCESS twice: one credit, one bonus, paid with Cashfree's ids", async () => {
    const db = world({ payments: [creditPayment()] });
    const raw = successWebhook(PAY, 2360);
    expect((await deliver(raw)).status).toBe(200);
    expect((await deliver(raw)).status).toBe(200);

    expect(credits(db).map((l) => [l["entry_type"], l["amount"]])).toEqual([
      ["credit_purchase", 2000],
      ["bonus_credits", 100],
    ]);
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(2100);
    const p = paymentRow(db);
    expect(p).toMatchObject({
      status: "paid",
      provider_payment_id: "5114910000001",
      method: "upi",
    });
    expect(p["raw"]).toMatchObject({
      gross_amount: 2360,
      gst_amount: 360,
      method_detail: "rishab@ybl",
    });
    const events = db.rows("webhook_events");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "cashfree",
      external_event_id: "PAYMENT_SUCCESS_WEBHOOK:5114910000001",
      error: null,
      lease_until: null,
    });
    expect(events[0]!["processed_at"]).toBeTruthy();
  });

  it("a second delivery while the first is still settling: credited once", async () => {
    const db = world({ payments: [creditPayment()] });
    const raw = successWebhook(PAY, 2360);
    // The second starts once the first holds the event row and before it has
    // credited. (Not both at the very first instant: two dynamic imports of a
    // vi.mock'ed module in flight together hand the second the real module —
    // a vitest effect, not the route's.)
    const first = deliver(raw);
    for (let i = 0; i < 1000 && db.rows("webhook_events").length === 0; i++)
      await Promise.resolve();
    expect(db.rows("webhook_events")).toHaveLength(1);
    expect(credits(db)).toHaveLength(0);
    const second = deliver(raw);
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(credits(db)).toHaveLength(2);
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(2100);
  });

  it("two settlements of the same payment at once (webhook and return page): credited once", async () => {
    const db = world({ payments: [creditPayment()] });
    const { handleCashfreeEvent } = await import("./cashfree-billing.server");
    const body = JSON.parse(successWebhook(PAY, 2360)) as Row;
    await Promise.all([
      handleCashfreeEvent(db.supabase, body),
      handleCashfreeEvent(db.supabase, body),
    ]);
    expect(credits(db)).toHaveLength(2);
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(2100);
    expect(paymentRow(db)["status"]).toBe("paid");
  });

  it("a settlement that failed answers 500; Cashfree's retry credits it, once", async () => {
    const db = world({ payments: [creditPayment()] }, { failCredit: 1 });
    const raw = successWebhook(PAY, 2360);
    expect((await deliver(raw)).status).toBe(500);
    expect(paymentRow(db)["status"]).toBe("pending");
    expect(db.rows("webhook_events")[0]!["error"]).toBeTruthy();

    expect((await deliver(raw)).status).toBe(200);
    expect((await deliver(raw)).status).toBe(200);
    expect(paymentRow(db)["status"]).toBe("paid");
    expect(credits(db).filter((l) => l["entry_type"] === "credit_purchase")).toHaveLength(1);
  });

  it("a delivery that died holding its lease is taken again once the lease ran out; a live lease is left alone", async () => {
    const key = "PAYMENT_SUCCESS_WEBHOOK:5114910000001";
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    const live = world({
      payments: [creditPayment()],
      webhook_events: [
        {
          id: "we-1",
          provider: "cashfree",
          external_event_id: key,
          processed_at: null,
          error: null,
          received_at: new Date().toISOString(),
          lease_until: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    expect((await deliver(successWebhook(PAY, 2360))).status).toBe(200);
    expect(credits(live)).toHaveLength(0);

    const died = world({
      payments: [creditPayment()],
      webhook_events: [
        {
          id: "we-2",
          provider: "cashfree",
          external_event_id: key,
          processed_at: null,
          error: null,
          received_at: past,
          lease_until: past,
        },
      ],
    });
    expect((await deliver(successWebhook(PAY, 2360))).status).toBe(200);
    expect(credits(died)).toHaveLength(2);
    expect(died.rows("webhook_events")[0]).toMatchObject({ lease_until: null, error: null });
  });
});

// --------------------------------------------- redirect without webhook

describe("the redirect back is confirmed with GET order, never trusted alone", () => {
  it("order PAID: settled through settlePayment once, whatever arrives after", async () => {
    const db = world({ payments: [creditPayment()] });
    const cf = fakeCashfree();
    cf.state.orders.set(PAY, { order_id: PAY, order_status: "PAID", order_amount: 2360 });
    cf.state.payments.set(PAY, [successPayment(2360)]);

    expect(await confirmCashfreePayment(db.supabase, PAY)).toEqual({ status: "paid" });
    expect(paymentRow(db)).toMatchObject({ status: "paid", provider_payment_id: "5114910000001" });
    expect(credits(db)).toHaveLength(2);
    const asked = cf.calls.map((c) => `${c.method} ${c.path}`);
    expect(asked).toEqual([`GET /pg/orders/${PAY}`, `GET /pg/orders/${PAY}/payments`]);
    expect(cf.calls[0]!.headers).toMatchObject({
      "x-api-version": CASHFREE_API_VERSION,
      "x-client-id": "TEST-not-a-real-client-id",
    });

    // The return page asks again, then the webhook lands: nothing more is credited.
    resetConfirmThrottle();
    expect(await confirmCashfreePayment(db.supabase, PAY)).toEqual({ status: "paid" });
    expect((await deliver(successWebhook(PAY, 2360))).status).toBe(200);
    expect(credits(db)).toHaveLength(2);
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(2100);
  });

  it("order still ACTIVE (customer came back without paying): pending, nothing credited", async () => {
    const db = world({ payments: [creditPayment()] });
    const cf = fakeCashfree();
    cf.state.orders.set(PAY, { order_id: PAY, order_status: "ACTIVE", order_amount: 2360 });
    expect(await confirmCashfreePayment(db.supabase, PAY)).toEqual({ status: "pending" });
    expect(paymentRow(db)["status"]).toBe("pending");
    expect(credits(db)).toHaveLength(0);
  });

  it("the public pay endpoint: GET shows only the amount and the session, POST confirms with Cashfree", async () => {
    const db = world({ payments: [creditPayment()] });
    const cf = fakeCashfree();
    const get = await payHandlers.GET({
      request: new Request(`https://aidwar.in/api/public/cashfree-pay?payment_id=${PAY}`),
    });
    const due = (await get.json()) as Row;
    expect(due).toEqual({
      status: "pending",
      amount: 2360,
      currency: "INR",
      label: "AiDwar credits",
      checkout: { payment_session_id: `session_${PAY}`, mode: "sandbox" },
    });
    expect(JSON.stringify(due)).not.toContain(CLIENT_SECRET);

    cf.state.orders.set(PAY, { order_id: PAY, order_status: "PAID" });
    cf.state.payments.set(PAY, [successPayment(2360)]);
    const post = await payHandlers.POST({
      request: new Request("https://aidwar.in/api/public/cashfree-pay", {
        method: "POST",
        body: JSON.stringify({ payment_id: PAY }),
      }),
    });
    expect(await post.json()).toEqual({ status: "paid" });
    expect(credits(db)).toHaveLength(2);
  });

  it("a Razorpay payment is never touched by the Cashfree confirmation", async () => {
    const db = world({ payments: [creditPayment({ provider: "razorpay" })] });
    const cf = fakeCashfree();
    expect(await confirmCashfreePayment(db.supabase, PAY)).toEqual({ status: "unknown" });
    expect(cf.calls).toHaveLength(0);
    expect(paymentRow(db)["status"]).toBe("pending");
  });
});

// ------------------------------------------------------ failed payments

describe("a failed payment never credits", () => {
  it("PAYMENT_FAILED (sandbox sample): failed with Cashfree's reason, nothing credited", async () => {
    const db = world({ payments: [creditPayment()] });
    expect((await deliver(failedWebhook(PAY))).status).toBe(200);
    const p = paymentRow(db);
    expect(p["status"]).toBe("failed");
    expect((p["raw"] as Row)["failure"]).toMatchObject({
      reason: "payment has failed due to invalid amount",
      event: "PAYMENT_FAILED_WEBHOOK",
      cf_payment_id: "5114910000002",
    });
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("PAYMENT_USER_DROPPED: failed, 'customer left the checkout'", async () => {
    const db = world({ payments: [creditPayment()] });
    expect((await deliver(failedWebhook(PAY, "PAYMENT_USER_DROPPED_WEBHOOK"))).status).toBe(200);
    expect(paymentRow(db)["status"]).toBe("failed");
    expect(((paymentRow(db)["raw"] as Row)["failure"] as Row)["reason"]).toBe(
      "customer left the checkout",
    );
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("a success for a different amount is not credited and an admin is told", async () => {
    const db = world({ payments: [creditPayment()] });
    expect((await deliver(successWebhook(PAY, 1))).status).toBe(200);
    expect(paymentRow(db)["status"]).toBe("pending");
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(((paymentRow(db)["raw"] as Row)["amount_check"] as Row)["reason"]).toMatch(
      /captured 100 paise, expected 236000/,
    );
    expect(db.rows("billing_notifications").map((n) => [n["audience"], n["kind"]])).toContainEqual([
      "admin",
      "settle_failed",
    ]);
  });

  it("a failed try then a success on the same order: paid and credited once", async () => {
    const db = world({ payments: [creditPayment()] });
    await deliver(failedWebhook(PAY));
    expect(paymentRow(db)["status"]).toBe("failed");
    await deliver(successWebhook(PAY, 2360, "5114910000003"));
    await deliver(failedWebhook(PAY)); // a late redelivery of the failure changes nothing
    expect(paymentRow(db)["status"]).toBe("paid");
    expect(credits(db)).toHaveLength(2);
  });

  it("an order AiDwar didn't make (the sample's order_OFR_2): recorded, answered 200, nothing touched", async () => {
    const db = world({ payments: [creditPayment()] });
    const ts = String(Date.now());
    const raw = sample("payment-success.json");
    const res = await deliver(raw, {
      timestamp: ts,
      signature: cashfreeSignature(raw, ts, CLIENT_SECRET),
    });
    expect(res.status).toBe(200);
    expect(db.rows("webhook_events")[0]).toMatchObject({ error: null });
    expect(db.rows("webhook_events")[0]!["processed_at"]).toBeTruthy();
    expect(paymentRow(db)["status"]).toBe("pending");
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("an order Cashfree expired: failed on confirmation, nothing credited", async () => {
    const db = world({ payments: [creditPayment()] });
    const cf = fakeCashfree();
    cf.state.orders.set(PAY, { order_id: PAY, order_status: "EXPIRED" });
    expect(await confirmCashfreePayment(db.supabase, PAY)).toEqual({
      status: "failed",
      reason: "order expired",
    });
    expect(paymentRow(db)["status"]).toBe("failed");
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });
});

// ------------------------------------------------- plan fee once a period

describe("the plan fee is paid once per period", () => {
  const subscription = (o: Row = {}): Row => ({
    id: "sub-row-1",
    organization_id: ORG,
    provider: "cashfree",
    provider_subscription_id: "sub_aidwar_1",
    plan_version_id: "pv-1",
    billing_cycle: "monthly",
    billing_account_id: "ba-1",
    status: "active",
    cancel_at_period_end: false,
    raw: {},
    ...o,
  });
  const charge = (cfPaymentId: string, scheduled: string) => ({
    payment_id: `cfsp_${cfPaymentId}`,
    cf_payment_id: cfPaymentId,
    cf_txn_id: null,
    subscription_id: "sub_aidwar_1",
    cf_subscription_id: "1000901",
    payment_type: "CHARGE",
    payment_amount: 5898.82,
    payment_currency: "INR",
    payment_schedule_date: scheduled,
    payment_initiated_date: scheduled,
    payment_status: "SUCCESS",
  });

  it("an auto-pay charge delivered twice (and replayed) is one payment and one invoice", async () => {
    const db = world({
      subscriptions: [subscription()],
      plan_versions: [{ id: "pv-1", price_monthly: 4999 }],
    });
    const body = {
      type: "SUBSCRIPTION_PAYMENT_SUCCESS",
      event_time: "2026-11-01T10:00:05+05:30",
      data: charge("7700001", "2026-11-01T10:00:00+05:30"),
    };
    const raw = JSON.stringify(body);
    expect((await deliver(raw)).status).toBe(200);
    expect((await deliver(raw)).status).toBe(200);
    // Even past the event record: the charge itself is recognised by its Cashfree payment id.
    await applyCashfreeSubscriptionEvent(db.supabase, body.type, body.data, body);

    const fees = db.rows("payments").filter((p) => p["purpose"] === "plan_fee");
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({
      provider: "cashfree",
      provider_payment_id: "7700001",
      amount: 4999,
      status: "paid",
      method: "mandate",
    });
    expect(h.buildInvoice).toHaveBeenCalledTimes(1);
    expect(h.buildInvoice.mock.calls[0]![2]).toMatchObject({
      purpose: "plan_fee",
      period: { start: "2026-11-01", end: "2026-12-01" },
    });
    expect(h.markPaid).toHaveBeenCalledWith(expect.anything(), "inv-1", fees[0]!["id"], 5898.82);
    expect(db.rows("organizations")[0]!["plan_status"]).toBe("active");

    // The next month is a new charge, a new payment.
    await deliver(
      JSON.stringify({ ...body, data: charge("7700002", "2026-12-01T10:00:00+05:30") }),
    );
    expect(db.rows("payments").filter((p) => p["purpose"] === "plan_fee")).toHaveLength(2);
  });

  it("a pay-per-period invoice paid through its Cashfree link settles the invoice once", async () => {
    const db = world({
      payments: [
        creditPayment({
          purpose: "plan_fee",
          amount: 4999,
          raw: {
            invoice_id: "inv-9",
            gst_amount: 899.82,
            gross_amount: 5898.82,
            cashfree: { env: "sandbox", order_id: PAY },
          },
        }),
      ],
      invoices: [{ id: "inv-9", total: 5898.82, amount_paid: 0 }],
    });
    const raw = successWebhook(PAY, 5898.82);
    await deliver(raw);
    await deliver(raw);
    expect(h.markPaid).toHaveBeenCalledTimes(1);
    expect(h.markPaid).toHaveBeenCalledWith(expect.anything(), "inv-9", PAY, 5898.82);
    expect(paymentRow(db)["status"]).toBe("paid");
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ refunds

describe("a refund adjusts the wallet and raises a credit note", () => {
  const paidCredit = () =>
    world({
      payments: [
        creditPayment({
          status: "paid",
          provider_payment_id: "5114910000001",
          raw: { ...(creditPayment()["raw"] as Row), gross_amount: 2360 },
        }),
      ],
      wallet_balances: [{ organization_id: ORG, balance: 2100 }],
      wallet_ledger: [
        {
          id: "l1",
          entry_type: "credit_purchase",
          amount: 2000,
          reference_type: "payment",
          reference_id: PAY,
          metadata: { payment_id: PAY },
        },
        {
          id: "l2",
          entry_type: "bonus_credits",
          amount: 100,
          reference_type: "payment",
          reference_id: PAY,
          metadata: { payment_id: PAY },
        },
      ],
      invoices: [
        {
          id: "inv-c",
          payment_id: PAY,
          kind: "tax_invoice",
          status: "paid",
          created_at: "2026-10-20T00:00:00Z",
        },
      ],
    });

  it("half refunded: half the credits come off through a signed adjustment, a credit note for the amount", async () => {
    const db = paidCredit();
    const cf = fakeCashfree();
    const out = await refundPayment(db.supabase, {
      actorId: SUPER,
      paymentId: PAY,
      amount: 1180,
      reason: "Bought the wrong pack",
    });
    expect(out).toMatchObject({
      ok: true,
      refund: {
        amount: 1180,
        wallet_adjusted: 1050,
        status: "pending",
        cf_refund_id: "88871234",
        credit_note: "CN/2026-27/0001",
      },
    });

    const adjustment = db.rows("wallet_ledger").find((l) => l["entry_type"] === "adjustment")!;
    expect(adjustment).toMatchObject({
      amount: -1050,
      reference_type: "payment_refund",
      reference_id: PAY,
    });
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(1050);

    const call = cf.calls.find((c) => c.path === `/pg/orders/${PAY}/refunds`)!;
    expect(call.body).toMatchObject({ refund_amount: 1180, refund_note: "Bought the wrong pack" });
    expect(String(call.body!["refund_id"])).toMatch(/^rf_[0-9a-f]{32}$/);

    expect(h.creditNote).toHaveBeenCalledWith(expect.anything(), {
      invoiceId: "inv-c",
      amount: 1180,
      reason: "Refund — Bought the wrong pack",
      refundToWallet: false,
      actorId: SUPER,
    });
    expect(paymentRow(db)["raw"]).toMatchObject({ refunded_amount: 1180 });

    // Cashfree's refund webhook only records the outcome.
    const refundId = String(call.body!["refund_id"]);
    await deliver(
      JSON.stringify({
        type: "REFUND_STATUS_WEBHOOK",
        event_time: "2026-10-26T12:00:00+05:30",
        data: {
          refund: {
            cf_refund_id: 88871234,
            cf_payment_id: 5114910000001,
            refund_id: refundId,
            order_id: PAY,
            refund_amount: 1180,
            refund_status: "SUCCESS",
          },
        },
      }),
    );
    const refunds = (paymentRow(db)["raw"] as Row)["refunds"] as Row[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ refund_id: refundId, status: "success" });
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(1050);
    expect(db.rows("wallet_ledger")).toHaveLength(3);
  });

  it("Cashfree refuses: the credits are put back and the refund is recorded as failed", async () => {
    const db = paidCredit();
    fakeCashfree({ refuseRefunds: true });
    const out = await refundPayment(db.supabase, {
      actorId: SUPER,
      paymentId: PAY,
      amount: 2360,
      reason: "Duplicate payment",
    });
    expect(out).toEqual({
      error: "The payment provider refused this: refund amount is greater than refundable amount",
    });
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(2100);
    expect(h.creditNote).not.toHaveBeenCalled();
    const refunds = (paymentRow(db)["raw"] as Row)["refunds"] as Row[];
    expect(refunds[0]).toMatchObject({ status: "failed", wallet_adjusted: 0 });
    expect(paymentRow(db)["raw"]).toMatchObject({ refunded_amount: 0 });
  });

  it("never more than was paid, never without a reason, never by anyone but a Super Admin", async () => {
    const db = paidCredit();
    fakeCashfree();
    expect(
      await refundPayment(db.supabase, {
        actorId: SUPER,
        paymentId: PAY,
        amount: 2360.01,
        reason: "Too much",
      }),
    ).toEqual({
      error: "That's more than is left to refund: ₹2360 at most.",
    });
    expect(
      await refundPayment(db.supabase, { actorId: SUPER, paymentId: PAY, amount: 10, reason: "" }),
    ).toEqual({
      error: "A refund always needs a reason.",
    });
    await expect(
      refundPayment(db.supabase, {
        actorId: OWNER,
        paymentId: PAY,
        amount: 10,
        reason: "Owner asks",
      }),
    ).rejects.toSatisfy(isPermissionError);
    expect(db.rows("wallet_ledger")).toHaveLength(2);
  });

  it("a plan-fee refund leaves the wallet alone and still raises the credit note", async () => {
    const db = world({
      payments: [
        creditPayment({
          purpose: "plan_fee",
          status: "paid",
          amount: 4999,
          raw: { gross_amount: 5898.82 },
        }),
      ],
      wallet_balances: [{ organization_id: ORG, balance: 300 }],
      invoices: [{ id: "inv-p", payment_id: PAY, kind: "tax_invoice", status: "paid" }],
    });
    fakeCashfree();
    const out = await refundPayment(db.supabase, {
      actorId: SUPER,
      paymentId: PAY,
      amount: 5898.82,
      reason: "Cancelled in week one",
    });
    expect(out).toMatchObject({
      ok: true,
      refund: { wallet_adjusted: 0, credit_note: "CN/2026-27/0001" },
    });
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(300);
  });
});

// ------------------------------------------- merchant Razorpay untouched

describe("the merchant Razorpay flow connection is untouched", () => {
  it("flow connections, the merchant webhook and the flow engine know nothing of Cashfree", () => {
    for (const f of [
      "./flow-connections.server.ts",
      "./flow-engine.server.ts",
      "../routes/api/public/razorpay-flow-webhook/$orgId.ts",
      "../routes/api/integrations/flow-connections.ts",
    ]) {
      expect({
        f,
        cashfree: /cashfree/i.test(readFileSync(new URL(f, import.meta.url), "utf8")),
      }).toEqual({ f, cashfree: false });
    }
  });
});

// ----------------------------------------------------------- the switch

describe("provider switch: the cashfree_billing flag decides new payments", () => {
  const pack = {
    id: "pack-1",
    name: "Starter",
    amount: 2000,
    bonus_amount: 100,
    currency: "INR",
    is_active: true,
  };

  it("paymentGateway: flag on = cashfree; off, failing or not there yet = razorpay", async () => {
    const db = world();
    expect(await paymentGateway(db.supabase, ORG)).toBe("cashfree");
    db.flag.on = false;
    expect(await paymentGateway(db.supabase, ORG)).toBe("razorpay");
    const missing = memoryDb(); // org_flag_enabled answers PGRST202
    expect(await paymentGateway(missing.supabase, ORG)).toBe("razorpay");
    const failing = {
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as Parameters<typeof paymentGateway>[0];
    expect(await paymentGateway(failing, ORG)).toBe("razorpay");
  });

  it("flag off: Buy credits is the Razorpay link exactly as before, Cashfree is never called", async () => {
    const db = world({ credit_packs: [pack] }, { flag: false });
    const cf = fakeCashfree();
    const out = await createCreditPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      packId: "pack-1",
      origin: "https://x",
    });
    expect(out).toEqual({ url: "https://rzp.io/i/abc", payment_id: expect.any(String) });
    expect(cf.calls).toHaveLength(0);
    expect(h.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(h.createPaymentLink.mock.calls[0]![1]).toMatchObject({
      amount: 2360,
      reference: (out as Row)["payment_id"],
    });
    expect(db.rows("payments")[0]).toMatchObject({
      provider: "razorpay",
      status: "pending",
      provider_link_id: "plink_1",
    });
  });

  it("flag on: a Cashfree order for our payment id, GST included, the owner as customer, checkout handed back", async () => {
    const db = world({ credit_packs: [pack] });
    const cf = fakeCashfree();
    const out = (await createCreditPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      packId: "pack-1",
      origin: "https://x",
    })) as Row;
    const paymentId = String(out["payment_id"]);
    expect(out).toEqual({
      url: `${APP_PUBLIC_URL}/pay/${paymentId}`,
      payment_id: paymentId,
      checkout: { payment_session_id: `session_${paymentId}`, mode: "sandbox" },
    });
    expect(h.createPaymentLink).not.toHaveBeenCalled();

    const create = cf.calls.find((c) => c.method === "POST" && c.path === "/pg/orders")!;
    expect(create.headers).toMatchObject({
      "x-api-version": "2025-01-01",
      "x-client-id": "TEST-not-a-real-client-id",
      "x-client-secret": CLIENT_SECRET,
      "x-idempotency-key": paymentId,
    });
    expect(create.body).toMatchObject({
      order_id: paymentId,
      order_amount: 2360,
      order_currency: "INR",
      customer_details: {
        customer_phone: "9876543210",
        customer_email: "asha@zoori.test",
        customer_name: "Asha Rao",
      },
      order_meta: {
        return_url: `${APP_PUBLIC_URL}/app/billing?payment=${paymentId}`,
        notify_url: CASHFREE_WEBHOOK_URL,
      },
      order_tags: { organization_id: ORG, purpose: "credit_purchase" },
    });
    expect(CASHFREE_WEBHOOK_URL).toBe("https://aidwar.in/api/public/cashfree-webhook");
    expect(db.rows("payments")[0]).toMatchObject({
      provider: "cashfree",
      status: "pending",
      amount: 2000,
      provider_order_id: "2149460581",
    });
    expect((db.rows("payments")[0]!["raw"] as Row)["gross"]).toBe(2360);
  });

  it("flag on without Cashfree keys says payments aren't switched on; without cashfree_billing.pay it is refused", async () => {
    const db = world({ credit_packs: [pack] });
    vi.stubEnv("CASHFREE_CLIENT_ID", "");
    const noKeys = await createCreditPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      packId: "pack-1",
      origin: "https://x",
    });
    expect((noKeys as { error: string }).error).toMatch(/aren't switched on yet/);
    expect(h.createPaymentLink).not.toHaveBeenCalled();

    vi.stubEnv("CASHFREE_CLIENT_ID", "TEST-not-a-real-client-id");
    h.perms.delete("cashfree_billing.pay");
    await expect(
      createCreditPurchase(db.supabase, {
        organizationId: ORG,
        userId: OWNER,
        packId: "pack-1",
        origin: "https://x",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(db.rows("payments")).toHaveLength(0);
  });

  it("auto-pay: on Cashfree without Subscriptions it says plainly it's pay-per-period; flag off it is Razorpay", async () => {
    const db = world();
    const status = await getAutoPay(db.supabase, ORG);
    expect(status).toMatchObject({
      gateway: "cashfree",
      pay_per_period: true,
      enabled: false,
      checkout: null,
    });
    expect(
      await setupAutoPay(db.supabase, { organizationId: ORG, userId: OWNER, cycle: "monthly" }),
    ).toEqual({ error: PAY_PER_PERIOD_NOTE });

    db.flag.on = false;
    expect(await getAutoPay(db.supabase, ORG)).toMatchObject({
      gateway: "razorpay",
      pay_per_period: false,
    });
  });

  it("the one live Razorpay mandate stays Razorpay, flag or no flag", async () => {
    const db = world({
      subscriptions: [
        {
          id: "sub-rzp",
          organization_id: ORG,
          provider: "razorpay",
          provider_subscription_id: "sub_Rzp1",
          status: "active",
          billing_cycle: "monthly",
          raw: {},
        },
      ],
    });
    expect(await getAutoPay(db.supabase, ORG)).toMatchObject({
      gateway: "razorpay",
      enabled: true,
      pay_per_period: false,
    });
  });
});

describe("Batch 55: not GST-registered, every gateway charges the base price exactly", () => {
  const pack = {
    id: "pack-1",
    name: "Starter",
    amount: 2000,
    bonus_amount: 0,
    currency: "INR",
    is_active: true,
  };
  const noGst = { platform_settings: [{ id: true, gst_registered: false }] };

  it("Cashfree: a ₹2,000 pack is a ₹2,000 order, with nothing added", async () => {
    const db = world({ credit_packs: [pack], ...noGst });
    const cf = fakeCashfree();
    const out = (await createCreditPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      packId: "pack-1",
      origin: "https://x",
    })) as Row;
    const create = cf.calls.find((c) => c.method === "POST" && c.path === "/pg/orders")!;
    expect(create.body).toMatchObject({ order_id: out["payment_id"], order_amount: 2000 });
    expect(db.rows("payments")[0]).toMatchObject({ amount: 2000, provider: "cashfree" });
    expect(db.rows("payments")[0]!["raw"]).toMatchObject({
      pack_amount: 2000,
      gst: 0,
      gross: 2000,
    });
  });

  it("Razorpay: the link asks for ₹2,000 too", async () => {
    const db = world({ credit_packs: [pack], ...noGst }, { flag: false });
    await createCreditPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      packId: "pack-1",
      origin: "https://x",
    });
    expect(h.createPaymentLink.mock.calls[0]![1]).toMatchObject({ amount: 2000 });
  });

  it("a paid ₹2,000 order credits ₹2,000 to the wallet (credits = what was paid), GST 0 on the payment", async () => {
    const db = world({
      ...noGst,
      payments: [
        creditPayment({
          raw: {
            pack_amount: 2000,
            gst: 0,
            gross: 2000,
            bonus: 0,
            pack_name: "Starter",
            cashfree: { env: "sandbox", order_id: PAY, payment_session_id: `session_${PAY}` },
          },
        }),
      ],
    });
    expect((await deliver(successWebhook(PAY, 2000))).status).toBe(200);
    expect(credits(db).map((l) => [l["entry_type"], l["amount"]])).toEqual([
      ["credit_purchase", 2000],
    ]);
    expect(paymentRow(db)).toMatchObject({ status: "paid" });
    expect(paymentRow(db)["raw"]).toMatchObject({ gst_amount: 0, gross_amount: 2000 });
  });

  it("a settings read that fails refuses to start the payment rather than guess", async () => {
    const db = world({ credit_packs: [pack] });
    const real = db.supabase.from.bind(db.supabase);
    (db.supabase as unknown as { from: (t: string) => unknown }).from = (t: string) =>
      t === "platform_settings"
        ? {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }),
            }),
          }
        : real(t);
    const cf = fakeCashfree();
    const out = await createCreditPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      packId: "pack-1",
      origin: "https://x",
    });
    expect(out).toEqual({ error: expect.stringContaining("couldn't start this payment") });
    expect(cf.calls).toHaveLength(0);
    expect(db.rows("payments")).toHaveLength(0);
  });
});
