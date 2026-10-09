import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryDb } from "./test-support/campaign-memory-db";
import { DISPATCH_DEFAULTS, resetDispatchCaches, runCampaignDispatch, type DispatchConfig } from "./campaign-dispatch.server";
import { campaignCallbackData } from "./campaign-callback";
import { meta, world, type Row } from "./test-support/campaign-world";

/**
 * Batch 28 — campaigns.
 *
 *  8  Status processing never depends on the counter function
 *     (campaign_recipient_status was missing on live: every campaign status
 *     failed, unpriced). And the "works without this file" claims of
 *     20261016 / 20261027 are now true, tested with the function answering
 *     PGRST202.
 *  7  A 1-contact campaign whose message was delivered shows 1 delivered.
 * 12  A campaign that ended alone (no other campaign live, so the worker
 *     never got to its bookkeeping) and was priced after it completed is
 *     settled by the billing sweep: held 0, charged = ledger sum, and only
 *     what its reservation still had is released — never charged twice.
 */

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

beforeEach(() => resetDispatchCaches());
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  await Promise.all([import("./whatsapp-api.server"), import("./campaign-billing.server"), import("./templates"), import("./customer-cards.server")]);
});

const statusPayload = (pn: string, statuses: Array<Record<string, unknown>>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, statuses } }] }],
});

async function deliver(db: MemoryDb, pn: string, statuses: Array<Record<string, unknown>>) {
  const { processWebhookPayload } = await import("./whatsapp-webhook.server");
  const event = db.insert("webhook_events", { provider: "meta", processed_at: null, error: null });
  await processWebhookPayload(db.client, event["id"] as string, statusPayload(pn, statuses));
  return event;
}

async function sentCampaign(recipients = 1) {
  const w = world({ campaigns: [{ recipients }] });
  const g = meta();
  await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
  const c = w.campaigns[0]!;
  const r = c.recipients[0]!;
  const metaId = w.db.rows("messages").find((m) => (m["metadata"] as Row)["campaign_recipient_id"] === r["id"])!["meta_message_id"] as string;
  const st = (status: string) => ({ id: metaId, status, timestamp: "1760000000", biz_opaque_callback_data: campaignCallbackData(c.id, r["id"] as string) });
  return { ...w, c, r, metaId, st };
}

describe("item 8 — a status never depends on the counter function", () => {
  beforeEach(() => vi.resetModules());

  it("campaign_recipient_status missing (PGRST202): the message still moves, is priced and its event goes; the counter failure is logged on its own", async () => {
    const { db, c, metaId, st } = await sentCampaign();
    const counterFn = db.rpcs.get("campaign_recipient_status")!;
    db.rpcs.delete("campaign_recipient_status");
    const priced: string[] = [];
    db.rpcs.set("price_message", (a) => (priced.push(String(a["p_message_id"])), true));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = await deliver(db, c.pn, [st("delivered")]);
    const message = db.rows("messages").find((m) => m["meta_message_id"] === metaId)!;
    expect(message["status"]).toBe("delivered");
    expect(priced).toEqual([message["id"]]);
    expect(db.rows("analytics_events").filter((e) => e["event_type"] === "message.delivered")).toHaveLength(1);
    expect(warn.mock.calls.some((args) => String(args[0]).includes('"scope":"campaign_counter"') && String(args[0]).includes("PGRST202"))).toBe(true);
    // The counter alone keeps the event retryable.
    expect(event["processed_at"]).toBeFalsy();
    expect(String(event["error"])).toMatch(/counter/);

    // The function is applied; the retry counts it once and never prices again.
    db.rpcs.set("campaign_recipient_status", counterFn);
    message["cost_amount"] = 0.86;
    await deliver(db, c.pn, [st("delivered")]);
    expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1 });
    expect(priced).toHaveLength(1);
  });

  it("campaign_ledger_charge missing (PGRST202): the charge is summed from the ledger rows (20261016's fallback, now real)", async () => {
    const { campaignLedgerCharge } = await import("./campaign-billing.server");
    const { db, c } = await sentCampaign();
    db.rpcs.delete("campaign_ledger_charge");
    for (const amount of [-0.86, -0.18]) db.insert("wallet_ledger", { organization_id: c.orgId, entry_type: "debit_message", amount, metadata: { campaign_id: c.id } });
    db.insert("wallet_ledger", { organization_id: c.orgId, entry_type: "debit_message", amount: -5, metadata: { campaign_id: "another" } });
    expect(await campaignLedgerCharge(db.client, c.orgId, c.id)).toEqual({ amount: 1.04, error: null });
  });

  it("ai_usage_add missing (PGRST202): meterAiUsage still adds to the day's row (20261027's fallback)", async () => {
    const { MemoryDb } = await import("./test-support/campaign-memory-db");
    const db = new MemoryDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { meterAiUsage } = await import("./ai-run.server");
    await meterAiUsage(db.client, "org-1", "extract_facts", { costAmount: 0.5, runs: 1 });
    await meterAiUsage(db.client, "org-1", "extract_facts", { costAmount: 0.25, runs: 1 });
    const rows = db.rows("ai_usage").filter((r) => r["organization_id"] === "org-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runs: 2, cost_amount: 0.75 });
  });
});

describe("item 7 — campaign counts", () => {
  beforeEach(() => vi.resetModules());

  it("a 1-contact campaign whose message was delivered shows delivered 1 (100%)", async () => {
    const { db, c, st } = await sentCampaign(1);
    await deliver(db, c.pn, [st("delivered")]);
    const row = campaignRow(db, c.id);
    expect(row).toMatchObject({ sent_count: 1, delivered_count: 1, read_count: 0 });
    // The list shows percent(delivered_count, total_recipients) (campaigns-view).
    const { percent } = await import("./campaigns");
    expect(percent(Number(row["delivered_count"]), Number(row["total_recipients"]))).toBe(100);
    expect(percent(Number(row["read_count"]), Number(row["total_recipients"]))).toBe(0);
  });
});

