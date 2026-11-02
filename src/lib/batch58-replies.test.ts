import { describe, expect, it } from "vitest";
import { world } from "./test-support/campaign-world";
import { applyCampaignReply, replyCounts, REPLY_COUNTS_FOR_STATUSES } from "./whatsapp-webhook.server";

/**
 * Batch 58 item 5: a campaign reply counts only for a recipient whose
 * campaign message was delivered, and only for a customer message after that
 * message was sent, within the 7-day reply window measured from the send.
 * Every screen (app, MCP, analytics, API) reads the counter or replied_at
 * these writes keep together. In-memory database only.
 */

const MIN = 60_000;
const DAY = 86_400_000;

function setup(status: string, sentMsAgo: number | null) {
  const { db, campaigns } = world({ campaigns: [{ recipients: 1 }] });
  const c = campaigns[0]!;
  const r = c.recipients[0]!;
  r["status"] = status;
  r["replied_at"] = null;
  if (sentMsAgo !== null) {
    const sent = db.insert("messages", {
      organization_id: c.orgId,
      direction: "outbound",
      created_at: new Date(Date.now() - sentMsAgo).toISOString(),
    });
    r["message_id"] = sent["id"];
  }
  const campaign = () => db.rows("campaigns").find((x) => x["id"] === c.id)!;
  return { db, c, r, campaign };
}

describe("a reply counts only after a delivered campaign message", () => {
  it("the 'test' / 'demoo' case: recipient still at 'sent' (no delivered status) → no reply counted", async () => {
    const { db, c, r, campaign } = setup("sent", 10 * MIN);
    await applyCampaignReply(db.client, c.orgId, String(r["contact_id"]), new Date().toISOString());
    expect(campaign()["replied_count"] ?? 0).toBe(0);
    expect(r["replied_at"]).toBeNull();
  });

  it.each(["delivered", "read"])("%s, and the customer wrote after the send → one reply, stamped at their message's time", async (status) => {
    const { db, c, r, campaign } = setup(status, 10 * MIN);
    const at = new Date(Date.now() - MIN).toISOString();
    await applyCampaignReply(db.client, c.orgId, String(r["contact_id"]), at);
    expect(campaign()["replied_count"]).toBe(1);
    expect(r["replied_at"]).toBe(at);
    // The analytics count (recipients with replied_at) says the same.
    expect(db.rows("campaign_recipients").filter((x) => x["campaign_id"] === c.id && x["replied_at"]).length).toBe(1);
  });

  it("a customer message from before the send (queued, not yet sent) is not a reply to it", async () => {
    const { db, c, r, campaign } = setup("delivered", 5 * MIN);
    await applyCampaignReply(db.client, c.orgId, String(r["contact_id"]), new Date(Date.now() - 10 * MIN).toISOString());
    expect(campaign()["replied_count"] ?? 0).toBe(0);
  });

  it("past the 7-day window from the send → not counted; no campaign message row → not counted", async () => {
    const late = setup("delivered", 8 * DAY);
    // The recipient was queued 8 days ago as well.
    late.r["created_at"] = new Date(Date.now() - 8 * DAY).toISOString();
    await applyCampaignReply(late.db.client, late.c.orgId, String(late.r["contact_id"]), new Date().toISOString());
    expect(late.campaign()["replied_count"] ?? 0).toBe(0);

    const none = setup("delivered", null);
    await applyCampaignReply(none.db.client, none.c.orgId, String(none.r["contact_id"]), new Date().toISOString());
    expect(none.campaign()["replied_count"] ?? 0).toBe(0);
  });

  it("still once per recipient, however many messages", async () => {
    const { db, c, r, campaign } = setup("read", 30 * MIN);
    for (let i = 0; i < 3; i++) await applyCampaignReply(db.client, c.orgId, String(r["contact_id"]), new Date(Date.now() - (3 - i) * MIN).toISOString());
    expect(campaign()["replied_count"]).toBe(1);
  });

  it("the rule itself", () => {
    const sent = Date.parse("2026-08-16T10:00:00Z");
    expect(REPLY_COUNTS_FOR_STATUSES).toEqual(["delivered", "read"]);
    expect(replyCounts(sent, sent + MIN)).toBe(true);
    expect(replyCounts(sent, sent)).toBe(false);
    expect(replyCounts(sent, sent - MIN)).toBe(false);
    expect(replyCounts(sent, sent + 7 * DAY)).toBe(true);
    expect(replyCounts(sent, sent + 7 * DAY + 1)).toBe(false);
    expect(replyCounts(null, sent)).toBe(false);
  });
});
