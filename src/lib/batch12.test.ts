import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "./test-support/memory-db";
import {
  DISPATCH_DEFAULTS,
  FairRotation,
  NumberRateLimiter,
  STALE_SEND_ERROR,
  UNKNOWN_SEND_ERROR,
  classifyGraphAnswer,
  dispatchConfig,
  resetDispatchCaches,
  runCampaignDispatch,
  type DispatchConfig,
  type GraphAnswer,
} from "./campaign-dispatch.server";
import { campaignCallbackData, parseCampaignCallbackData } from "./campaign-callback";

/**
 * Batch 12 — sending at scale. Every correctness rule of the campaign sender
 * and the status webhook, run end to end against an in-memory database with
 * state (claims, conditional updates, counters):
 *   at most once (also with two runs at the same time, and after a run that
 *   died), opt-out at send time, pause / cancel within seconds, Meta's
 *   throughput errors, per-number speed, fairness, lanes and the wallet hold,
 *   the time budget, completion, counters, and the status path.
 */

import { meta, world, type Row } from "./test-support/campaign-world";

const now = () => new Date().toISOString();

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

const recipientsOf = (db: MemoryDb, campaignId: string) =>
  db.rows("campaign_recipients").filter((r) => r["campaign_id"] === campaignId);
const campaignRow = (db: MemoryDb, id: string) => db.rows("campaigns").find((r) => r["id"] === id)!;
const recipientOfTag = (tag: string) => parseCampaignCallbackData(tag)?.recipientId;

beforeEach(() => resetDispatchCaches());
afterEach(() => vi.useRealTimers());

// ----------------------------------------------------------------- pure parts

describe("pure parts", () => {
  it("Meta's answers: throughput errors retry, 131049 and other rejections fail, no answer is never retried", () => {
    const r = (status: number, code?: number): GraphAnswer => ({
      kind: "response",
      ok: status < 300,
      status,
      body: code
        ? { error: { code, message: "x" } }
        : status < 300
          ? { messages: [{ id: "wamid.1" }] }
          : {},
    });
    expect(classifyGraphAnswer(r(200))).toEqual({ kind: "sent", metaMessageId: "wamid.1" });
    expect(classifyGraphAnswer(r(400, 130429))).toMatchObject({
      kind: "throttled",
      scope: "number",
    });
    expect(classifyGraphAnswer(r(400, 131048))).toMatchObject({
      kind: "throttled",
      scope: "number",
    });
    expect(classifyGraphAnswer(r(400, 80007))).toMatchObject({
      kind: "throttled",
      scope: "number",
    });
    expect(classifyGraphAnswer(r(503, 131016))).toMatchObject({
      kind: "throttled",
      scope: "number",
    });
    expect(classifyGraphAnswer(r(429))).toMatchObject({ kind: "throttled", scope: "number" });
    expect(classifyGraphAnswer(r(400, 131056))).toMatchObject({
      kind: "throttled",
      scope: "recipient",
    });
    expect(classifyGraphAnswer(r(400, 131049))).toEqual({ kind: "failed", code: "131049" });
    expect(classifyGraphAnswer(r(400, 131047))).toEqual({ kind: "failed", code: "131047" });
    expect(classifyGraphAnswer(r(500, 131000))).toEqual({ kind: "failed", code: "131000" });
    expect(classifyGraphAnswer(r(502))).toMatchObject({ kind: "unknown", status: 502 });
    expect(classifyGraphAnswer({ kind: "no_response", reason: "TimeoutError" })).toMatchObject({
      kind: "unknown",
    });
  });

  it("per-number token bucket: never faster than its rate; a throttle answer pauses and halves it", () => {
    let t = 0;
    const limiter = new NumberRateLimiter(10, () => t);
    let sent = 0;
    for (t = 0; t <= 1_000; t += 5) if (limiter.take("pn")) sent += 1;
    expect(sent).toBeLessThanOrEqual(11);
    expect(sent).toBeGreaterThanOrEqual(9);
    expect(limiter.penalize("pn")).toBe(1_000);
    expect(limiter.take("pn")).toBe(false);
    expect(limiter.waitMs("pn")).toBeGreaterThan(900);
    expect(limiter.rate("pn")).toBe(5);
    expect(limiter.penalize("pn")).toBe(2_000);
    t += 2_000;
    limiter.reward("pn");
    expect(limiter.rate("pn")).toBeCloseTo(3);
    // Other numbers are untouched.
    expect(limiter.waitMs("other")).toBe(0);
  });

  it("fair rotation: workspace by workspace, then campaign by campaign", () => {
    const items = [
      { id: "a1", org: "A" },
      { id: "a2", org: "A" },
      { id: "a3", org: "A" },
      { id: "b1", org: "B" },
    ];
    const rot = new FairRotation(items, (x) => x.org);
    const order = Array.from({ length: 8 }, () => rot.pick(() => true)!.id);
    expect(order).toEqual(["a1", "b1", "a2", "b1", "a3", "b1", "a1", "b1"]);
    expect(rot.pick((x) => x.id === "a3")!.id).toBe("a3");
    expect(rot.pick(() => false)).toBeNull();
  });

  it("settings: lanes from the cron body, the rest from the environment, all clamped", () => {
    expect(dispatchConfig({}, {})).toMatchObject({
      lane: 0,
      lanes: 1,
      budgetMs: 22_000,
      concurrency: 6,
      numberMps: 60,
    });
    expect(
      dispatchConfig(
        { lane: 3, lanes: 16 },
        { CAMPAIGN_NUMBER_MPS: "80", CAMPAIGN_SEND_CONCURRENCY: "20" },
      ),
    ).toMatchObject({
      lane: 3,
      lanes: 16,
      numberMps: 80,
      concurrency: 20,
    });
    expect(
      dispatchConfig({ lane: 99, lanes: 4 }, { CAMPAIGN_WORKER_BUDGET_MS: "999999" }),
    ).toMatchObject({ lane: 3, budgetMs: 25_000 });
    expect(dispatchConfig({ lane: "x", lanes: -1 }, { CAMPAIGN_NUMBER_MPS: "nope" })).toMatchObject(
      { lane: 0, lanes: 1, numberMps: 60 },
    );
  });

  it("callback data round-trips, and nothing else parses as ours", () => {
    const c = crypto.randomUUID();
    const r = crypto.randomUUID();
    expect(parseCampaignCallbackData(campaignCallbackData(c, r))).toEqual({
      campaignId: c,
      recipientId: r,
    });
    expect(parseCampaignCallbackData("hello")).toBeNull();
    expect(parseCampaignCallbackData(undefined)).toBeNull();
  });
});

