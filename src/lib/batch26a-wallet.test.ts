import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";
import { memoryDb } from "./test-support/memory-db";
import { meta, world } from "./test-support/campaign-world";
import { DISPATCH_DEFAULTS, resetDispatchCaches, runCampaignDispatch } from "./campaign-dispatch.server";
import { adminAdjustment } from "./billing-admin.server";
import { retryFailedDebits, DEBIT_ALERT_ACTION } from "./billing-sweep.server";
import { creditsCover } from "./billing.server";

/**
 * Batch 26a — the wallet never gives messages away.
 *
 *  C1  a campaign hold refuses what the wallet can't cover; the worker pauses
 *      that campaign with a reason; debits that failed when a message was
 *      priced are retried until charged, and the admins are told.
 *  H3  a negative admin adjustment lowers the balance.
 *  H4  a debit priced after its campaign settled never takes another
 *      campaign's hold.
 *  M10 a message whose pricing hasn't arrived (read before delivered) is not
 *      priced at 0 for good.
 *
 * The SQL runs for real: a throwaway Postgres 16 with the production billing
 * bodies (test-support/loadtest/schema.sql: billing_debit_message,
 * trg_messages_billing, price_message) and 20261065_batch26a_wallet.sql on
 * top. Skipped only where Postgres 16 isn't installed and CI isn't set.
 */

const MIGRATION = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261065_batch26a_wallet.sql",
);
const LIVE = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261066_live_only_billing.sql",
);
const SCHEMA = join(import.meta.dirname, "test-support/loadtest/schema.sql");
const STUBS = join(import.meta.dirname, "test-support/wallet-stubs.sql");
const runSql = pgAvailable() || Boolean(process.env["CI"]);

