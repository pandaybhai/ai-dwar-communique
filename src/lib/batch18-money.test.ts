import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";
import type { MemoryDb } from "./test-support/campaign-memory-db";
import { meta, world, type Row } from "./test-support/campaign-world";
import {
  DISPATCH_DEFAULTS,
  resetDispatchCaches,
  runCampaignDispatch,
  type DispatchConfig,
} from "./campaign-dispatch.server";
import { campaignCallbackData } from "./campaign-callback";

/**
 * Batch 18 — money is right. One describe per item; each test names the
 * failure from the 7 Oct health check it locks out.
 */

beforeEach(() => resetDispatchCaches());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cfg = (o: Partial<DispatchConfig> = {}): DispatchConfig => ({
  ...DISPATCH_DEFAULTS,
  lane: 0,
  lanes: 1,
  budgetMs: 3_000,
  flushMs: 5,
  statusPollMs: 40,
  numberMps: 1_000,
  ...o,
});
const campaignRow = (db: MemoryDb, id: string) => db.rows("campaigns").find((r) => r["id"] === id)!;

// ------------------------------------------------------------------ (1)
describe("(1) a delivered message is always billed, also after a failed try", () => {
  beforeEach(() => vi.resetModules());

  const statusPayload = (pn: string, statuses: Array<Record<string, unknown>>) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, statuses } }],
      },
    ],
  });

  async function sentCampaign() {
    const w = world({ campaigns: [{ recipients: 2 }] });
    const g = meta();
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    const messageOf = (recipientId: string) =>
      w.db
        .rows("messages")
        .find((m) => (m["metadata"] as Row)["campaign_recipient_id"] === recipientId)!;
    // price_message as in the database: sets the cost once the row is delivered.
    w.db.rpcs.set("price_message", (a, d) => {
      const m = d.rows("messages").find((x) => x["id"] === a["p_message_id"]);
      if (!m) return false;
      if (["delivered", "read"].includes(String(m["status"]))) m["cost_amount"] = 0.86;
      return true;
    });
    return { ...w, messageOf };
  }

  async function deliver(
    db: MemoryDb,
    pn: string,
    statuses: Array<Record<string, unknown>>,
    eventId?: string,
  ) {
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    const event =
      (eventId && db.rows("webhook_events").find((e) => e["id"] === eventId)) ||
      db.insert("webhook_events", { provider: "meta", processed_at: null, error: null });
    await processWebhookPayload(db.client, event["id"] as string, statusPayload(pn, statuses));
    return event;
  }

  it("unbilled retry: a failed price leaves the event retryable, and the retry prices it (counted once)", async () => {
    const { db, campaigns, messageOf } = await sentCampaign();
    const c = campaigns[0]!;
    const r = c.recipients[0]!;
    const m = messageOf(r["id"] as string);
    const st = {
      id: m["meta_message_id"],
      status: "delivered",
      timestamp: "1760000000",
      pricing: { billable: true, category: "marketing" },
      biz_opaque_callback_data: campaignCallbackData(c.id, r["id"] as string),
    };
    let failPrice = true;
    db.hook = (call) =>
      call.rpc === "price_message" && failPrice
        ? { data: null, error: { message: "canceling statement due to statement timeout" } }
        : undefined;
    const event = await deliver(db, c.pn, [st]);
    expect(event["processed_at"]).toBeNull();
    expect(String(event["error"])).toMatch(/^retry:1 .*price/);
    expect(m["status"]).toBe("delivered");
    expect(m["cost_amount"]).toBeUndefined();

    // The retry pass: the message is already delivered, so before Batch 18 it
    // was skipped and never priced.
    failPrice = false;
    await deliver(db, c.pn, [st], event["id"] as string);
    expect(m["cost_amount"]).toBe(0.86);
    expect(event["processed_at"]).toBeTruthy();
    expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1 });
    // The event itself is never emitted twice.
    expect(
      db.rows("analytics_events").filter((e) => e["event_type"] === "message.delivered"),
    ).toHaveLength(1);
  });

  it("a recipient step that failed after the message moved is redone on retry (and priced), counted once", async () => {
    const { db, campaigns, messageOf } = await sentCampaign();
    const c = campaigns[0]!;
    const r = c.recipients[1]!;
    const m = messageOf(r["id"] as string);
    const st = {
      id: m["meta_message_id"],
      status: "delivered",
      timestamp: "1760000000",
      pricing: { billable: true, category: "marketing" },
    };
    let failRecipient = true;
    db.hook = (call) =>
      call.rpc === "campaign_recipient_status" && failRecipient
        ? { data: null, error: { message: "deadlock detected" } }
        : undefined;
    const event = await deliver(db, c.pn, [st]);
    expect(event["processed_at"]).toBeNull();
    expect(m["status"]).toBe("delivered");
    expect(r["status"]).toBe("sent");
    expect(m["cost_amount"]).toBeUndefined();

    failRecipient = false;
    await deliver(db, c.pn, [st], event["id"] as string);
    expect(r["status"]).toBe("delivered");
    expect(m["cost_amount"]).toBe(0.86);
    expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1 });
    // A third copy changes nothing and doesn't price again.
    const before = db.calls.length;
    await deliver(db, c.pn, [st]);
    expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1 });
    expect(db.calls.slice(before).some((x) => x.rpc === "price_message")).toBe(false);
  });

  it("the campaign worker's message row: a failed write is retried, a duplicate counts as written", async () => {
    const w = world({ campaigns: [{ recipients: 3 }] });
    let inserts = 0;
    w.db.hook = (call) => {
      if (call.table !== "messages" || call.kind !== "insert") return undefined;
      inserts += 1;
      // The batch fails, and so does the first one-by-one try of each row.
      return inserts <= 4 ? { data: null, error: { message: "connection reset" } } : undefined;
    };
    const g = meta();
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    const c = w.campaigns[0]!;
    expect(g.sends).toHaveLength(3);
    expect(w.db.rows("messages").filter((m) => m["campaign_id"] === c.id)).toHaveLength(3);
    for (const r of c.recipients) expect(r["message_id"]).toBeTruthy();
  });

  it("sendCampaignTemplate: a failed row save is retried; a lost answer (duplicate) finds the row", async () => {
    let tries = 0;
    const db = fakeDb((op) => {
      if (op.table === "conversations" && op.kind === "select")
        return { data: { id: "cv1" }, error: null };
      if (op.table === "messages" && op.kind === "insert") {
        tries += 1;
        return tries === 1
          ? { data: null, error: { message: "timeout" } }
          : { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      if (op.table === "messages" && op.kind === "select")
        return { data: { id: "m-found" }, error: null };
      return undefined;
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ messages: [{ id: "wamid.t" }] }), { status: 200 }),
    );
    const { sendCampaignTemplate } = await import("./campaigns.server");
    const out = await sendCampaignTemplate(
      db.supabase,
      "org",
      { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "tok" },
      { contactId: "c1", phone: "+919800000001", variables: { "1": "Asha" } },
      {
        name: "promo",
        language: "en",
        variableOrder: [1],
        components: [{ type: "BODY", text: "Hi {{1}}" }] as never,
      },
      { campaignId: null, category: "marketing" },
    );
    expect(tries).toBe(2);
    expect(out).toEqual({ messageId: "m-found", error: null });
  });

  it("sendCampaignTemplate: a row that can't be saved is logged with its Meta id, and the send still counts as sent", async () => {
    const db = fakeDb((op) => {
      if (op.table === "conversations" && op.kind === "select")
        return { data: { id: "cv1" }, error: null };
      if (op.table === "messages" && op.kind === "insert")
        return { data: null, error: { message: "disk full" } };
      return undefined;
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.lost" }] }), { status: 200 }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendCampaignTemplate } = await import("./campaigns.server");
    const out = await sendCampaignTemplate(
      db.supabase,
      "org",
      { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "tok" },
      { contactId: "c1", phone: "+919800000001", variables: {} },
      {
        name: "promo",
        language: "en",
        variableOrder: [],
        components: [{ type: "BODY", text: "Hi" }] as never,
      },
      { campaignId: "camp-1", category: "marketing" },
    );
    // Never reported as failed: Meta has it, so a caller must not send again.
    expect(out.error).toBeNull();
    expect(logged.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /message_row_failed.*wamid\.lost/,
    );
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) campaign credits: held once, never held forever", () => {
  /** wallet_apply as the database writes it: signed amount, reference kept. */
  function realisticWallet(db: MemoryDb) {
    db.rpcs.set(
      "wallet_apply",
      (a, d) =>
        d.insert("wallet_ledger", {
          organization_id: a["p_org"],
          entry_type: a["p_type"],
          amount: ["hold", "debit_message"].includes(String(a["p_type"]))
            ? -Math.abs(Number(a["p_amount"]))
            : Math.abs(Number(a["p_amount"])),
          reference_type: a["p_ref_type"],
          reference_id: a["p_ref_id"],
          metadata: a["p_metadata"],
        })["id"],
    );
  }
  const netHeld = (db: MemoryDb, campaignId: string) =>
    db
      .rows("wallet_ledger")
      .filter((l) => l["reference_id"] === campaignId)
      .reduce(
        (s, l) =>
          s +
          (l["entry_type"] === "hold" ? Math.abs(Number(l["amount"])) : 0) -
          (l["entry_type"] === "hold_release" ? Math.abs(Number(l["amount"])) : 0),
        0,
      );

  it("double hold: two runs holding at the same moment reserve the estimate once", async () => {
    const { db, campaigns } = world({
      billing: true,
      campaigns: [{ recipients: 2, estimatedCost: 5 }],
    });
    realisticWallet(db);
    const c = campaigns[0]!;
    const { holdCampaign } = await import("./campaign-billing.server");
    const [a, b] = await Promise.all([
      holdCampaign(db.client, c.orgId, c.id),
      holdCampaign(db.client, c.orgId, c.id),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(campaignRow(db, c.id)["held_amount"]).toBe(5);
    expect(netHeld(db, c.id)).toBe(5);
    // And again later: nothing more.
    await holdCampaign(db.client, c.orgId, c.id);
    expect(netHeld(db, c.id)).toBe(5);
  });

  it("a run that held and died before recording it: the next run adopts that hold, never holds again", async () => {
    const { db, campaigns } = world({
      billing: true,
      campaigns: [{ recipients: 2, estimatedCost: 5 }],
    });
    realisticWallet(db);
    const c = campaigns[0]!;
    const { holdCampaign } = await import("./campaign-billing.server");
    db.hook = (call) =>
      call.table === "campaigns" && call.kind === "update"
        ? { data: null, error: { message: "connection reset" } }
        : undefined;
    const first = await holdCampaign(db.client, c.orgId, c.id);
    // The campaign write failed: no longer reported as ok (it used to be ignored).
    expect(first.ok).toBe(false);
    expect(campaignRow(db, c.id)["held_amount"]).toBe(0);
    db.hook = null;
    expect((await holdCampaign(db.client, c.orgId, c.id)).ok).toBe(true);
    expect(campaignRow(db, c.id)["held_amount"]).toBe(5);
    expect(db.rows("wallet_ledger").filter((l) => l["entry_type"] === "hold")).toHaveLength(1);
    expect(netHeld(db, c.id)).toBe(5);
  });

  it("stuck-hold sweep: a failed campaign and a completed one whose settle failed are both settled", async () => {
    const { db, campaigns } = world({
      billing: true,
      campaigns: [
        { recipients: 2, estimatedCost: 4 },
        { recipients: 2, estimatedCost: 6 },
      ],
    });
    realisticWallet(db);
    const [failed, done] = campaigns;
    const { holdCampaign, settleEndedHolds } = await import("./campaign-billing.server");
    for (const c of [failed!, done!]) await holdCampaign(db.client, c.orgId, c.id);
    // Launch failed writing the list after the hold.
    campaignRow(db, failed!.id)["status"] = "failed";
    // The other completes, but its settle's release fails (and is never retried by completion).
    let failRelease = true;
    db.hook = (call) =>
      call.rpc === "wallet_apply" && failRelease
        ? { data: null, error: { message: "timeout" } }
        : undefined;
    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(campaignRow(db, done!.id)).toMatchObject({ status: "completed", held_amount: 6 });
    expect(campaignRow(db, failed!.id)).toMatchObject({ status: "failed", held_amount: 4 });

    failRelease = false;
    expect(await settleEndedHolds(db.client)).toEqual({ settled: 2, failed: 0 });
    for (const c of [failed!, done!]) {
      expect(campaignRow(db, c.id)["held_amount"]).toBe(0);
      expect(netHeld(db, c.id)).toBe(0);
    }
    // Safe to repeat: nothing left to settle, nothing released twice.
    expect(await settleEndedHolds(db.client)).toEqual({ settled: 0, failed: 0 });
    expect(db.rows("wallet_ledger").filter((l) => l["entry_type"] === "hold_release")).toHaveLength(
      2,
    );
  });

  it("a paused or sending campaign keeps its hold", async () => {
    const { db, campaigns } = world({
      billing: true,
      campaigns: [{ recipients: 1, estimatedCost: 2, status: "paused" }],
    });
    realisticWallet(db);
    const c = campaigns[0]!;
    const { holdCampaign, settleEndedHolds } = await import("./campaign-billing.server");
    await holdCampaign(db.client, c.orgId, c.id);
    expect(await settleEndedHolds(db.client)).toEqual({ settled: 0, failed: 0 });
    expect(campaignRow(db, c.id)["held_amount"]).toBe(2);
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) a paid plan fee lifts dunning, or the payment isn't marked paid", () => {
  const PLAN_PAYMENT = {
    id: "pay-9",
    organization_id: "org-9",
    status: "pending",
    amount: 1000,
    currency: "INR",
    credit_pack_id: null,
    coupon_id: null,
    purpose: "plan_fee",
    raw: { gross: 1180, invoice_id: "inv-9" },
  };
  const webhook = {
    event: "payment_link.paid",
    payload: {
      payment: {
        entity: {
          id: "pay_rzp_9",
          amount: 118000,
          currency: "INR",
          status: "captured",
          method: "upi",
        },
      },
    },
  };
  function planWorld(o: {
    invoicePaid?: boolean;
    invoiceUpdateError?: boolean;
    restoreError?: boolean;
  }) {
    const log: string[] = [];
    const db = fakeDb((op) => {
      if (op.table === "payments" && op.kind === "select")
        return { data: PLAN_PAYMENT, error: null };
      if (op.table === "payments" && op.kind === "update") {
        const p = op.payload as Record<string, unknown>;
        if (p["status"] === "paid") log.push("payment_paid");
        else if (op.filters.some(([n]) => n === "or")) {
          log.push("claim");
          return { data: [{ id: "pay-9" }], error: null };
        } else if ((p["raw"] as Record<string, unknown>)?.["settle_error"])
          log.push("claim_released");
        return { data: null, error: null };
      }
      if (
        op.table === "invoices" &&
        op.kind === "select" &&
        op.filters.some(([n, a]) => n === "eq" && a[0] === "id")
      )
        return {
          data: {
            id: "inv-9",
            total: 1180,
            amount_paid: o.invoicePaid ? 1180 : 0,
            organization_id: "org-9",
            purpose: "plan_fee",
          },
          error: null,
        };
      if (op.table === "invoices" && op.kind === "select") return { data: [], error: null };
      if (op.table === "invoices" && op.kind === "update") {
        log.push(`invoice:${(op.payload as Record<string, unknown>)["status"]}`);
        return { data: null, error: o.invoiceUpdateError ? { message: "lock timeout" } : null };
      }
      if (op.table === "organizations" && op.kind === "select")
        return { data: { plan_status: "paused", plan_version_id: "pv-1" }, error: null };
      if (op.table === "organization_billing_settings" && op.kind === "select")
        return { data: { dunning_paused: {}, dunning_stage: "paused" }, error: null };
      if (op.table === "organization_billing_settings" && op.kind === "update") {
        log.push("dunning_cleared");
        return { data: null, error: o.restoreError ? { message: "timeout" } : null };
      }
      if (op.table === "organizations" && op.kind === "update") log.push("plan_active");
      return undefined;
    });
    return { ...db, log };
  }

  it("markPaid failure: the invoice write fails → settle throws before the payment is marked paid", async () => {
    const db = planWorld({ invoiceUpdateError: true });
    const { settlePayment, isSettleError } = await import("./billing.server");
    const err = await settlePayment(db.supabase, "pay-9", "pay_rzp_9", webhook).catch((e) => e);
    expect(isSettleError(err)).toBe(true);
    expect(String(err.message)).toMatch(/invoice update failed/);
    expect(db.log).not.toContain("payment_paid");
    expect(db.log).not.toContain("dunning_cleared");
    expect(db.log).toContain("claim_released");
  });

  it("markPaid failure: the dunning lift fails → settle throws; the retry (invoice already paid) lifts it", async () => {
    const first = planWorld({ restoreError: true });
    const { settlePayment, isSettleError } = await import("./billing.server");
    const err = await settlePayment(first.supabase, "pay-9", "pay_rzp_9", webhook).catch((e) => e);
    expect(isSettleError(err)).toBe(true);
    expect(first.log).toContain("invoice:paid");
    expect(first.log).not.toContain("payment_paid");

    // Retry: 0 outstanding. Before Batch 18 markPaid was skipped here, so the
    // merchant stayed paused although the payment was marked paid.
    const retry = planWorld({ invoicePaid: true });
    await settlePayment(retry.supabase, "pay-9", "pay_rzp_9", webhook);
    expect(retry.log).toEqual([
      "claim",
      "invoice:paid",
      "dunning_cleared",
      "plan_active",
      "payment_paid",
    ]);
    const invoiceUpdate = retry.ops.find((o) => o.table === "invoices" && o.kind === "update")!;
    // Nothing banked twice, and the invoice keeps the payment it was paid by.
    expect(invoiceUpdate.payload).toMatchObject({ amount_paid: 1180, status: "paid" });
    expect(invoiceUpdate.payload).not.toHaveProperty("payment_id");
  });

  it("markPaid reports a failed read instead of doing nothing", async () => {
    const db = fakeDb((op) =>
      op.table === "invoices" ? { data: null, error: { message: "connection reset" } } : undefined,
    );
    const { markPaid } = await import("./invoices.server");
    expect((await markPaid(db.supabase, "inv-1", "pay-1", 100)).error).toMatch(
      /invoice read failed/,
    );
  });
});

// ------------------------------------------------------------------ (4)
describe("(4) a dunning pause never strands a 'send now' campaign", () => {
  it("dunning restore of send-now: paused while sending with no time → restored due now and sent by the worker", async () => {
    const { db, campaigns } = world({
      campaigns: [{ recipients: 2 }, { recipients: 1, status: "scheduled" }],
    });
    const [now, later] = campaigns;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    campaignRow(db, later!.id)["scheduled_at"] = future;
    db.rows("organization_billing_settings").push({
      organization_id: now!.orgId,
      dunning_paused: {},
    });
    db.rows("organization_billing_settings").push({
      organization_id: later!.orgId,
      dunning_paused: {},
    });
    const { pauseOutbound, restoreAfterPayment } = await import("./dunning.server");
    for (const c of [now!, later!]) await pauseOutbound(db.client, c.orgId);
    expect(campaignRow(db, now!.id)["status"]).toBe("paused");

    for (const c of [now!, later!]) await restoreAfterPayment(db.client, c.orgId);
    expect(campaignRow(db, now!.id)["status"]).toBe("scheduled");
    expect(Date.parse(String(campaignRow(db, now!.id)["scheduled_at"]))).toBeLessThanOrEqual(
      Date.now(),
    );
    // A campaign scheduled for later keeps its time.
    expect(campaignRow(db, later!.id)).toMatchObject({ status: "scheduled", scheduled_at: future });

    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends).toHaveLength(2);
    expect(campaignRow(db, now!.id)["status"]).toBe("completed");
    expect(campaignRow(db, later!.id)["status"]).toBe("scheduled");
  });
});

// ------------------------------------------------------------------ (5)
describe("(5) a Razorpay event is never answered ok unless it was stored and handled", () => {
  const MOCKED = [
    "@/lib/whatsapp-webhook.server",
    "@/lib/razorpay.server",
    "@/lib/flow-connections.server",
    "@/lib/flow-engine.server",
  ];
  let client: unknown = null;
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => client }));
    vi.doMock("@/lib/razorpay.server", () => ({
      razorpayWebhookSecret: async () => "secret",
      verifyWebhookSignature: () => true,
    }));
  });
  afterEach(() => {
    for (const m of MOCKED) vi.doUnmock(m);
    vi.resetModules();
  });

  type Post = (a: { request: Request; params?: Record<string, string> }) => Promise<Response>;
  async function billingPost(body: unknown) {
    const { Route } = await import("../routes/api/public/razorpay-webhook");
    const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server
      .handlers.POST;
    return post({
      request: new Request("http://x/api/public/razorpay-webhook", {
        method: "POST",
        headers: { "x-razorpay-signature": "sig", "x-razorpay-event-id": "evt_1" },
        body: JSON.stringify(body),
      }),
    });
  }
  const failedPayment = {
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_rzp_1", notes: { payment_id: "pay-1" } } } },
  };
  /** webhook_events as stored: the event row already there (or not), how old, and its state. */
  function eventsDb(o: {
    insertError?: { code?: string; message: string };
    stored?: { processed: boolean; error: string | null; ageMs: number };
  }) {
    return fakeDb((op) => {
      if (op.table !== "webhook_events") return undefined;
      if (op.kind === "insert")
        return o.insertError
          ? { data: null, error: o.insertError }
          : o.stored
            ? { data: null, error: { code: "23505", message: "duplicate key" } }
            : { data: { id: "we-1" }, error: null };
      if (op.kind === "update" && op.filters.some(([n]) => n === "not"))
        return { data: o.stored?.error ? { id: "we-1" } : null, error: null };
      if (op.kind === "update" && op.filters.some(([n]) => n === "lt")) {
        const cutoff = Date.parse(String(op.filters.find(([n]) => n === "lt")![1][1]));
        const receivedAt = Date.now() - (o.stored?.ageMs ?? 0);
        const take = o.stored && !o.stored.processed && receivedAt < cutoff;
        return { data: take ? { id: "we-1" } : null, error: null };
      }
      return undefined;
    });
  }
  const handled = (db: ReturnType<typeof fakeDb>) =>
    db.ops.some((op) => op.table === "payments" && op.kind === "update");

  it("Razorpay store-failure 500: an event that couldn't be stored is answered 500 and not processed", async () => {
    const db = eventsDb({ insertError: { code: "08006", message: "connection failure" } });
    client = db.supabase;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await billingPost(failedPayment);
    expect(res.status).toBe(500);
    expect(handled(db)).toBe(false);
  });

  it("a delivery that died mid-way (neither processed nor failed) is taken again after a few minutes", async () => {
    const db = eventsDb({ stored: { processed: false, error: null, ageMs: 6 * 60_000 } });
    client = db.supabase;
    const res = await billingPost(failedPayment);
    expect(res.status).toBe(200);
    expect(handled(db)).toBe(true);
    const take = db.ops.find(
      (op) => op.table === "webhook_events" && op.filters.some(([n]) => n === "lt"),
    )!;
    // The retake is one conditional update that also claims it.
    expect(take.filters).toContainEqual(["is", ["processed_at", null]]);
    expect(Object.keys(take.payload as object)).toEqual(["received_at"]);
  });

  it("…but not while it may still be running, and never once processed", async () => {
    for (const stored of [
      { processed: false, error: null, ageMs: 30_000 },
      { processed: true, error: null, ageMs: 60 * 60_000 },
    ]) {
      const db = eventsDb({ stored });
      client = db.supabase;
      const res = await billingPost(failedPayment);
      expect(res.status).toBe(200);
      expect(handled(db)).toBe(false);
    }
  });

  it("a subscription charge whose write fails answers 500 so Razorpay delivers it again", async () => {
    const db = fakeDb((op) => {
      if (op.table === "webhook_events" && op.kind === "insert")
        return { data: { id: "we-1" }, error: null };
      if (op.table === "subscriptions" && op.kind === "select")
        return { data: { id: "sub-1", organization_id: "org-1", raw: {} }, error: null };
      if (op.table === "organizations" && op.kind === "update")
        return { data: null, error: { message: "timeout" } };
      return undefined;
    });
    client = db.supabase;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await billingPost({
      event: "subscription.activated",
      payload: { subscription: { entity: { id: "sub_rzp_1" } } },
    });
    expect(res.status).toBe(500);
    const marked = db.ops.find((op) => op.table === "webhook_events" && op.kind === "update")!;
    expect(String((marked.payload as Record<string, unknown>)["error"])).toMatch(
      /plan status failed/,
    );
  });

  it("a paid flow whose resume fails answers 500 (it used to answer ok and drop the payment)", async () => {
    const resume = vi.fn(async () => {
      throw new Error("flow_runs read failed");
    });
    vi.doMock("@/lib/flow-connections.server", () => ({
      razorpayWebhookSecretFor: async () => "secret",
    }));
    vi.doMock("@/lib/flow-engine.server", () => ({ resumePaidRun: resume }));
    client = fakeDb(() => undefined).supabase;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { Route } = await import("../routes/api/public/razorpay-flow-webhook/$orgId");
    const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server
      .handlers.POST;
    const orgId = "11111111-2222-3333-4444-555555555555";
    const res = await post({
      params: { orgId },
      request: new Request(`http://x/api/public/razorpay-flow-webhook/${orgId}`, {
        method: "POST",
        headers: { "x-razorpay-signature": "sig" },
        body: JSON.stringify({
          event: "payment_link.paid",
          payload: {
            payment_link: {
              entity: {
                id: "plink_1",
                notes: { aidwar_org: orgId, aidwar_run: "run-1", aidwar_node: "n1" },
              },
            },
          },
        }),
      }),
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(res.status).toBe(500);
  });
});