// ------------------------------------------------------------- the sender

describe("sending: each recipient at most once, recorded like before", () => {
  it("sends every recipient once; message rows, recipients, events, meters and counters are written; completes once", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 40 }] });
    const g = meta();
    const report = await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    const c = campaigns[0]!;
    expect(g.sends).toHaveLength(40);
    expect(new Set(g.sends.map((s) => s.tag)).size).toBe(40);
    // The request itself: same template, the contact's own values, our tag.
    expect(g.sends[0]!.body).toMatchObject({
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: "promo",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Customer 0" }] }],
      },
    });
    expect(recipientsOf(db, c.id).every((r) => r["status"] === "sent" && r["message_id"])).toBe(
      true,
    );
    const messages = db.rows("messages");
    expect(messages).toHaveLength(40);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      type: "template",
      template_name: "promo",
      status: "pending",
      campaign_id: c.id,
      metadata: {
        template_params: { "1": expect.any(String) },
        campaign_recipient_id: expect.any(String),
      },
    });
    expect(messages.every((m) => String(m["meta_message_id"]).startsWith("wamid."))).toBe(true);
    const events = db.rows("analytics_events");
    expect(events.filter((e) => e["event_type"] === "message.sent")).toHaveLength(40);
    expect(events.filter((e) => e["event_type"] === "campaign.completed")).toHaveLength(1);
    expect(events.find((e) => e["event_type"] === "message.sent")!["properties"]).toMatchObject({
      campaign_id: c.id,
      template_name: "promo",
      billing_category: "marketing",
      message_class: "marketing",
      whatsapp_account_id: c.accountId,
    });
    expect(db.rows("usage_records").filter((u) => u["meter_key"])).toHaveLength(40);
    expect(campaignRow(db, c.id)).toMatchObject({
      status: "completed",
      sent_count: 40,
      failed_count: 0,
    });
    expect(report.sent).toBe(40);
    // One conversation per contact, opened together.
    expect(db.rows("conversations")).toHaveLength(40);
    expect(db.rows("conversations").every((cv) => cv["last_message_at"])).toBe(true);
  });

  it("two runs at the same time (two lanes, or an overlapping cron) never send anyone twice", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 150 }] });
    const g = meta(undefined, 2);
    await Promise.all([
      runCampaignDispatch(db.client, cfg({ lane: 0, lanes: 2 }), { postMessage: g.postMessage }),
      runCampaignDispatch(db.client, cfg({ lane: 1, lanes: 2 }), { postMessage: g.postMessage }),
    ]);
    expect(g.sends).toHaveLength(150);
    expect(new Set(g.sends.map((s) => s.tag)).size).toBe(150);
    const c = campaignRow(db, campaigns[0]!.id);
    expect(c).toMatchObject({ status: "completed", sent_count: 150 });
    expect(
      db.rows("analytics_events").filter((e) => e["event_type"] === "campaign.completed"),
    ).toHaveLength(1);
  });

  it("opt-out is re-checked right before sending: opted out → skipped, never sent", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 10 }] });
    const c = campaigns[0]!;
    const out = c.recipients.slice(0, 3).map((r) => r["contact_id"]);
    for (const contact of db.rows("contacts"))
      if (out.includes(contact["id"])) contact["opt_in_status"] = "opted_out";
    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends).toHaveLength(7);
    const skipped = recipientsOf(db, c.id).filter((r) => r["status"] === "skipped");
    expect(skipped.map((r) => r["contact_id"]).sort()).toEqual([...out].sort());
    expect(skipped.every((r) => r["error"] === "opted_out")).toBe(true);
    expect(campaignRow(db, c.id)).toMatchObject({
      status: "completed",
      sent_count: 7,
      failed_count: 0,
    });
  });

  it("a failed opt-out check sends nothing to those recipients (failed, counted)", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 5 }] });
    db.hook = (call) =>
      call.table === "contacts" ? { data: null, error: { message: "timeout" } } : undefined;
    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends).toHaveLength(0);
    const c = campaigns[0]!;
    expect(
      recipientsOf(db, c.id).every(
        (r) => r["status"] === "failed" && r["error"] === "opt_out_check_failed",
      ),
    ).toBe(true);
    expect(campaignRow(db, c.id)).toMatchObject({ failed_count: 5, sent_count: 0 });
  });
});