describe.runIf(runSql)("Batch 26a — wallet SQL (real Postgres)", () => {
  let pg: ScratchPg;
  beforeAll(() => {
    // The live billing bodies saved in M17 (with test stand-ins for what they
    // touch that the load-test schema lacks), then this batch's migration.
    pg = startScratchPg({ schemaFile: SCHEMA, migrations: [STUBS, LIVE, MIGRATION] });
  }, 120_000);
  afterAll(() => pg?.stop());

  /** A fresh workspace with billing on and `credits` in the wallet. */
  const workspace = (credits: number, overdraft = 0): string => {
    const id = pg.sql(
      `insert into organizations (name, billing_enabled_at) values ('Store', now() - interval '1 day') returning id`,
    );
    pg.sql(`insert into organization_billing_settings values ('${id}', ${overdraft})`);
    if (credits > 0) pg.sql(`select wallet_apply('${id}', 'credit_purchase', ${credits})`);
    return id;
  };
  const wallet = (org: string) => {
    const [balance, held] = pg
      .sql(`select balance, held from wallet_balances where organization_id = '${org}'`)
      .split("|")
      .map(Number);
    return { balance, held };
  };
  const campaign = (org: string) =>
    pg.sql(`insert into campaigns (organization_id, name) values ('${org}', 'C') returning id`);
  const hold = (org: string, c: string, amount: number) =>
    pg.sql(`select wallet_apply('${org}', 'hold', ${amount}, 'campaign', '${c}')`);
  const release = (org: string, c: string, amount: number) =>
    pg.sql(`select wallet_apply('${org}', 'hold_release', ${amount}, 'campaign', '${c}')`);
  const debit = (org: string, c: string, amount: number) =>
    pg.sql(
      `select wallet_apply('${org}', 'debit_message', ${amount}, 'message', gen_random_uuid(), 'Message marketing',
         jsonb_build_object('campaign_id', '${c}', 'from_hold', true))`,
    );

  // ------------------------------------------------------------------ C1
  it("C1: two campaigns launched back to back with credit for one — the second hold is refused", () => {
    const org = workspace(100);
    const a = campaign(org);
    const b = campaign(org);
    hold(org, a, 80);
    expect(() => hold(org, b, 80)).toThrow(/INSUFFICIENT_CREDITS/);
    expect(wallet(org)).toEqual({ balance: 100, held: 80 });
    // Nothing was written for the refused hold.
    expect(
      pg.sql(`select count(*) from wallet_ledger where reference_id = '${b}'`),
    ).toBe("0");
  });

  it("C1: a hold fits balance + overdraft − held, exactly", () => {
    const org = workspace(50, 30);
    const a = campaign(org);
    const b = campaign(org);
    hold(org, a, 60); // 50 + 30 − 0 ≥ 60
    hold(org, b, 20); // 50 + 30 − 60 = 20 ≥ 20
    expect(() => hold(org, campaign(org), 0.01)).toThrow(/INSUFFICIENT_CREDITS/);
    expect(wallet(org).held).toBe(80);
  });

  it("C1: a zero wallet holds nothing", () => {
    const org = workspace(0);
    expect(() => hold(org, campaign(org), 1)).toThrow(/INSUFFICIENT_CREDITS/);
  });

  it("C1: a debit that failed when the message was priced is retried and charged once credits arrive", () => {
    const org = workspace(0);
    const contact = pg.sql(
      `insert into contacts (organization_id, phone) values ('${org}', '+919800000001') returning id`,
    );
    const conv = pg.sql(
      `insert into conversations (organization_id, contact_id) values ('${org}', '${contact}') returning id`,
    );
    const msg = pg.sql(
      `insert into messages (organization_id, conversation_id, direction, status, billable, pricing_category)
       values ('${org}', '${conv}', 'outbound', 'delivered', true, 'utility') returning id`,
    );
    // Priced at zero credits: the trigger swallows the failed debit.
    pg.sql(`select price_message('${msg}')`);
    expect(
      pg.sql(`select count(*) from usage_records where meter_key = 'billing_debit_failed' and metadata->>'message_id' = '${msg}'`),
    ).toBe("1");
    expect(wallet(org).balance).toBe(0);

    // Still no credits: the retry keeps the row open and reports it.
    const first = JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`));
    expect(first).toMatchObject({ retried: 1, charged: 0, failing: 1 });
    expect(first.failing_rows[0]).toMatchObject({ organization_id: org, message_id: msg });
    expect(
      pg.sql(`select metadata->>'attempts' from usage_records where metadata->>'message_id' = '${msg}'`),
    ).toBe("1");

    // Credits added: the next sweep charges it, once.
    pg.sql(`select wallet_apply('${org}', 'credit_purchase', 10)`);
    const second = JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`));
    expect(second).toMatchObject({ retried: 1, charged: 1, failing: 0 });
    expect(wallet(org).balance).toBe(9.88);
    const third = JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`));
    expect(third).toMatchObject({ retried: 0, charged: 0, failing: 0 });
    expect(
      pg.sql(`select count(*) from wallet_ledger where reference_id = '${msg}' and entry_type = 'debit_message'`),
    ).toBe("1");
    expect(
      pg.sql(`select metadata->>'resolution' from usage_records where metadata->>'message_id' = '${msg}'`),
    ).toBe("charged");
  });

  it("C1: a failed-debit row whose message was charged meanwhile is closed without a second charge", () => {
    const org = workspace(5);
    const msg = pg.sql(
      `insert into messages (organization_id, direction, status, billable, pricing_category, cost_amount)
       values ('${org}', 'outbound', 'delivered', true, 'utility', 0.12) returning id`,
    );
    // The trigger charged it (cost_amount set on insert doesn't fire; charge by hand).
    pg.sql(`select billing_debit_message('${msg}')`);
    pg.sql(
      `insert into usage_records (organization_id, meter_key, metadata)
       values ('${org}', 'billing_debit_failed', jsonb_build_object('message_id', '${msg}'))`,
    );
    const out = JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`));
    expect(out).toMatchObject({ retried: 1, charged: 0, closed: 1, failing: 0 });
    expect(
      pg.sql(`select count(*) from wallet_ledger where reference_id = '${msg}' and entry_type = 'debit_message'`),
    ).toBe("1");
  });

  it("C1: an AI answer over the allowance at zero credits is charged by the retry once credits arrive", () => {
    const org = workspace(0);
    pg.sql(`update organization_billing_settings set ai_answers_included_override = 1 where organization_id = '${org}'`);
    // Within the allowance: never charged.
    pg.sql(`insert into ai_runs (organization_id, status, billed_amount, created_at)
            values ('${org}', 'ok', 2, now() - interval '1 minute')`);
    // Over it, at zero credits: the live trigger swallows the failed debit.
    const run = pg.sql(
      `insert into ai_runs (organization_id, status, billed_amount, cost_amount) values ('${org}', 'ok', 2, 0.4) returning id`,
    );
    expect(
      pg.sql(`select count(*) from usage_records where meter_key = 'billing_debit_failed' and metadata->>'ai_run_id' = '${run}'`),
    ).toBe("1");

    const first = JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`));
    expect(first).toMatchObject({ retried: 1, charged: 0, failing: 1 });
    expect(first.failing_rows[0]).toMatchObject({ organization_id: org, ai_run_id: run });

    pg.sql(`select wallet_apply('${org}', 'credit_purchase', 10)`);
    expect(JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`))).toMatchObject({ charged: 1, failing: 0 });
    expect(wallet(org).balance).toBe(8);
    expect(
      pg.sql(`select entry_type || ' ' || amount || ' ' || description from wallet_ledger where reference_type = 'ai_run' and reference_id = '${run}'`),
    ).toBe("debit_ai -2.00 AI answer (over allowance)");
    expect(pg.sql(`select billed_amount from ai_usage_months where organization_id = '${org}'`)).toBe("2.00");
    // Never twice.
    expect(JSON.parse(pg.sql(`select billing_retry_failed_debits(200)`))).toMatchObject({ retried: 0 });
    expect(pg.sql(`select billing_debit_ai_run('${run}')`)).toBe("f");
  });

  it("M17: the saved live billing file applies twice without error (idempotent)", () => {
    // Applied once in beforeAll; the trigger and policy statements re-run cleanly.
    expect(() => pg.sql(readFileSync(LIVE, "utf8"))).not.toThrow();
    expect(
      pg.sql(`select count(*) from pg_trigger where tgname in ('messages_billing_debit','ai_runs_billing_debit','coupons_super_admin_audit')`),
    ).toBe("3");
  });

  // ------------------------------------------------------------------ H3
  it("H3: a negative adjustment lowers the balance; a positive one still raises it", () => {
    const org = workspace(100);
    pg.sql(`select wallet_apply('${org}', 'adjustment', -30, 'manual', null, 'over-credited')`);
    expect(wallet(org).balance).toBe(70);
    expect(
      pg.sql(`select amount from wallet_ledger where organization_id = '${org}' and entry_type = 'adjustment'`),
    ).toBe("-30.00");
    pg.sql(`select wallet_apply('${org}', 'adjustment', 5, 'manual')`);
    expect(wallet(org).balance).toBe(75);
    expect(pg.sql(`select wallet_apply_version()`)).toBe("2");
  });

  it("H3: a negative adjustment can't take the balance below the overdraft", () => {
    const org = workspace(10, 5);
    expect(() => pg.sql(`select wallet_apply('${org}', 'adjustment', -16, 'manual')`)).toThrow(
      /INSUFFICIENT_CREDITS/,
    );
    expect(wallet(org).balance).toBe(10);
  });

  // ------------------------------------------------------------------ H4
  it("H4: a late debit after settle doesn't touch another campaign's hold", () => {
    const org = workspace(1000);
    const a = campaign(org);
    const b = campaign(org);
    hold(org, a, 50);
    hold(org, b, 50);
    debit(org, a, 10); // taken from A's own hold
    expect(wallet(org)).toEqual({ balance: 990, held: 90 });
    release(org, a, 40); // A settles: 50 held − 10 charged
    expect(wallet(org).held).toBe(50); // B's alone
    debit(org, a, 5); // Meta prices one more of A's messages after the settle
    expect(wallet(org)).toEqual({ balance: 985, held: 50 });
    expect(
      pg.sql(
        `select metadata->>'held_taken' from wallet_ledger where organization_id = '${org}' and entry_type = 'debit_message' order by created_at desc limit 1`,
      ),
    ).toBe("0.00");
  });

  it("H4: a campaign that costs more than it held stops taking from held at its own hold", () => {
    const org = workspace(1000);
    const a = campaign(org);
    const b = campaign(org);
    hold(org, a, 10);
    hold(org, b, 40);
    debit(org, a, 6);
    debit(org, a, 6); // only 4 of A's hold was left
    expect(wallet(org)).toEqual({ balance: 988, held: 40 });
    release(org, a, 0); // settle: nothing left to release
    expect(wallet(org).held).toBe(40);
    // A release asking for more than the campaign still holds gives back only its own.
    release(org, a, 25);
    expect(wallet(org).held).toBe(40);
  });

  it("H4: a campaign that held before this migration is picked up from the ledger", () => {
    const org = workspace(1000);
    const a = campaign(org);
    const b = campaign(org);
    hold(org, a, 30);
    hold(org, b, 30);
    debit(org, a, 10);
    // As if the hold and debit were written by the old wallet_apply.
    pg.sql(`delete from wallet_campaign_holds where campaign_id = '${a}'`);
    pg.sql(
      `update wallet_ledger set metadata = metadata - 'held_taken' where metadata->>'campaign_id' = '${a}'`,
    );
    release(org, a, 20); // 30 held − 10 charged
    expect(wallet(org).held).toBe(30);
    debit(org, a, 3);
    expect(wallet(org).held).toBe(30);
  });

  // ------------------------------------------------------------------ M10
  it("M10: a read status before delivered leaves the message unpriced, not free; known pricing still prices", () => {
    const org = workspace(100);
    const contact = pg.sql(
      `insert into contacts (organization_id, phone) values ('${org}', '+919800000002') returning id`,
    );
    const conv = pg.sql(
      `insert into conversations (organization_id, contact_id) values ('${org}', '${contact}') returning id`,
    );
    // Read landed first: no pricing on it, billable unknown.
    const msg = pg.sql(
      `insert into messages (organization_id, conversation_id, direction, status)
       values ('${org}', '${conv}', 'outbound', 'read') returning id`,
    );
    expect(pg.sql(`select price_message('${msg}')`)).toBe("t");
    expect(pg.sql(`select coalesce(cost_amount::text, 'null') from messages where id = '${msg}'`)).toBe("null");
    // Meta's pricing arrives (Batch 27 applies it to a message already read): priced and charged.
    pg.sql(`update messages set billable = true, pricing_category = 'marketing' where id = '${msg}'`);
    pg.sql(`select price_message('${msg}')`);
    expect(pg.sql(`select cost_amount from messages where id = '${msg}'`)).toBe("0.8600");
    expect(wallet(org).balance).toBe(99.14);
  });

  it("M10: pricing that never arrives is settled as free after the hour, by the reprice job only then", () => {
    const org = workspace(100);
    const young = pg.sql(
      `insert into messages (organization_id, direction, status, created_at)
       values ('${org}', 'outbound', 'read', now() - interval '20 minutes') returning id`,
    );
    const old = pg.sql(
      `insert into messages (organization_id, direction, status, created_at)
       values ('${org}', 'outbound', 'read', now() - interval '2 hours') returning id`,
    );
    pg.sql(`select reprice_unpriced_messages()`);
    expect(pg.sql(`select coalesce(cost_amount::text, 'null') from messages where id = '${young}'`)).toBe("null");
    expect(pg.sql(`select cost_amount from messages where id = '${old}'`)).toBe("0.0000");
    // billable = false is still free at once.
    const free = pg.sql(
      `insert into messages (organization_id, direction, status, billable) values ('${org}', 'outbound', 'delivered', false) returning id`,
    );
    pg.sql(`select price_message('${free}')`);
    expect(pg.sql(`select cost_amount from messages where id = '${free}'`)).toBe("0.0000");
  });

  // ------------------------------------------------------------------ C1, end to end
  describe("C1: the campaign worker against the real wallet", () => {
    const cfg = () => ({
      ...DISPATCH_DEFAULTS,
      lane: 0,
      lanes: 1,
      budgetMs: 2_000,
      flushMs: 5,
      statusPollMs: 40,
      numberMps: 1_000,
    });
    beforeEach(() => resetDispatchCaches());

    it("two campaigns launched back to back with credit for one: the first sends, the second pauses for credits", async () => {
      const { db, campaigns } = world({
        billing: true,
        campaigns: [
          { recipients: 3, estimatedCost: 80 },
          { recipients: 3, estimatedCost: 80 },
        ],
      });
      // One workspace wallet for both (the in-memory world gives each its own store).
      const org = workspace(100);
      const realId = new Map<string, string>();
      const asUuid = (id: unknown) => {
        const key = String(id);
        if (!realId.has(key)) realId.set(key, pg.sql(`select gen_random_uuid()`));
        return realId.get(key)!;
      };
      db.rpcs.set("wallet_apply", (a) =>
        pg.sql(
          `select wallet_apply('${org}', '${String(a["p_type"])}', ${Number(a["p_amount"])}, ` +
            `${a["p_ref_type"] ? `'${String(a["p_ref_type"])}'` : "null"}, ` +
            `${a["p_ref_id"] ? `'${asUuid(a["p_ref_id"])}'` : "null"})`,
        ),
      );

      const g = meta();
      const report = await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });

      const row = (id: string) => db.rows("campaigns").find((c) => c["id"] === id)!;
      // The first reserved, sent all three and settled (nothing priced yet).
      expect(row(campaigns[0]!.id)["status"]).toBe("completed");
      expect(row(campaigns[0]!.id)["returned_amount"]).toBe(80);
      expect(g.sends).toHaveLength(3);
      expect(
        pg.sql(`select string_agg(entry_type || ' ' || amount, ', ' order by created_at) from wallet_ledger where organization_id = '${org}'`),
      ).toBe("credit_purchase 100.00, hold -80.00, hold_release 80.00");
      // The second never reserved, never sent, and says why it stopped.
      expect(row(campaigns[1]!.id)["status"]).toBe("paused");
      expect(row(campaigns[1]!.id)["pause_reason"]).toBe("insufficient_credits");
      expect(row(campaigns[1]!.id)["sent_count"]).toBe(0);
      expect(report.campaigns).toContainEqual({
        campaign_id: campaigns[1]!.id,
        paused: "insufficient_credits",
      });
      expect(wallet(org)).toEqual({ balance: 100, held: 0 });
    });
  });
});