// ------------------------------------------------------------------ (6)
const noEvent = async () => {};

describe("(6) older event flows: a send is never made (or charged) twice", () => {
  const MOCKED = [
    "@/lib/whatsapp-webhook.server",
    "@/lib/campaigns.server",
    "@/lib/flows.server",
    "@/lib/events.server",
    "@/lib/cod.server",
    "@/lib/flow-engine.server",
    "@/lib/flow-triggers.server",
  ];
  const sends: unknown[] = [];
  const order: string[] = [];
  let client: unknown = null;
  beforeEach(() => {
    sends.length = 0;
    order.length = 0;
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", "cron");
    vi.doMock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => client }));
    vi.doMock("@/lib/campaigns.server", () => ({
      loadSenderContext: async () => ({
        accountId: "acc",
        wabaId: "waba",
        phoneNumberId: "pn",
        accessToken: "t",
      }),
      sendCampaignTemplate: async (...a: unknown[]) => {
        order.push("meta_send");
        sends.push(a);
        return { messageId: "m-new", error: null };
      },
    }));
    vi.doMock("@/lib/flows.server", () => ({
      messageClassOf: () => "transactional",
      triggerStillValid: async () => ({ valid: true }),
      stepGateAllows: async () => ({ allowed: true }),
      optInAllows: () => ({ allowed: true }),
      loadSendSettings: async () => ({}),
      applyQuietHours: (now: Date) => now,
      frequencyCapReached: async () => false,
      flowLinkTarget: async () => null,
      resolveFlowVariables: async () => ({}),
      flowCarouselCards: async () => [],
    }));
    // A named no-op: the build's registry guard reads "emitEvent: <name>" as an alias.
    vi.doMock("@/lib/events.server", () => ({ emitEvent: noEvent }));
    vi.doMock("@/lib/cod.server", () => ({
      noteCodAsk: async () => {},
      expireCodConfirmations: async () => 0,
    }));
    vi.doMock("@/lib/flow-engine.server", () => ({ tickRuns: async () => ({}) }));
    vi.doMock("@/lib/flow-triggers.server", () => ({ dispatchNoReply: async () => ({}) }));
  });
  afterEach(() => {
    for (const m of MOCKED) vi.doUnmock(m);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** One claimed scheduled send, in the state a previous tick left it. */
  function sendWorld(o: {
    error: string | null;
    priorMessage?: { id: string; status: string } | null;
  }) {
    const row: Record<string, unknown> = {
      id: "ss-1",
      organization_id: "org-1",
      flow_id: "flow-1",
      flow_step_id: "step-1",
      contact_id: "c-1",
      trigger_type: "order",
      trigger_id: "o-1",
      status: "scheduled",
      error: o.error,
      claimed_at: new Date().toISOString(),
    };
    const db = fakeDb(
      (op) => {
        if (op.table === "scheduled_sends" && op.kind === "update") {
          const p = op.payload as Record<string, unknown>;
          order.push(
            p["error"] === "send_started" ? "mark_started" : `finish:${String(p["status"])}`,
          );
          if (row["status"] === "scheduled") Object.assign(row, p);
          return { data: null, error: null };
        }
        if (op.table === "scheduled_sends" && op.kind === "select")
          return { data: [], error: null };
        if (op.table === "messages" && op.kind === "select")
          return { data: o.priorMessage ?? null, error: null };
        if (op.table === "flows")
          return {
            data: {
              id: "flow-1",
              key: "order_lifecycle",
              is_enabled: true,
              whatsapp_account_id: null,
              config: {},
            },
            error: null,
          };
        if (op.table === "flow_steps")
          return {
            data: {
              id: "step-1",
              step_order: 1,
              template_id: "tpl-1",
              condition: null,
              is_enabled: true,
            },
            error: null,
          };
        if (op.table === "contacts")
          return {
            data: { id: "c-1", name: "Asha", phone: "+919800000001", opt_in_status: "opted_in" },
            error: null,
          };
        if (op.table === "message_templates")
          return {
            data: {
              name: "order_update",
              language: "en",
              category: "UTILITY",
              status: "APPROVED",
              components: [],
            },
            error: null,
          };
        return undefined;
      },
      (call) =>
        call.name === "claim_scheduled_sends" ? { data: [{ ...row }], error: null } : undefined,
    );
    return { db, row };
  }
  async function tick() {
    const { Route } = await import("../routes/api/internal/flow-worker");
    const post = (
      Route.options as unknown as {
        server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
      }
    ).server.handlers.POST;
    return post({
      request: new Request("http://x/api/internal/flow-worker", {
        method: "POST",
        headers: { "x-cron-secret": "cron" },
      }),
    });
  }

  it("a send is marked started before Meta is asked, and finished sent after", async () => {
    const w = sendWorld({ error: null });
    client = w.db.supabase;
    await tick();
    expect(order).toEqual(["mark_started", "meta_send", "finish:sent"]);
    expect(w.row).toMatchObject({ status: "sent", error: null, message_id: "m-new" });
  });

  it("event-flow no double send: re-taken after a run died post-send, the message found → sent, never sent again", async () => {
    const w = sendWorld({
      error: "send_started",
      priorMessage: { id: "m-old", status: "pending" },
    });
    client = w.db.supabase;
    await tick();
    expect(sends).toHaveLength(0);
    expect(w.row).toMatchObject({ status: "sent", message_id: "m-old", error: null });
  });

  it("re-taken with no message on file → failed, never sent again (at most once)", async () => {
    const w = sendWorld({ error: "send_started", priorMessage: null });
    client = w.db.supabase;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tick();
    expect(sends).toHaveLength(0);
    expect(w.row).toMatchObject({ status: "failed" });
    expect(String(w.row["error"])).toMatch(/interrupted/);
  });
});