describe("pause, resume and cancel are honoured within seconds", () => {
  it("pause: sending stops at the next status read; claimed-but-unsent go back to queued; resume finishes the rest once", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 80 }] });
    const c = campaigns[0]!;
    let pausedAt = 0;
    const g = meta(async (_s, n) => {
      if (n === 10) {
        campaignRow(db, c.id)["status"] = "paused";
        pausedAt = Date.now();
      }
      return null;
    }, 10);
    await runCampaignDispatch(db.client, cfg({ concurrency: 2, statusPollMs: 50 }), {
      postMessage: g.postMessage,
    });
    const afterPause = g.sends.filter((s) => s.at > pausedAt + 50 + 60);
    expect(afterPause).toHaveLength(0);
    expect(g.sends.length).toBeLessThan(40);
    const rows = recipientsOf(db, c.id);
    expect(rows.some((r) => r["status"] === "sending")).toBe(false);
    expect(campaignRow(db, c.id)["status"]).toBe("paused");
    const firstRound = g.sends.length;

    campaignRow(db, c.id)["status"] = "sending";
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends.length).toBe(80);
    expect(new Set(g.sends.map((s) => s.tag)).size).toBe(80);
    expect(firstRound).toBeGreaterThan(0);
    expect(campaignRow(db, c.id)).toMatchObject({ status: "completed", sent_count: 80 });
  });

  it("cancel while a send is in flight: that one is recorded as sent (the truth), nothing else goes", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 30 }] });
    const c = campaigns[0]!;
    let cancelledAt = 0;
    const g = meta(async (_s, n) => {
      if (n === 1) {
        cancelledAt = Date.now();
        // What /api/campaigns/control does on cancel.
        for (const r of recipientsOf(db, c.id))
          if (["queued", "sending"].includes(String(r["status"]))) r["status"] = "skipped";
        campaignRow(db, c.id)["status"] = "cancelled";
      }
      return null;
    }, 5);
    await runCampaignDispatch(db.client, cfg({ concurrency: 1, statusPollMs: 40 }), {
      postMessage: g.postMessage,
    });
    // Seen at the next status read (40 ms here, 2 s by default), then nothing more.
    expect(g.sends.filter((x) => x.at > cancelledAt + 40 + 50)).toHaveLength(0);
    expect(g.sends.length).toBeLessThan(30);
    const sent = recipientsOf(db, c.id).filter((r) => r["status"] === "sent");
    expect(sent.map((r) => r["id"]).sort()).toEqual(
      g.sends.map((s) => recipientOfTag(s.tag)).sort(),
    );
    expect(campaignRow(db, c.id)["status"]).toBe("cancelled");
    expect(campaignRow(db, c.id)["sent_count"]).toBe(g.sends.length);
  });
});