// ---------------------------------------------------------------- dispatcher (no SQL)
describe("C1: the worker only pauses for a refusal, not for a failed call", () => {
  beforeEach(() => resetDispatchCaches());
  const cfg = () => ({
    ...DISPATCH_DEFAULTS,
    lane: 0,
    lanes: 1,
    budgetMs: 2_000,
    flushMs: 5,
    statusPollMs: 40,
    numberMps: 1_000,
  });

  it("a reservation call that fails sends nothing and leaves the campaign running for the next tick", async () => {
    const { db, campaigns } = world({ billing: true, campaigns: [{ recipients: 3, estimatedCost: 9 }] });
    db.rpcs.set("wallet_apply", () => {
      throw new Error("connection reset");
    });
    const g = meta();
    const report = await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends).toHaveLength(0);
    const row = db.rows("campaigns").find((c) => c["id"] === campaigns[0]!.id)!;
    expect(row["status"]).toBe("sending");
    expect(row["pause_reason"] ?? null).toBeNull();
    expect(report.campaigns).toContainEqual({
      campaign_id: campaigns[0]!.id,
      hold_error: "We couldn't reserve credits for this campaign. Please try again.",
    });
  });

  it("a refused hold whose campaign another run already reserved is not paused", async () => {
    const { db, campaigns } = world({ billing: true, campaigns: [{ recipients: 2, estimatedCost: 9 }] });
    db.rpcs.set("wallet_apply", (_a, d) => {
      // The overlapping run recorded its reservation a moment before ours was refused.
      d.rows("campaigns").find((c) => c["id"] === campaigns[0]!.id)!["held_amount"] = 9;
      throw new Error("INSUFFICIENT_CREDITS: hold 9 exceeds available 0");
    });
    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    const row = db.rows("campaigns").find((c) => c["id"] === campaigns[0]!.id)!;
    expect(row["status"]).not.toBe("paused");
    expect(g.sends).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- H3 (server)
describe("H3: adminAdjustment sends the sign through, only to a wallet that honours it", () => {
  const seed = () => ({ profiles: [{ id: "admin", is_super_admin: true }], activity_log: [] });

  it("a negative amount goes to wallet_apply as a signed adjustment", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const db = memoryDb(seed(), {
      wallet_apply_version: () => ({ data: 2, error: null }),
      wallet_apply: (args) => {
        calls.push(args);
        return { data: "entry", error: null };
      },
    });
    const out = await adminAdjustment(db.supabase, {
      actorId: "admin",
      organizationId: "org",
      amount: -50,
      reason: "over-credited on 3 Oct",
    });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_type: "adjustment", p_amount: -50 });
  });

  it("without the Batch 26a wallet a negative adjustment is refused before it can add credits", async () => {
    const calls: unknown[] = [];
    const db = memoryDb(seed(), {
      wallet_apply: (args) => {
        calls.push(args);
        return { data: "entry", error: null };
      },
    });
    const out = await adminAdjustment(db.supabase, {
      actorId: "admin",
      organizationId: "org",
      amount: -50,
      reason: "over-credited",
    });
    expect(out).toHaveProperty("error");
    expect(calls).toHaveLength(0);
  });

  it("a positive adjustment needs no version check (unchanged)", async () => {
    const db = memoryDb(seed(), { wallet_apply: () => ({ data: "entry", error: null }) });
    expect(
      await adminAdjustment(db.supabase, { actorId: "admin", organizationId: "org", amount: 20, reason: "goodwill" }),
    ).toEqual({ ok: true });
  });

  it("a negative adjustment the overdraft won't allow says so", async () => {
    const db = memoryDb(seed(), {
      wallet_apply_version: () => ({ data: 2, error: null }),
      wallet_apply: () => ({ data: null, error: { message: "INSUFFICIENT_CREDITS: balance -6 would fall below overdraft limit -5" } }),
    });
    const out = await adminAdjustment(db.supabase, { actorId: "admin", organizationId: "org", amount: -16, reason: "x" });
    expect(out).toEqual({ error: expect.stringMatching(/overdraft/) });
  });
});