// ------------------------------------------------------------------ (8)
describe("(8) AI usage counters never lose a count", () => {
  beforeEach(() => vi.resetModules());

  async function usageDb() {
    const { MemoryDb } = await import("./test-support/campaign-memory-db");
    const db = new MemoryDb();
    // Every call yields, like a network round trip.
    db.hook = async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      return undefined;
    };
    // ai_usage_add as in the migration: one statement, added in place.
    db.rpcs.set("ai_usage_add", (a, d) => {
      const row = d
        .rows("ai_usage")
        .find(
          (r) =>
            r["organization_id"] === a["p_org"] &&
            r["usage_date"] === a["p_usage_date"] &&
            r["task"] === a["p_task"],
        );
      if (!row) {
        d.insert("ai_usage", {
          organization_id: a["p_org"],
          usage_date: a["p_usage_date"],
          task: a["p_task"],
          runs: a["p_runs"],
          input_tokens: a["p_input_tokens"],
          output_tokens: a["p_output_tokens"],
          cost_amount: a["p_cost_amount"],
          billed_amount: Number(a["p_billed_amount"] ?? 0),
        });
        return null;
      }
      row["runs"] = Number(row["runs"]) + Number(a["p_runs"]);
      row["input_tokens"] = Number(row["input_tokens"]) + Number(a["p_input_tokens"]);
      row["output_tokens"] = Number(row["output_tokens"]) + Number(a["p_output_tokens"]);
      row["cost_amount"] = Number(row["cost_amount"]) + Number(a["p_cost_amount"]);
      row["billed_amount"] = Number(row["billed_amount"]) + Number(a["p_billed_amount"] ?? 0);
      return null;
    });
    return db;
  }

  it("atomic counter: 20 workers metering at once add up to exactly 20 runs and their tokens", async () => {
    const db = await usageDb();
    const { meterAiUsage } = await import("./ai-run.server");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        meterAiUsage(db.client, "org-1", "embedding", { inputTokens: 100, costAmount: 0.5 }),
      ),
    );
    const rows = db.rows("ai_usage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runs: 20, input_tokens: 2000, cost_amount: 10 });
    // One call each, no read first.
    expect(db.calls.filter((c) => c.table === "ai_usage")).toHaveLength(0);
  });

  const runResult = {
    inputTokens: 50,
    outputTokens: 20,
    costAmount: 0.2,
    billedAmount: 0.5,
    costCurrency: "INR",
  };

  it("atomic counter (run roll-up): 20 runs finishing at once count 20 runs and all their billed amount", async () => {
    const db = await usageDb();
    const { rollUpUsage } = await import("./ai-run.server");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        rollUpUsage(db.client, "org-1", "reply", runResult as never),
      ),
    );
    const rows = db.rows("ai_usage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runs: 20,
      input_tokens: 1000,
      output_tokens: 400,
      billed_amount: 10,
    });
    expect(Number(rows[0]!["cost_amount"])).toBeCloseTo(4);
    expect(db.calls.filter((c) => c.table === "ai_usage")).toHaveLength(0);
  });

  it("a failed ai_usage_add call is logged and written the old way, with billed_amount", async () => {
    const db = await usageDb();
    db.rpcs.set("ai_usage_add", () => {
      throw new Error("timeout");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rollUpUsage } = await import("./ai-run.server");
    await rollUpUsage(db.client, "org-1", "reply", runResult as never);
    await rollUpUsage(db.client, "org-1", "reply", runResult as never);
    expect(db.rows("ai_usage")[0]).toMatchObject({ runs: 2, input_tokens: 100, billed_amount: 1 });
    // Asked every time: nothing remembers a failure.
    expect(db.calls.filter((c) => c.rpc === "ai_usage_add")).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

// ------------------------------------------------------------------ (9)
describe("(9) small money fixes", () => {
  beforeEach(() => vi.resetModules());

  it("the 'scheduled' cancel: switching a feature off cancels waiting sends by their real status", async () => {
    const db = fakeDb((op) =>
      op.table === "profiles" ? { data: { is_super_admin: true }, error: null } : undefined,
    );
    const { setFeatureOverride } = await import("./billing.server");
    await setFeatureOverride(db.supabase, {
      organizationId: "org-1",
      featureKey: "flows",
      enabled: false,
      force: true,
      actorId: "u-1",
    });
    const cancel = db.ops.find((o) => o.table === "scheduled_sends" && o.kind === "update")!;
    expect(cancel.payload).toEqual({ status: "cancelled" });
    expect(cancel.filters).toContainEqual(["eq", ["status", "scheduled"]]);
  });

  describe("campaign controls never flip a campaign that finished meanwhile", () => {
    const MOCKED = ["@/lib/whatsapp-api.server", "@/lib/campaign-billing.server"];
    afterEach(() => {
      for (const m of MOCKED) vi.doUnmock(m);
    });
    async function control(db: MemoryDb, orgId: string, campaignId: string, action: string) {
      vi.doMock("@/lib/whatsapp-api.server", () => ({
        requireOrgMember: async () => ({
          supabase: db.client,
          organizationId: orgId,
          userId: "u-1",
        }),
        isResponse: (r: unknown) => r instanceof Response,
        jsonError: (error: string, status = 400) => Response.json({ error }, { status }),
        logServerActivity: async () => {},
        requirePermission: async () => null,
      }));
      const settle = vi.fn(async () => ({ ok: true }));
      vi.doMock("@/lib/campaign-billing.server", () => ({ settleCampaignSpend: settle }));
      const { Route } = await import("../routes/api/campaigns/control");
      const post = (
        Route.options as unknown as {
          server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
        }
      ).server.handlers.POST;
      const res = await post({
        request: new Request("http://x/api/campaigns/control", {
          method: "POST",
          body: JSON.stringify({ organization_id: orgId, campaign_id: campaignId, action }),
        }),
      });
      return { res, settle };
    }

    for (const action of ["pause", "cancel"]) {
      it(`completed campaign not flipped: ${action} while it completes → stays completed`, async () => {
        const { db, campaigns } = world({ campaigns: [{ recipients: 1 }] });
        const c = campaigns[0]!;
        // The worker completes it between the route's read and its write.
        let completed = false;
        db.hook = (call) => {
          if (call.table === "campaigns" && call.kind === "update" && !completed) {
            completed = true;
            campaignRow(db, c.id)["status"] = "completed";
          }
          return undefined;
        };
        const { res, settle } = await control(db, c.orgId, c.id, action);
        expect(res.status).toBe(400);
        expect(campaignRow(db, c.id)["status"]).toBe("completed");
        expect(settle).not.toHaveBeenCalled();
      });
    }

    it("resume of a campaign that is no longer paused changes nothing", async () => {
      const { db, campaigns } = world({ campaigns: [{ recipients: 1, status: "paused" }] });
      const c = campaigns[0]!;
      db.hook = (call) => {
        if (call.table === "campaigns" && call.kind === "update")
          campaignRow(db, c.id)["status"] = "cancelled";
        return undefined;
      };
      const { res } = await control(db, c.orgId, c.id, "resume");
      expect(res.status).toBe(400);
      expect(campaignRow(db, c.id)["status"]).toBe("cancelled");
    });

    it("a normal pause still pauses (unchanged)", async () => {
      const { db, campaigns } = world({ campaigns: [{ recipients: 1 }] });
      const c = campaigns[0]!;
      const { res } = await control(db, c.orgId, c.id, "pause");
      expect(res.status).toBe(200);
      expect(campaignRow(db, c.id)["status"]).toBe("paused");
    });
  });

  it("double-counted campaign reply: two messages from one customer at once count one reply", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 1 }] });
    const c = campaigns[0]!;
    const r = c.recipients[0]!;
    r["status"] = "delivered";
    r["replied_at"] = null;
    db.hook = async () => {
      await new Promise((res) => setTimeout(res, Math.random() * 3));
      return undefined;
    };
    const { applyCampaignReply } = await import("./whatsapp-webhook.server");
    await Promise.all([
      applyCampaignReply(db.client, c.orgId, r["contact_id"] as string),
      applyCampaignReply(db.client, c.orgId, r["contact_id"] as string),
    ]);
    expect(campaignRow(db, c.id)["replied_count"]).toBe(1);
    expect(r["replied_at"]).toBeTruthy();
  });

  it("double billing WhatsApp: two drains at once send a notice once", async () => {
    process.env["PLATFORM_ORG_ID"] = "plat";
    process.env["BILLING_ADMIN_WHATSAPP"] = "+919811111111";
    const notice: Record<string, unknown> = {
      id: "n1",
      organization_id: null,
      audience: "admin",
      kind: "ai_provider_alert",
      channel: "whatsapp",
      recipient: null,
      status: "queued",
      sent_at: null,
      payload: { headline: "h", detail: "d", link: "https://aidwar.in/admin/ai" },
    };
    const db = fakeDb((op) => {
      if (op.table === "billing_notifications" && op.kind === "select")
        return { data: [{ ...notice }], error: null };
      if (op.table === "billing_notifications" && op.kind === "update") {
        const p = op.payload as Record<string, unknown>;
        if (p["status"]) {
          Object.assign(notice, p);
          return { data: null, error: null };
        }
        // The claim: a compare-and-set on sent_at.
        const expected =
          op.filters.find(([n, a]) => n === "eq" && a[0] === "sent_at")?.[1][1] ?? null;
        if (notice["status"] !== "queued" || (notice["sent_at"] ?? null) !== expected)
          return { data: [], error: null };
        notice["sent_at"] = p["sent_at"];
        return { data: [{ id: "n1" }], error: null };
      }
      if (op.table === "whatsapp_accounts")
        return {
          data: [
            {
              id: "acc",
              organization_id: "plat",
              waba_id: "w",
              phone_number_id: "pn",
              display_phone_number: "91",
              status: "active",
              is_default: true,
            },
          ],
          error: null,
        };
      if (op.table === "whatsapp_credentials")
        return { data: { access_token: "tok" }, error: null };
      if (op.table === "contacts") return { data: [], error: null };
      if (op.table === "message_templates")
        return {
          data: { name: "admin_ai_provider_alert", language: "en", status: "APPROVED" },
          error: null,
        };
      return undefined;
    });
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(init.body);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    });
    const { drainBillingNotifications } = await import("./billing-notify.server");
    const [a, b] = await Promise.all([
      drainBillingNotifications(db.supabase),
      drainBillingNotifications(db.supabase),
    ]);
    expect(sent).toHaveLength(1);
    expect(a.sent + b.sent).toBe(1);
    expect(notice["status"]).toBe("sent");
  });

  it("trial-ending notice sent twice: one run queues it once (it was queued by sweepTrials and again by the main loop), a re-run none", async () => {
    const endsAt = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
    const notices: Array<Record<string, unknown>> = [];
    const db = fakeDb((op) => {
      if (op.table === "organizations" && op.kind === "select")
        return {
          data: [
            { id: "org-1", plan_status: "trial", trial_ends_at: endsAt, plan_version_id: "pv-1" },
          ],
          error: null,
        };
      if (op.table === "billing_notifications" && op.kind === "insert") {
        notices.push(op.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      // sweepTrials' "a heads-up in the last week?" check.
      if (op.table === "billing_notifications" && op.kind === "select")
        return {
          data: notices.filter((n) => n["kind"] === "trial_ending").map(() => ({ id: "x" })),
          error: null,
        };
      return undefined;
    });
    const { runPlanBilling } = await import("./plan-billing.server");
    await runPlanBilling(db.supabase);
    expect(notices.filter((n) => n["kind"] === "trial_ending")).toHaveLength(1);
    await runPlanBilling(db.supabase);
    expect(notices.filter((n) => n["kind"] === "trial_ending")).toHaveLength(1);
  });
});