describe("a run that died mid-send", () => {
  it("is settled after the timeout from what was recorded — never sent a second time", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 6 }] });
    const c = campaigns[0]!;
    const [r1, r2, r3, r4] = c.recipients;
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    // r1: Meta took it and the row was written, the run died before the recipient update.
    Object.assign(r1!, { status: "sending", updated_at: old });
    db.insert("messages", {
      organization_id: c.orgId,
      campaign_id: c.id,
      meta_message_id: "wamid.old1",
      status: "delivered",
      metadata: { campaign_recipient_id: r1!["id"] },
    });
    // r2: claimed, nothing recorded — we can't know, so it fails and is never retried.
    Object.assign(r2!, { status: "sending", updated_at: old });
    // r3: Meta refused it; the failed row is there.
    Object.assign(r3!, { status: "sending", updated_at: old });
    db.insert("messages", {
      organization_id: c.orgId,
      campaign_id: c.id,
      meta_message_id: null,
      status: "failed",
      metadata: { campaign_recipient_id: r3!["id"] },
    });
    // r4: claimed a moment ago by a run that's still alive: left alone.
    Object.assign(r4!, { status: "sending", updated_at: now() });

    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    const sentTo = new Set(g.sends.map((s) => recipientOfTag(s.tag)));
    for (const r of [r1, r2, r3, r4]) expect(sentTo.has(r!["id"] as string)).toBe(false);
    expect(g.sends).toHaveLength(2);
    expect(r1).toMatchObject({ status: "delivered", error: null });
    expect(r1!["message_id"]).toBeTruthy();
    expect(r2).toMatchObject({ status: "failed", error: STALE_SEND_ERROR });
    expect(r3).toMatchObject({ status: "failed" });
    expect(r4!["status"]).toBe("sending");
    // r4 is still out, so the campaign isn't complete yet.
    expect(campaignRow(db, c.id)).toMatchObject({
      status: "sending",
      sent_count: 3,
      failed_count: 2,
    });
  });

  it("decides nothing when the message lookup fails", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 1 }] });
    const r = campaigns[0]!.recipients[0]!;
    Object.assign(r, {
      status: "sending",
      updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    db.hook = (call) =>
      call.table === "messages" && call.kind === "select"
        ? { data: null, error: { message: "down" } }
        : undefined;
    await runCampaignDispatch(db.client, cfg(), { postMessage: meta().postMessage });
    expect(r["status"]).toBe("sending");
  });
});

describe("Meta's throughput errors", () => {
  it("130429 pauses the number and retries the same recipient; nobody gets two", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 12 }] });
    let refused = 0;
    const g = meta((s, n) => {
      if (n === 3) {
        refused += 1;
        return {
          kind: "response",
          ok: false,
          status: 400,
          body: { error: { code: 130429, message: "Rate limit hit" } },
        };
      }
      return null;
    });
    const report = await runCampaignDispatch(db.client, cfg({ concurrency: 1 }), {
      postMessage: g.postMessage,
    });
    expect(refused).toBe(1);
    expect(g.sends).toHaveLength(12);
    expect(new Set(g.sends.map((s) => s.tag)).size).toBe(12);
    expect(report.campaigns[0]).toMatchObject({ sent: 12, retried: 1, failed: 0 });
    // The number waited about a second after the refusal.
    const gaps = g.sends.slice(1).map((s, i) => s.at - g.sends[i]!.at);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(900);
    expect(db.rows("messages").filter((m) => m["status"] === "failed")).toHaveLength(0);
    expect(campaignRow(db, campaigns[0]!.id)).toMatchObject({
      sent_count: 12,
      failed_count: 0,
      status: "completed",
    });
  });

  it("131049 (marketing limit for that customer) is a normal failure: recorded, never retried, the rest go on", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 5 }] });
    const g = meta((_s, n) =>
      n === 2
        ? {
            kind: "response",
            ok: false,
            status: 400,
            body: {
              error: {
                code: 131049,
                message: "This message was not delivered to maintain healthy ecosystem engagement.",
              },
            },
          }
        : null,
    );
    await runCampaignDispatch(db.client, cfg({ concurrency: 1 }), { postMessage: g.postMessage });
    expect(g.tries()).toBe(5);
    expect(g.sends).toHaveLength(4);
    const failed = recipientsOf(db, campaigns[0]!.id).filter((r) => r["status"] === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!["error"]).toBe(
      "This message was not delivered to maintain healthy ecosystem engagement.",
    );
    const failedRow = db.rows("messages").find((m) => m["status"] === "failed")!;
    expect(JSON.parse(String(failedRow["error_detail"]))).toMatchObject({ code: 131049 });
    expect(
      db.rows("analytics_events").find((e) => e["event_type"] === "message.failed")!["properties"],
    ).toMatchObject({ error_code: "131049" });
    expect(campaignRow(db, campaigns[0]!.id)).toMatchObject({ sent_count: 4, failed_count: 1 });
  });

  it("no answer (timeout) is never retried: failed as unknown, so nobody can get it twice", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 3 }] });
    const g = meta((_s, n) => (n === 1 ? { kind: "no_response", reason: "TimeoutError" } : null));
    await runCampaignDispatch(db.client, cfg({ concurrency: 1 }), { postMessage: g.postMessage });
    expect(g.tries()).toBe(3);
    const failed = recipientsOf(db, campaigns[0]!.id).filter((r) => r["status"] === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!["error"]).toBe(UNKNOWN_SEND_ERROR);
  });

  it("a throttle that outlasts its tries is recorded as failed with Meta's message", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 1 }] });
    const g = meta(() => ({
      kind: "response",
      ok: false,
      status: 400,
      body: { error: { code: 131056, message: "Pair rate limit hit" } },
    }));
    // Short waits for the test: recipient throttles wait 5 s × attempt, so cap tries at 1.
    await runCampaignDispatch(db.client, cfg({ maxAttempts: 1 }), { postMessage: g.postMessage });
    expect(recipientsOf(db, campaigns[0]!.id)[0]).toMatchObject({
      status: "failed",
      error: "Pair rate limit hit",
    });
  });
});