// ---------------------------------------------------------------- C1 sweep + alert
describe("C1: the sweep retries failed debits and tells the admins once a day", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const failing = {
    retried: 3,
    charged: 1,
    closed: 0,
    failing: 2,
    failing_rows: [
      { organization_id: "org-a", message_id: "m1", since: "2026-10-01T10:00:00Z", error: "INSUFFICIENT_CREDITS" },
      { organization_id: "org-a", message_id: "m2", since: "2026-10-02T10:00:00Z", error: "INSUFFICIENT_CREDITS" },
    ],
  };

  it("still-failing debits raise one admin alert on the existing admin template, not a new one", async () => {
    const db = memoryDb(
      { activity_log: [], billing_notifications: [] },
      { billing_retry_failed_debits: () => ({ data: failing, error: null }) },
    );
    const out = await retryFailedDebits(db.supabase);
    expect(out).toEqual({ retried: 3, charged: 1, failing: 2, alerted: true });
    expect(db.rows("activity_log")).toEqual([
      expect.objectContaining({ action: DEBIT_ALERT_ACTION, organization_id: null }),
    ]);
    expect(db.rows("billing_notifications")).toEqual([
      expect.objectContaining({
        audience: "admin",
        kind: "billing_debit_alert",
        organization_id: null,
        payload: expect.objectContaining({ link: "https://aidwar.in/admin/billing" }),
      }),
    ]);

    // The next sweep, minutes later: retried again, not alerted again.
    const again = await retryFailedDebits(db.supabase);
    expect(again.alerted).toBe(false);
    expect(db.rows("billing_notifications")).toHaveLength(1);
  });

  it("nothing failing: no alert", async () => {
    const db = memoryDb(
      { activity_log: [], billing_notifications: [] },
      { billing_retry_failed_debits: () => ({ data: { retried: 1, charged: 1, failing: 0 }, error: null }) },
    );
    expect(await retryFailedDebits(db.supabase)).toEqual({ retried: 1, charged: 1, failing: 0, alerted: false });
    expect(db.rows("billing_notifications")).toHaveLength(0);
  });

  it("before the migration is applied the sweep carries on (no throw, nothing queued)", async () => {
    const db = memoryDb({ activity_log: [], billing_notifications: [] });
    expect(await retryFailedDebits(db.supabase)).toEqual({ retried: 0, charged: 0, failing: 0, alerted: false });
  });

  it("the alert kind is mapped to the approved admin_ai_provider_alert template", async () => {
    const src = readFileSync(join(import.meta.dirname, "billing-notify.server.ts"), "utf8");
    expect(src).toContain('"admin:billing_debit_alert": "admin_ai_provider_alert"');
    expect(src).toMatch(/case "billing_debit_alert":\s*\n\s*return \[/);
  });
});

// ---------------------------------------------------------------- resume check
describe("C1: resume answers at once when credits still don't cover the campaign", () => {
  it("creditsCover = balance + overdraft − held", async () => {
    const db = memoryDb({
      wallet_balances: [{ organization_id: "org", balance: 50, held: 20 }],
      organization_billing_settings: [{ organization_id: "org", overdraft_limit: 10 }],
    });
    expect(await creditsCover(db.supabase, "org", 40)).toEqual({ covers: true, available: 40 });
    expect(await creditsCover(db.supabase, "org", 40.01)).toEqual({ covers: false, available: 40 });
  });
});
