import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batch38World, ORG } from "./test-support/batch38-world";
import { forgetApiEventsWanted } from "./public-api-webhooks.server";
import { forgetWorkspacePlans } from "./public-api-plans.server";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import { WEBHOOK_EVENTS } from "./public-api-spec";
import { accountPayload, limitPayload, qualityPayload } from "./public-api-account-events.server";
import { campaignCompletedPayload } from "./public-api-campaigns.server";

/**
 * Batch 38 item 4 — phone_number.quality_changed, messaging_limit.changed and
 * account.status_changed, read from the notices the Meta webhook already
 * handles, after its own writes (which stay as they were): queued once per
 * notice, only for a workspace whose webhook hears events, and shaped exactly
 * as the docs say.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/batch38-world").batch38World>,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("./whatsapp-webhook.server")>()),
  getServiceClient: () => h.world!.db.supabase,
}));

const rows = (t: string) => h.world!.db.rows(t);
const queued = () => rows("api_webhook_deliveries");
const TIME = 1793000000;
const notice = (field: string, value: Record<string, unknown>, time = TIME) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba-a", time, changes: [{ field, value }] }],
});
const account = () => rows("whatsapp_accounts").find((a) => a["id"] === "acc-a")!;

beforeEach(() => {
  h.world = batch38World();
  forgetApiEventsWanted();
  forgetWorkspacePlans();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  account()["quality_rating"] = "GREEN";
  account()["messaging_tier"] = "TIER_1K";
  h.world.setLegacyWebhook(ORG, "https://hooks.example.com/aidwar", "whsec_x");
});
afterEach(() => vi.restoreAllMocks());

describe("from the Meta webhook", () => {
  it("a quality drop: the number's rating is stored as before, and phone_number.quality_changed is queued once", async () => {
    const payload = notice("phone_number_quality_update", {
      display_phone_number: "+91 90000 00000",
      event: "FLAGGED",
    });
    await processWebhookPayload(h.world!.db.supabase, "ev-q1", payload);
    await processWebhookPayload(h.world!.db.supabase, "ev-q1", payload);
    expect(account()["quality_rating"]).toBe("RED");
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      organization_id: ORG,
      event: "phone_number.quality_changed",
      message_id: null,
    });
    expect(queued()[0]!["payload"]).toEqual({
      event: "phone_number.quality_changed",
      phone_number: "+91 90000 00000",
      quality: { previous: "GREEN", current: "RED" },
      whatsapp_event: "FLAGGED",
      timestamp: new Date(TIME * 1000).toISOString(),
    });
  });

  it("a limit upgrade: messaging_limit.changed (the stored tier isn't touched)", async () => {
    await processWebhookPayload(
      h.world!.db.supabase,
      "ev-l1",
      notice("phone_number_quality_update", {
        display_phone_number: "+91 90000 00000",
        event: "UPGRADE",
        current_limit: "TIER_10K",
      }),
    );
    expect(queued().map((q) => q["event"])).toEqual(["messaging_limit.changed"]);
    expect(queued()[0]!["payload"]).toMatchObject({
      limit: { previous: "TIER_1K", current: "TIER_10K" },
      whatsapp_event: "UPGRADE",
    });
    expect(account()["messaging_tier"]).toBe("TIER_1K");
  });

  it("an account restriction and a review decision: account.status_changed", async () => {
    await processWebhookPayload(
      h.world!.db.supabase,
      "ev-a1",
      notice("account_update", {
        event: "ACCOUNT_VIOLATION",
        violation_info: { violation_type: "SCAM" },
        restriction_info: [
          { restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: 1767225600 },
        ],
      }),
    );
    await processWebhookPayload(
      h.world!.db.supabase,
      "ev-a2",
      notice("account_review_update", { decision: "APPROVED" }, TIME + 60),
    );
    expect(
      queued().map((q) => [q["event"], (q["payload"] as Record<string, unknown>)["status"]]),
    ).toEqual([
      ["account.status_changed", "restricted"],
      ["account.status_changed", "approved"],
    ]);
    expect(queued()[0]!["payload"]).toMatchObject({
      reason: "SCAM",
      restrictions: [{ type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expires_at: "1767225600" }],
    });
  });

  it("without a webhook nothing is queued, and the notice is handled exactly as before", async () => {
    h.world!.db.rows("api_webhook_endpoints").length = 0;
    h.world!.db.rows("workspace_connections").length = 0;
    forgetApiEventsWanted();
    await processWebhookPayload(
      h.world!.db.supabase,
      "ev-q2",
      notice("phone_number_quality_update", {
        display_phone_number: "+91 90000 00000",
        event: "FLAGGED",
      }),
    );
    expect(account()["quality_rating"]).toBe("RED");
    expect(rows("whatsapp_quality_history")).toHaveLength(1);
    expect(queued()).toHaveLength(0);
  });
});

/** Every key path of a JSON value, arrays by their first item. */
function shape(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.length ? shape(value[0], prefix) : [];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    `${prefix}${k}`,
    ...shape(v, `${prefix}${k}.`),
  ]);
}

describe("the docs' examples are the server's payloads", () => {
  it("every v1.2 event example has exactly the fields its builder writes", () => {
    const byName = new Map(WEBHOOK_EVENTS.map((e) => [e.name, e.example]));
    const real: Record<string, unknown> = {
      "phone_number.quality_changed": qualityPayload({
        phoneNumber: "+91",
        previous: "GREEN",
        current: "RED",
        whatsappEvent: "FLAGGED",
        occurredAt: "t",
      }),
      "messaging_limit.changed": limitPayload({
        phoneNumber: "+91",
        previous: "TIER_1K",
        current: "TIER_10K",
        whatsappEvent: "UPGRADE",
        occurredAt: "t",
      }),
      "account.status_changed": accountPayload({
        field: "account_update",
        value: {
          event: "ACCOUNT_VIOLATION",
          violation_info: { violation_type: "X" },
          restriction_info: [{ restriction_type: "R", expiration: 1 }],
        },
        occurredAt: "t",
      }),
      "campaign.completed": campaignCompletedPayload(
        { id: "c", name: "n", status: "completed", template_name: "t", completed_at: "t" },
        "t",
      ),
    };
    for (const [name, payload] of Object.entries(real))
      expect(shape(byName.get(name)).sort(), name).toEqual(shape(payload).sort());
  });
});