describe("speed and fairness", () => {
  it("per number: never above its share (CAMPAIGN_NUMBER_MPS / lanes) in any second", async () => {
    const { db } = world({ campaigns: [{ recipients: 70 }] });
    const g = meta();
    await runCampaignDispatch(db.client, cfg({ numberMps: 50, budgetMs: 5_000 }), {
      postMessage: g.postMessage,
    });
    expect(g.sends).toHaveLength(70);
    const first = g.sends[0]!.at;
    for (let t = first; t < g.sends.at(-1)!.at; t += 100) {
      const inWindow = g.sends.filter((s) => s.at >= t && s.at < t + 1_000).length;
      expect(inWindow).toBeLessThanOrEqual(51);
    }
    expect(g.sends.at(-1)!.at - first).toBeGreaterThanOrEqual(1_000);
  });

  it("a big campaign never starves a small one: workspaces take turns", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 200 }, { recipients: 8 }] });
    const g = meta(undefined, 1);
    await runCampaignDispatch(db.client, cfg({ concurrency: 1 }), { postMessage: g.postMessage });
    const small = campaigns[1]!.pn;
    const positions = g.sends.map((s, i) => (s.pn === small ? i : -1)).filter((i) => i >= 0);
    expect(positions).toHaveLength(8);
    expect(Math.max(...positions)).toBeLessThan(25);
    expect(campaignRow(db, campaigns[1]!.id)["status"]).toBe("completed");
  });

  it("the time budget: no new send starts after it; whatever was claimed goes back to queued", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 100 }] });
    const g = meta(undefined, 40);
    const started = Date.now();
    await runCampaignDispatch(db.client, cfg({ budgetMs: 200, concurrency: 1 }), {
      postMessage: g.postMessage,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(g.sends.length).toBeGreaterThan(0);
    expect(g.sends.length).toBeLessThan(10);
    const rows = recipientsOf(db, campaigns[0]!.id);
    expect(rows.filter((r) => r["status"] === "sending")).toHaveLength(0);
    expect(rows.filter((r) => r["status"] === "queued")).toHaveLength(100 - g.sends.length);
    expect(campaignRow(db, campaigns[0]!.id)["status"]).toBe("sending");
  });
});