/**
 * The wallet as 20261065 has it, for one workspace: a campaign's hold adds to
 * its own reservation (wallet_campaign_holds.remaining), a from_hold debit
 * takes at most what is left there, and a hold_release gives back at most
 * that.
 */
function realWallet(db: MemoryDb) {
  const holdRow = (cid: string, org: string) => {
    let r = db.rows("wallet_campaign_holds").find((x) => x["campaign_id"] === cid);
    if (!r) r = db.insert("wallet_campaign_holds", { campaign_id: cid, organization_id: org, remaining: 0 });
    return r;
  };
  db.rpcs.set("wallet_apply", (a, d) => {
    const amount = Math.abs(Number(a["p_amount"]));
    const cid = String(a["p_ref_id"] ?? "");
    let entry = amount;
    if (a["p_type"] === "hold" && a["p_ref_type"] === "campaign") {
      const r = holdRow(cid, String(a["p_org"]));
      r["remaining"] = Number(r["remaining"]) + amount;
    }
    if (a["p_type"] === "hold_release" && cid) {
      const r = holdRow(cid, String(a["p_org"]));
      entry = Math.min(amount, Number(r["remaining"]));
      r["remaining"] = Number(r["remaining"]) - entry;
    }
    return d.insert("wallet_ledger", {
      organization_id: a["p_org"],
      entry_type: a["p_type"],
      amount: a["p_type"] === "hold" ? -amount : entry,
      reference_type: a["p_ref_type"],
      reference_id: a["p_ref_id"],
      metadata: a["p_metadata"],
    })["id"];
  });
  /** Meta prices the message: the database's debit, from the hold while it lasts. */
  return (org: string, cid: string, price: number) => {
    const r = holdRow(cid, org);
    const taken = Math.min(price, Number(r["remaining"]));
    r["remaining"] = Number(r["remaining"]) - taken;
    db.insert("wallet_ledger", { organization_id: org, entry_type: "debit_message", amount: -price, metadata: { campaign_id: cid, from_hold: "true", held_taken: taken } });
  };
}

describe("item 12 — a campaign priced after it completed is settled by the billing sweep", () => {
  async function completedAlone(opts: { settleFails: boolean }) {
    const w = world({ billing: true, campaigns: [{ recipients: 1, estimatedCost: 1.04 }] });
    const price = realWallet(w.db);
    const c = w.campaigns[0]!;
    const ledgerFn = w.db.rpcs.get("campaign_ledger_charge")!;
    // 8 Oct 12:30: the function wasn't on live yet — the settle at completion failed.
    if (opts.settleFails) w.db.rpcs.set("campaign_ledger_charge", () => { throw new Error("Could not find the function"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const g = meta();
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    w.db.rpcs.set("campaign_ledger_charge", ledgerFn);
    expect(campaignRow(w.db, c.id)["status"]).toBe("completed");
    // 12:40: Meta's price arrives, ten minutes after completion.
    price(c.orgId, c.id, 1.04);
    // Nothing else is sending: the worker's own bookkeeping never runs.
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    const { runBillingSweep } = await import("./billing-sweep.server");
    const counts = await runBillingSweep(w.db.client);
    return { ...w, c, counts };
  }
  const ledgerSum = (db: MemoryDb, cid: string) =>
    db.rows("wallet_ledger").filter((r) => r["entry_type"] === "debit_message" && (r["metadata"] as Row)["campaign_id"] === cid).reduce((s, r) => s + Math.abs(Number(r["amount"])), 0);
  const released = (db: MemoryDb, cid: string) =>
    db.rows("wallet_ledger").filter((r) => r["entry_type"] === "hold_release" && r["reference_id"] === cid).reduce((s, r) => s + Number(r["amount"]), 0);

  it("live case (1803da67): settle failed at completion, priced from the hold later → held 0, charged 1.04, nothing released twice", async () => {
    const { db, c, counts } = await completedAlone({ settleFails: true });
    expect(campaignRow(db, c.id)).toMatchObject({ held_amount: 0, charged_amount: 1.04, returned_amount: 0 });
    expect(ledgerSum(db, c.id)).toBeCloseTo(1.04);
    expect(released(db, c.id)).toBe(0);
    expect(counts.campaigns_settled).toBe(1);
  });

  it("settled at completion before the price: the reservation went back, the late price is charged once and charged_amount catches up", async () => {
    const { db, c } = await completedAlone({ settleFails: false });
    expect(campaignRow(db, c.id)).toMatchObject({ held_amount: 0, charged_amount: 1.04 });
    expect(ledgerSum(db, c.id)).toBeCloseTo(1.04);
    expect(released(db, c.id)).toBeCloseTo(1.04);
    expect(db.rows("wallet_ledger").filter((r) => r["entry_type"] === "debit_message")).toHaveLength(1);
  });

  it("a second sweep changes nothing", async () => {
    const { db, c } = await completedAlone({ settleFails: true });
    const before = JSON.stringify([campaignRow(db, c.id), db.rows("wallet_ledger")]);
    const { runBillingSweep } = await import("./billing-sweep.server");
    await runBillingSweep(db.client);
    expect(JSON.stringify([campaignRow(db, c.id), db.rows("wallet_ledger")])).toBe(before);
  });
});