// ------------------------------------------------- payment claim (locked)
describe("the payment claim in settlePayment is locked as it is (verified live, 7 Oct)", () => {
  // All 10 paid credit purchases since 3 Sep have their wallet credit: the
  // .or() on this conditional update does NOT empty the returned rows. This
  // test keeps the claim exactly as it is so nobody "fixes" it.
  beforeEach(() => vi.resetModules());
  const PAYMENT = {
    id: "pay-1",
    organization_id: "org-1",
    status: "pending",
    amount: 2000,
    currency: "INR",
    credit_pack_id: null,
    coupon_id: null,
    purpose: "credit_purchase",
    raw: { pack_amount: 2000, gst: 360, gross: 2360, bonus: 0, pack_name: "Starter" },
  };
  const webhook = {
    event: "payment_link.paid",
    payload: {
      payment: {
        entity: {
          id: "pay_rzp_1",
          amount: 236000,
          currency: "INR",
          status: "captured",
          method: "upi",
        },
      },
      payment_link: {
        entity: { id: "plink_1", amount_paid: 236000, notes: { payment_id: "pay-1" } },
      },
    },
  };
  function claimWorld(claimReturns: Array<{ id: string }>) {
    return fakeDb(
      (op) => {
        if (op.table === "payments" && op.kind === "select") return { data: PAYMENT, error: null };
        if (op.table === "payments" && op.kind === "update" && op.filters.some(([n]) => n === "or"))
          return { data: claimReturns, error: null };
        if (op.table === "wallet_ledger") return { data: [], error: null };
        return undefined;
      },
      (call) => (call.name === "wallet_apply" ? { data: "entry", error: null } : undefined),
    );
  }

  it("payment-claim lock: one conditional update — not paid, and unclaimed or claimed over 5 minutes ago (via .or()), returning the row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00.000Z"));
    const db = claimWorld([{ id: "pay-1" }]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { settlePayment } = await import("./billing.server");
    const out = await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook);
    const claim = db.ops.find((o) => o.table === "payments" && o.kind === "update")!;
    expect((claim.payload as { raw: Record<string, unknown> }).raw["settle_claimed_at"]).toBe(
      "2026-10-07T10:00:00.000Z",
    );
    expect(claim.filters).toEqual([
      ["eq", ["id", "pay-1"]],
      ["neq", ["status", "paid"]],
      [
        "or",
        ["raw->>settle_claimed_at.is.null,raw->>settle_claimed_at.lt.2026-10-07T09:55:00.000Z"],
      ],
    ]);
    expect(claim.select).toEqual(["id"]);
    // The row comes back (as it does live), so the credit is taken.
    expect(out.credited).toBe(true);
    expect(db.rpcs.filter((r) => r.name === "wallet_apply").map((r) => r.args["p_type"])).toEqual([
      "credit_purchase",
    ]);
  });

  it("payment-claim lock: a claim that returns no row (another delivery holds it) credits nothing", async () => {
    const db = claimWorld([]);
    const { settlePayment } = await import("./billing.server");
    expect(await settlePayment(db.supabase, "pay-1", "pay_rzp_1", webhook)).toEqual({
      credited: false,
    });
    expect(db.rpcs.filter((r) => r.name === "wallet_apply")).toHaveLength(0);
  });
});