describe("lanes, the wallet hold and completion", () => {
  it("only lane 0 reserves credits and starts campaigns; other lanes join once the hold is in place", async () => {
    const { db, campaigns } = world({
      billing: true,
      campaigns: [{ recipients: 4, estimatedCost: 3.44 }],
    });
    const c = campaigns[0]!;
    const g = meta();
    await runCampaignDispatch(db.client, cfg({ lane: 1, lanes: 2 }), {
      postMessage: g.postMessage,
    });
    expect(g.sends).toHaveLength(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);

    await runCampaignDispatch(db.client, cfg({ lane: 0, lanes: 2 }), {
      postMessage: g.postMessage,
    });
    const holds = db.rows("wallet_ledger").filter((l) => l["entry_type"] === "hold");
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ amount: 3.44, reference_id: c.id });
    expect(g.sends).toHaveLength(4);
    // Completed: the unused reservation came back (nothing was priced yet).
    expect(campaignRow(db, c.id)).toMatchObject({
      status: "completed",
      held_amount: 0,
      returned_amount: 3.44,
    });
    // The hold was there before the first message left.
    expect(
      String(db.rows("wallet_ledger")[0]!["created_at"]) <=
        String(db.rows("messages")[0]!["created_at"]),
    ).toBe(true);
  });

  it("a scheduled campaign is started by lane 0 once due, never by another lane", async () => {
    const due = new Date(Date.now() - 1_000).toISOString();
    const { db, campaigns } = world({
      campaigns: [{ recipients: 2, status: "scheduled", scheduledAt: due }],
    });
    const c = campaigns[0]!;
    const g = meta();
    await runCampaignDispatch(db.client, cfg({ lane: 2, lanes: 4 }), {
      postMessage: g.postMessage,
    });
    expect(campaignRow(db, c.id)["status"]).toBe("scheduled");
    await runCampaignDispatch(db.client, cfg({ lane: 0, lanes: 4 }), {
      postMessage: g.postMessage,
    });
    expect(g.sends).toHaveLength(2);
    expect(campaignRow(db, c.id)).toMatchObject({ status: "completed" });
    expect(campaignRow(db, c.id)["started_at"]).toBeTruthy();
  });

  it("never completes a campaign whose list launch is still writing", async () => {
    const { db, campaigns } = world({ campaigns: [{ recipients: 20, total: 50 }] });
    const g = meta();
    await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends).toHaveLength(20);
    expect(campaignRow(db, campaigns[0]!.id)["status"]).toBe("sending");
  });

  it("insufficient credits pauses the campaign before anything is sent (unchanged)", async () => {
    const { db, campaigns } = world({
      billing: true,
      campaigns: [{ recipients: 3, estimatedCost: 9 }],
    });
    db.rpcs.set("wallet_apply", () => {
      throw new Error("INSUFFICIENT_CREDITS: balance");
    });
    const g = meta();
    const report = await runCampaignDispatch(db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends).toHaveLength(0);
    expect(campaignRow(db, campaigns[0]!.id)["status"]).toBe("paused");
    expect(report.campaigns).toContainEqual({
      campaign_id: campaigns[0]!.id,
      paused: "insufficient_credits",
    });
  });
});

// ------------------------------------------------------------- status webhook

