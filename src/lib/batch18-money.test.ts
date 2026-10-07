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
      { id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, statuses } }] },
    ],
  });

  async function sentCampaign() {
    const w = world({ campaigns: [{ recipients: 2 }], recipientRpc: true });
    const g = meta();
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    const messageOf = (recipientId: string) =>
      w.db.rows("messages").find((m) => (m["metadata"] as Row)["campaign_recipient_id"] === recipientId)!;
    // price_message as in the database: sets the cost once the row is delivered.
    w.db.rpcs.set("price_message", (a, d) => {
      const m = d.rows("messages").find((x) => x["id"] === a["p_message_id"]);
      if (!m) return false;
      if (["delivered", "read"].includes(String(m["status"]))) m["cost_amount"] = 0.86;
      return true;
    });
    return { ...w, messageOf };
  }

  async function deliver(db: MemoryDb, pn: string, statuses: Array<Record<string, unknown>>, eventId?: string) {
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
    expect(db.rows("analytics_events").filter((e) => e["event_type"] === "message.delivered")).toHaveLength(1);
  });

  it("a recipient step that failed after the message moved is redone on retry (and priced), counted once", async () => {
    const { db, campaigns, messageOf } = await sentCampaign();
    const c = campaigns[0]!;
    const r = c.recipients[1]!;
    const m = messageOf(r["id"] as string);
    const st = { id: m["meta_message_id"], status: "delivered", timestamp: "1760000000", pricing: { billable: true, category: "marketing" } };
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
      if (op.table === "conversations" && op.kind === "select") return { data: { id: "cv1" }, error: null };
      if (op.table === "messages" && op.kind === "insert") {
        tries += 1;
        return tries === 1
          ? { data: null, error: { message: "timeout" } }
          : { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      if (op.table === "messages" && op.kind === "select") return { data: { id: "m-found" }, error: null };
      return undefined;
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.t" }] }), { status: 200 }));
    const { sendCampaignTemplate } = await import("./campaigns.server");
    const out = await sendCampaignTemplate(
      db.supabase,
      "org",
      { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "tok" },
      { contactId: "c1", phone: "+919800000001", variables: { "1": "Asha" } },
      { name: "promo", language: "en", variableOrder: [1], components: [{ type: "BODY", text: "Hi {{1}}" }] as never },
      { campaignId: null, category: "marketing" },
    );
    expect(tries).toBe(2);
    expect(out).toEqual({ messageId: "m-found", error: null });
  });

  it("sendCampaignTemplate: a row that can't be saved is logged with its Meta id, and the send still counts as sent", async () => {
    const db = fakeDb((op) => {
      if (op.table === "conversations" && op.kind === "select") return { data: { id: "cv1" }, error: null };
      if (op.table === "messages" && op.kind === "insert") return { data: null, error: { message: "disk full" } };
      return undefined;
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.lost" }] }), { status: 200 }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendCampaignTemplate } = await import("./campaigns.server");
    const out = await sendCampaignTemplate(
      db.supabase,
      "org",
      { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "tok" },
      { contactId: "c1", phone: "+919800000001", variables: {} },
      { name: "promo", language: "en", variableOrder: [], components: [{ type: "BODY", text: "Hi" }] as never },
      { campaignId: "camp-1", category: "marketing" },
    );
    // Never reported as failed: Meta has it, so a caller must not send again.
    expect(out.error).toBeNull();
    expect(logged.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/message_row_failed.*wamid\.lost/);
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) campaign credits: held once, never held forever", () => {
  /** wallet_apply as the database writes it: signed amount, reference kept. */
  function realisticWallet(db: MemoryDb) {
    db.rpcs.set("wallet_apply", (a, d) =>
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
    const { db, campaigns } = world({ billing: true, campaigns: [{ recipients: 2, estimatedCost: 5 }] });
    realisticWallet(db);
    const c = campaigns[0]!;
    const { holdCampaign } = await import("./campaign-billing.server");
    const [a, b] = await Promise.all([holdCampaign(db.client, c.orgId, c.id), holdCampaign(db.client, c.orgId, c.id)]);
    expect(a.ok && b.ok).toBe(true);
    expect(campaignRow(db, c.id)["held_amount"]).toBe(5);
    expect(netHeld(db, c.id)).toBe(5);
    // And again later: nothing more.
    await holdCampaign(db.client, c.orgId, c.id);
    expect(netHeld(db, c.id)).toBe(5);
  });

  it("a run that held and died before recording it: the next run adopts that hold, never holds again", async () => {
    const { db, campaigns } = world({ billing: true, campaigns: [{ recipients: 2, estimatedCost: 5 }] });
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
      call.rpc === "wallet_apply" && failRelease ? { data: null, error: { message: "timeout" } } : undefined;
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
    expect(db.rows("wallet_ledger").filter((l) => l["entry_type"] === "hold_release")).toHaveLength(2);
  });

  it("a paused or sending campaign keeps its hold", async () => {
    const { db, campaigns } = world({ billing: true, campaigns: [{ recipients: 1, estimatedCost: 2, status: "paused" }] });
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
      payment: { entity: { id: "pay_rzp_9", amount: 118000, currency: "INR", status: "captured", method: "upi" } },
    },
  };
  function planWorld(o: { invoicePaid?: boolean; invoiceUpdateError?: boolean; restoreError?: boolean }) {
    const log: string[] = [];
    const db = fakeDb((op) => {
      if (op.table === "payments" && op.kind === "select") return { data: PLAN_PAYMENT, error: null };
      if (op.table === "payments" && op.kind === "update") {
        const p = op.payload as Record<string, unknown>;
        if (p["status"] === "paid") log.push("payment_paid");
        else if (op.filters.some(([n]) => n === "or")) {
          log.push("claim");
          return { data: [{ id: "pay-9" }], error: null };
        } else if ((p["raw"] as Record<string, unknown>)?.["settle_error"]) log.push("claim_released");
        return { data: null, error: null };
      }
      if (op.table === "invoices" && op.kind === "select" && op.filters.some(([n, a]) => n === "eq" && a[0] === "id"))
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
    expect(retry.log).toEqual(["claim", "invoice:paid", "dunning_cleared", "plan_active", "payment_paid"]);
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
    expect((await markPaid(db.supabase, "inv-1", "pay-1", 100)).error).toMatch(/invoice read failed/);
  });
});