describe("status webhook: cheap, monotonic, counted once", () => {
  // Each test gets fresh module state (the webhook remembers per isolate
  // whether campaign_recipient_status() exists).
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

  async function sentCampaign(
    spec: { recipientRpc?: boolean; ledgerRpc?: boolean; billing?: boolean } = {},
  ) {
    const w = world({ campaigns: [{ recipients: 3 }], ...spec });
    const g = meta();
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    const metaIdOf = (recipientId: string) =>
      w.db
        .rows("messages")
        .find((m) => (m["metadata"] as Row)["campaign_recipient_id"] === recipientId)![
        "meta_message_id"
      ] as string;
    return { ...w, sends: g.sends, metaIdOf };
  }

  async function deliver(db: MemoryDb, pn: string, statuses: Array<Record<string, unknown>>) {
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    const event = db.insert("webhook_events", {
      provider: "meta",
      processed_at: null,
      error: null,
    });
    await processWebhookPayload(db.client, event["id"] as string, statusPayload(pn, statuses));
    return event;
  }

  for (const recipientRpc of [true, false]) {
    const label = recipientRpc
      ? "with campaign_recipient_status()"
      : "before the migration (two conditional updates)";

    it(`delivered twice at once counts once; read after counts read; ${label}`, async () => {
      const { db, campaigns, metaIdOf } = await sentCampaign({ recipientRpc });
      const c = campaigns[0]!;
      const r = c.recipients[0]!;
      const id = metaIdOf(r["id"] as string);
      const st = (status: string) => ({
        id,
        status,
        timestamp: "1760000000",
        biz_opaque_callback_data: campaignCallbackData(c.id, r["id"] as string),
      });
      await Promise.all([
        deliver(db, c.pn, [st("delivered")]),
        deliver(db, c.pn, [st("delivered")]),
      ]);
      expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1, read_count: 0 });
      await deliver(db, c.pn, [st("read")]);
      await deliver(db, c.pn, [st("delivered")]); // late, out of order: never downgrades
      expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1, read_count: 1 });
      expect(r["status"]).toBe("read");
      expect(db.rows("messages").find((m) => m["meta_message_id"] === id)!["status"]).toBe("read");
      expect(
        db.rows("analytics_events").filter((e) => e["event_type"] === "message.read"),
      ).toHaveLength(1);
    });

    it(`read with no delivered first counts both; a failure after sent counts failed once; ${label}`, async () => {
      const { db, campaigns, metaIdOf } = await sentCampaign({ recipientRpc });
      const c = campaigns[0]!;
      const [r1, r2] = c.recipients;
      await deliver(db, c.pn, [
        { id: metaIdOf(r1!["id"] as string), status: "read", timestamp: "1760000000" },
      ]);
      expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 1, read_count: 1 });
      const failed = {
        id: metaIdOf(r2!["id"] as string),
        status: "failed",
        timestamp: "1760000000",
        errors: [{ code: 131026, title: "undeliverable" }],
      };
      await deliver(db, c.pn, [failed]);
      await deliver(db, c.pn, [failed]);
      expect(campaignRow(db, c.id)).toMatchObject({ failed_count: 1, sent_count: 3 });
      expect(r2).toMatchObject({ status: "failed" });
    });
  }

  it("a status that arrives before the sender wrote the row waits for it, then applies (biz_opaque_callback_data)", async () => {
    const { db, campaigns } = await sentCampaign({ recipientRpc: true });
    const c = campaigns[0]!;
    const r = c.recipients[1]!;
    const lateId = "wamid.late";
    const tag = campaignCallbackData(c.id, r["id"] as string);
    setTimeout(() => {
      db.insert("messages", {
        organization_id: c.orgId,
        campaign_id: c.id,
        meta_message_id: lateId,
        status: "pending",
        direction: "outbound",
        metadata: { campaign_recipient_id: r["id"] },
      });
    }, 300);
    const event = await deliver(db, c.pn, [
      { id: lateId, status: "delivered", timestamp: "1760000000", biz_opaque_callback_data: tag },
    ]);
    expect(db.rows("messages").find((m) => m["meta_message_id"] === lateId)!["status"]).toBe(
      "delivered",
    );
    expect(event["processed_at"]).toBeTruthy();
    expect(campaignRow(db, c.id)["delivered_count"]).toBe(1);
  }, 10_000);

  it("never written at all: the event is left for the retry pass instead of losing the status", async () => {
    const { db, campaigns } = await sentCampaign();
    const c = campaigns[0]!;
    const tag = campaignCallbackData(c.id, c.recipients[0]!["id"] as string);
    const event = await deliver(db, c.pn, [
      {
        id: "wamid.never",
        status: "delivered",
        timestamp: "1760000000",
        biz_opaque_callback_data: tag,
      },
    ]);
    expect(event["processed_at"]).toBeNull();
    expect(String(event["error"])).toMatch(/^retry:1 /);
  }, 10_000);

  it("a message that isn't a campaign's never touches recipients or counters, and an unknown one is ignored", async () => {
    const { db, campaigns } = await sentCampaign({ recipientRpc: true });
    const c = campaigns[0]!;
    db.insert("messages", {
      organization_id: c.orgId,
      meta_message_id: "wamid.reply",
      status: "sent",
      direction: "outbound",
      type: "text",
      created_at: now(),
    });
    const before = db.calls.length;
    const event = await deliver(db, c.pn, [
      { id: "wamid.reply", status: "delivered", timestamp: "1760000000" },
      { id: "wamid.unknown", status: "read", timestamp: "1760000000" },
    ]);
    const calls = db.calls.slice(before);
    expect(
      calls.some((x) => x.rpc === "campaign_recipient_status" || x.table === "campaign_recipients"),
    ).toBe(false);
    expect(campaignRow(db, c.id)).toMatchObject({ delivered_count: 0, read_count: 0 });
    expect(event["processed_at"]).toBeTruthy();
  });

  it("per status: one update of the message, one recipient call, the price, the event — no reads first", async () => {
    const { db, campaigns, metaIdOf } = await sentCampaign({ recipientRpc: true });
    const c = campaigns[0]!;
    const before = db.calls.length;
    await deliver(db, c.pn, [
      {
        id: metaIdOf(c.recipients[2]!["id"] as string),
        status: "delivered",
        timestamp: "1760000000",
        pricing: { billable: true, category: "marketing", pricing_model: "PMP" },
      },
    ]);
    const calls = db.calls.slice(before).map((x) => x.rpc ?? `${x.kind} ${x.table}`);
    expect(calls.filter((x) => x === "select messages")).toHaveLength(0);
    expect(calls.filter((x) => x === "update messages")).toHaveLength(1);
    expect(calls.filter((x) => x === "campaign_recipient_status")).toHaveLength(1);
    expect(calls).toContain("price_message");
    expect(calls.filter((x) => x === "select conversations")).toHaveLength(0);
  });

  it("the campaign's charged total is re-read at most every few seconds per campaign, not on every price", async () => {
    const { db, campaigns, metaIdOf } = await sentCampaign({ recipientRpc: true, ledgerRpc: true });
    const c = campaigns[0]!;
    for (const r of c.recipients) {
      await deliver(db, c.pn, [
        {
          id: metaIdOf(r["id"] as string),
          status: "delivered",
          timestamp: "1760000000",
          pricing: { billable: true, category: "marketing" },
        },
      ]);
    }
    expect(db.calls.filter((x) => x.rpc === "campaign_ledger_charge")).toHaveLength(1);
  });
});

describe("charged_amount: the whole ledger, not its first 1000 rows", () => {
  beforeEach(() => vi.resetModules());

  it("without campaign_ledger_charge() the debit rows are read page by page", async () => {
    const { syncCampaignCharged } = await import("./campaign-billing.server");
    const db = new MemoryDb();
    const org = crypto.randomUUID();
    const campaign = db.insert("campaigns", { organization_id: org, charged_amount: 0 });
    for (let i = 0; i < 2_500; i++) {
      db.insert("wallet_ledger", {
        id: `l-${String(i).padStart(5, "0")}`,
        organization_id: org,
        entry_type: "debit_message",
        amount: -0.86,
        metadata: { campaign_id: campaign["id"] },
      });
    }
    const result = await syncCampaignCharged(db.client, org, campaign["id"] as string);
    expect(result).toEqual({ ok: true, amount: 2150 });
    expect(campaign["charged_amount"]).toBe(2150);
    expect(db.calls.filter((x) => x.table === "wallet_ledger")).toHaveLength(3);
  });

  it("with it: one call, and raise-only as before", async () => {
    const { syncCampaignCharged } = await import("./campaign-billing.server");
    const db = new MemoryDb();
    db.rpcs.set("campaign_ledger_charge", () => 12.5);
    const org = crypto.randomUUID();
    const campaign = db.insert("campaigns", { organization_id: org, charged_amount: 20 });
    expect(await syncCampaignCharged(db.client, org, campaign["id"] as string)).toEqual({
      ok: true,
      amount: 12.5,
    });
    expect(campaign["charged_amount"]).toBe(20);
    expect(db.calls.some((x) => x.table === "wallet_ledger")).toBe(false);
  });
});

describe("the worker route", () => {
  it("refuses without the cron secret, and passes the lane from the body", async () => {
    vi.resetModules();
    const seen: unknown[] = [];
    vi.doMock("@/lib/whatsapp-webhook.server", () => ({
      getServiceClient: () => ({}),
      waitUntilOf: () => null,
    }));
    vi.doMock("@/lib/campaign-dispatch.server", async (orig) => ({
      ...(await orig<typeof import("./campaign-dispatch.server")>()),
      runCampaignDispatch: async (_s: unknown, c: DispatchConfig) => {
        seen.push(c);
        return {
          lane: c.lane,
          lanes: c.lanes,
          ms: 1,
          processed: 0,
          sent: 0,
          failed: 0,
          campaigns: [],
        };
      },
    }));
    const { Route } = await import("../routes/api/internal/campaign-worker");
    type Post = (a: { request: Request }) => Promise<Response>;
    const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server
      .handlers.POST;
    process.env["CRON_SECRET"] = "s";
    expect((await post({ request: new Request("http://x", { method: "POST" }) })).status).toBe(401);
    const res = await post({
      request: new Request("http://x", {
        method: "POST",
        headers: { "x-cron-secret": "s" },
        body: JSON.stringify({ lane: 2, lanes: 8 }),
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lane: 2, lanes: 8, processed: 0 });
    expect(seen[0]).toMatchObject({ lane: 2, lanes: 8 });
    // No body (today's cron): one lane.
    await post({
      request: new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s" } }),
    });
    expect(seen[1]).toMatchObject({ lane: 0, lanes: 1 });
    vi.doUnmock("@/lib/whatsapp-webhook.server");
    vi.doUnmock("@/lib/campaign-dispatch.server");
  });
});

describe("admin: sending now", () => {
  it("speed is the last minute's accepted messages; ETA = left ÷ speed", async () => {
    const { adminSendingNow, etaSeconds } = await import("./admin-sending.server");
    const { db, campaigns } = world({ campaigns: [{ recipients: 10 }] });
    const c = campaigns[0]!;
    for (const r of c.recipients.slice(0, 6)) r["status"] = "sent";
    for (let i = 0; i < 6; i++)
      db.insert("messages", {
        campaign_id: c.id,
        meta_message_id: `wamid.${i}`,
        created_at: new Date().toISOString(),
      });
    db.insert("messages", {
      campaign_id: c.id,
      meta_message_id: "wamid.old",
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const view = await adminSendingNow(db.client);
    expect(view.active).toHaveLength(1);
    expect(view.active[0]).toMatchObject({
      remaining: 4,
      rate_per_sec: 0.1,
      eta_seconds: 40,
      workspace: "Store 1",
    });
    expect(etaSeconds(100, 0)).toBeNull();
    expect(etaSeconds(100, 4)).toBe(25);
  });
});
