import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batch38World, call, ORG, OTHER_ORG } from "./test-support/batch38-world";
import { forgetWorkspacePlans } from "./public-api-plans.server";

/**
 * Batch 38 item 1 — campaigns from the Public API. A campaign is created by
 * the app's own launchCampaign (no second launch): the row and its
 * recipient list are what the Launch button writes, and nothing reaches Meta
 * until the campaign worker takes the wallet hold. Audiences are the
 * workspace's own opted-in contacts only; another workspace's campaign is a
 * 404; a finished campaign can't be cancelled; campaign.completed is queued
 * for the merchant's webhook once.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/batch38-world").batch38World>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as CampaignsRoute } from "../routes/api/v1/campaigns/index";
import { Route as EstimateRoute } from "../routes/api/v1/campaigns/estimate";
import { Route as OneRoute } from "../routes/api/v1/campaigns/$campaignId";
import { Route as CancelRoute } from "../routes/api/v1/campaigns/$campaignId.cancel";
import { Route as AppLaunchRoute } from "../routes/api/campaigns/launch";
import { Route as AppAudienceRoute } from "../routes/api/campaigns/audience";
import { Route as AppEstimateRoute } from "../routes/api/campaigns/estimate";
import { queueCampaignCompleted } from "./public-api-campaigns.server";
import { forgetApiEventsWanted } from "./public-api-webhooks.server";

const rows = (t: string) => h.world!.db.rows(t);
const keyA = () => h.world!.keys.a;
const keyB = () => h.world!.keys.b;

const create = (body: unknown, key = keyA(), headers: Record<string, string> = {}) =>
  call(CampaignsRoute, "POST", "/api/v1/campaigns", { key, body, headers });

const offer = (over: Record<string, unknown> = {}) => ({
  name: "Diwali",
  template_name: "festive_offer",
  audience: {
    phones: [
      { phone: "+91 98000 00001", variables: ["Asha", "20%"] },
      { phone: "919800000002", variables: { "1": "Ravi", "2": "15%" } },
      "+919800000003", // not opted in
      "+919800000009", // opted out
      "+919811111111", // not a contact
      "+919800000001", // listed twice
    ],
  },
  ...over,
});

const metaCalls: string[] = [];
beforeEach(() => {
  h.world = batch38World();
  forgetWorkspacePlans();
  forgetApiEventsWanted();
  metaCalls.length = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    metaCalls.push(String(input instanceof Request ? input.url : input));
    return new Response("no", { status: 599 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/v1/campaigns", () => {
  it("launches through the app's launch: one campaign, its opted-in recipients with their own values, nothing sent yet", async () => {
    const res = await create(offer());
    expect(res.status).toBe(201);
    const campaign = res.body["campaign"] as Record<string, unknown>;
    expect(campaign).toMatchObject({
      name: "Diwali",
      status: "sending",
      template_name: "festive_offer",
      language: "en",
      counts: { recipients: 2, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0 },
    });
    expect(res.body["skipped"]).toEqual([
      { phone: "+919800000001", reason: "duplicate" },
      { phone: "+919800000003", reason: "not_opted_in" },
      { phone: "+919800000009", reason: "opted_out" },
      { phone: "+919811111111", reason: "not_a_contact" },
    ]);

    const [row] = rows("campaigns");
    expect(row).toMatchObject({
      organization_id: ORG,
      created_by: null,
      whatsapp_account_id: "acc-a",
      total_recipients: 2,
      estimated_cost: 0.3, // 2 × 0.15: the hold the worker takes before the first message
    });
    expect(
      rows("campaign_recipients").map((r) => [
        r["contact_id"],
        r["phone"],
        r["resolved_variables"],
      ]),
    ).toEqual([
      ["c1", "+919800000001", { "1": "Asha", "2": "20%" }],
      ["c2", "+919800000002", { "1": "Ravi", "2": "15%" }],
    ]);
    expect(rows("campaign_recipients").every((r) => r["organization_id"] === ORG)).toBe(true);
    // Nothing reached Meta: the campaign worker sends, after its wallet hold.
    expect(metaCalls.filter((u) => u.includes("graph.facebook.com"))).toEqual([]);
    expect(
      rows("activity_log").find((a) => a["action"] === "campaign_launched")?.["details"],
    ).toMatchObject({
      source: "api",
      api_key_id: "key-a",
      recipient_count: 2,
    });
  });

  it("a tag audience: only the tag's opted-in contacts in this workspace, campaign-wide values from the contact", async () => {
    const res = await create({
      name: "VIPs",
      template_name: "festive_offer",
      audience: { tag: "vip" },
      variables: { "1": { source: "name" }, "2": "10%" },
    });
    expect(res.status).toBe(201);
    expect(
      rows("campaign_recipients").map((r) => [r["contact_id"], r["resolved_variables"]]),
    ).toEqual([["c1", { "1": "Asha", "2": "10%" }]]);
  });

  it("a value nobody gives is refused, and nothing is created", async () => {
    const res = await create(
      offer({ audience: { phones: ["+919800000001"] }, variables: ["10%"].slice(1) }),
    );
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("missing_variables");
    expect(rows("campaigns")).toHaveLength(0);
  });

  it("templates a campaign can't fill, unknown tags and segments, and a workspace without credits are refused before anything is created", async () => {
    expect((await create(offer({ template_name: "shop_link" }))).body["code"]).toBe(
      "template_unsupported",
    );
    expect((await create(offer({ template_name: "b_invoice" }))).body["code"]).toBe(
      "template_not_found",
    );
    expect((await create(offer({ audience: { tag: "nobody" } }))).status).toBe(404);
    expect((await create(offer({ audience: { segment_id: "seg-of-b" } }))).body["code"]).toBe(
      "segment_not_found",
    );
    expect((await create(offer({ audience: { tag: "vip", phones: ["+1"] } }))).body["code"]).toBe(
      "invalid_audience",
    );
    rows("wallet_balances")[0]!["balance"] = 0;
    const broke = await create(offer());
    expect(broke.status).toBe(402);
    expect(broke.body["code"]).toBe("insufficient_credits");
    expect(rows("campaigns")).toHaveLength(0);
    expect(rows("campaign_recipients")).toHaveLength(0);
  });

  it("the same idempotency_key gives the first answer again, never a second campaign", async () => {
    const first = await create(offer(), keyA(), { "idempotency-key": "diwali-1" });
    const again = await create(offer(), keyA(), { "idempotency-key": "diwali-1" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(rows("campaigns")).toHaveLength(1);
    const other = await create(offer({ name: "Other" }), keyA(), { "idempotency-key": "diwali-1" });
    expect(other.body["code"]).toBe("idempotency_key_reused");
  });

  it("schedule_at in the future makes a scheduled campaign", async () => {
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const res = await create(offer({ schedule_at: at }));
    expect((res.body["campaign"] as Record<string, unknown>)["status"]).toBe("scheduled");
    expect(rows("campaigns")[0]!["started_at"]).toBeNull();
  });

  it("the app's Launch button still launches exactly as before (the shared launch)", async () => {
    const res = await (
      AppLaunchRoute as unknown as {
        options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } };
      }
    ).options.server.handlers.POST({
      request: new Request("https://aidwar.in/api/campaigns/launch", {
        method: "POST",
        headers: { authorization: "Bearer u-admin", "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: ORG,
          name: "From the app",
          template_name: "festive_offer",
          variable_mappings: { "1": { source: "name" }, "2": { source: "static", value: "5%" } },
        }),
      }),
    });
    // u-admin has no campaigns.send in this world: refused exactly as before, nothing created.
    expect(res.status).toBe(403);
    expect(rows("campaigns")).toHaveLength(0);
    rows("role_permissions").push({ role: "admin", permission_key: "campaigns.send" });
    rows("permissions").push({ key: "campaigns.send" });
    const ok = await (
      AppLaunchRoute as unknown as {
        options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } };
      }
    ).options.server.handlers.POST({
      request: new Request("https://aidwar.in/api/campaigns/launch", {
        method: "POST",
        headers: { authorization: "Bearer u-admin", "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: ORG,
          name: "From the app",
          template_name: "festive_offer",
          variable_mappings: { "1": { source: "name" }, "2": { source: "static", value: "5%" } },
        }),
      }),
    });
    const body = (await ok.json()) as Record<string, unknown>;
    expect(ok.status).toBe(200);
    expect(body).toMatchObject({ status: "sending", total_recipients: 2, needs_approval: false });
    expect(Object.keys(body).sort()).toEqual(
      ["campaign_id", "estimated_cost", "needs_approval", "status", "total_recipients"].sort(),
    );
    expect(rows("campaigns")[0]).toMatchObject({ created_by: "u-admin", name: "From the app" });
  });
});

describe("POST /api/v1/campaigns/estimate", () => {
  it("recipients and cost, and nothing is created", async () => {
    const res = await call(EstimateRoute, "POST", "/api/v1/campaigns/estimate", {
      key: keyA(),
      body: offer({ name: undefined }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      recipients: 2,
      category: "marketing",
      cost: { currency: "INR", rate: 0.15, estimate: 0.3, available: 100, can_send: true },
    });
    expect((res.body["skipped"] as unknown[]).length).toBe(4);
    expect(rows("campaigns")).toHaveLength(0);
  });

  /** The campaign wizard's own two calls: the audience count, then the estimate for it. */
  async function wizardEstimate() {
    rows("permissions").push({ key: "campaigns.send" }, { key: "contacts.view" });
    rows("role_permissions").push(
      { role: "admin", permission_key: "campaigns.send" },
      { role: "admin", permission_key: "contacts.view" },
    );
    const app = async (route: unknown, body: Record<string, unknown>) => {
      const res = await (
        route as {
          options: {
            server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
          };
        }
      ).options.server.handlers.POST({
        request: new Request("https://aidwar.in/api/campaigns/x", {
          method: "POST",
          headers: { authorization: "Bearer u-admin", "content-type": "application/json" },
          body: JSON.stringify({ organization_id: ORG, ...body }),
        }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const audience = await app(AppAudienceRoute, {
      segment_id: null,
      whatsapp_account_id: "acc-a",
    });
    // The wizard sends the template's category, lower-cased.
    const template = rows("message_templates").find((t) => t["name"] === "festive_offer")!;
    return app(AppEstimateRoute, {
      recipients: audience["eligible"],
      category: String(template["category"]).toLowerCase(),
      whatsapp_account_id: "acc-a",
    });
  }

  it("equals the campaign wizard's estimate for the same audience — and the hold a launch stores", async () => {
    // A threshold and a short wallet, so needs_approval and can_send are compared too.
    rows("organization_billing_settings")[0]!["campaign_approval_threshold"] = 0.2;
    for (const balance of [100, 0.25]) {
      rows("wallet_balances")[0]!["balance"] = balance;
      const wizard = await wizardEstimate();
      const api = await call(EstimateRoute, "POST", "/api/v1/campaigns/estimate", {
        key: keyA(),
        body: { template_name: "festive_offer", audience: { all: true }, variables: ["x", "y"] },
      });
      expect(api.status).toBe(200);
      expect(api.body["recipients"]).toBe(wizard["recipients"]);
      expect(api.body["category"]).toBe(wizard["category"]);
      expect(api.body["cost"]).toEqual({
        currency: wizard["currency"],
        rate: wizard["rate"],
        estimate: wizard["estimate"],
        available: wizard["available"],
        can_send: wizard["can_send"],
        needs_approval: wizard["needs_approval"],
      });
      expect(wizard).toMatchObject({ recipients: 2, estimate: 0.3, needs_approval: true });
      expect(wizard["can_send"]).toBe(balance === 100);
    }
    // A launch from the API stores the same figure as the campaign's estimate (what the worker holds).
    rows("wallet_balances")[0]!["balance"] = 100;
    rows("organization_billing_settings")[0]!["campaign_approval_threshold"] = null;
    const launched = await create({
      name: "Same audience",
      template_name: "festive_offer",
      audience: { all: true },
      variables: ["x", "y"],
    });
    expect(launched.status).toBe(201);
    expect(rows("campaigns")[0]!["estimated_cost"]).toBe((await wizardEstimate())["estimate"]);
  });
});

describe("reading and cancelling", () => {
  const seedCampaign = (over: Record<string, unknown>) =>
    rows("campaigns").push({
      organization_id: ORG,
      name: "x",
      status: "sending",
      template_name: "festive_offer",
      template_language: "en",
      total_recipients: 10,
      sent_count: 9,
      delivered_count: 7,
      read_count: 4,
      failed_count: 1,
      replied_count: 2,
      ...over,
    });

  it("GET one: its counts; another workspace's campaign is a 404 like one that doesn't exist", async () => {
    seedCampaign({ id: "camp-a", created_at: "2026-10-02T00:00:00Z" });
    seedCampaign({ id: "camp-b", organization_id: OTHER_ORG, created_at: "2026-10-02T00:00:00Z" });
    const res = await call(OneRoute, "GET", "/api/v1/campaigns/camp-a", {
      key: keyA(),
      params: { campaignId: "camp-a" },
    });
    expect(res.status).toBe(200);
    expect((res.body["campaign"] as Record<string, unknown>)["counts"]).toEqual({
      recipients: 10,
      sent: 9,
      delivered: 7,
      read: 4,
      failed: 1,
      replied: 2,
    });
    const theirs = await call(OneRoute, "GET", "/api/v1/campaigns/camp-b", {
      key: keyA(),
      params: { campaignId: "camp-b" },
    });
    const missing = await call(OneRoute, "GET", "/api/v1/campaigns/nope", {
      key: keyA(),
      params: { campaignId: "nope" },
    });
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    // And B's key never sees A's.
    expect(
      (
        await call(OneRoute, "GET", "/api/v1/campaigns/camp-a", {
          key: keyB(),
          params: { campaignId: "camp-a" },
        })
      ).status,
    ).toBe(404);
  });

  it("GET list: newest first, a status filter, a cursor that walks every page, only this workspace", async () => {
    for (let i = 1; i <= 5; i += 1)
      seedCampaign({
        id: `camp-${i}`,
        created_at: `2026-10-0${i}T00:00:00Z`,
        status: i === 3 ? "completed" : "sending",
      });
    seedCampaign({
      id: "camp-other",
      organization_id: OTHER_ORG,
      created_at: "2026-10-09T00:00:00Z",
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res: Awaited<ReturnType<typeof call>> = await call(
        CampaignsRoute,
        "GET",
        `/api/v1/campaigns?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        { key: keyA() },
      );
      expect(res.status).toBe(200);
      ids.push(
        ...(res.body["campaigns"] as Array<{ campaign_id: string }>).map((c) => c.campaign_id),
      );
      cursor = res.body["next_cursor"] as string | null;
      if (!cursor) break;
    }
    expect(ids).toEqual(["camp-5", "camp-4", "camp-3", "camp-2", "camp-1"]);
    const done = await call(CampaignsRoute, "GET", "/api/v1/campaigns?status=completed", {
      key: keyA(),
    });
    expect(
      (done.body["campaigns"] as Array<{ campaign_id: string }>).map((c) => c.campaign_id),
    ).toEqual(["camp-3"]);
    expect(
      (await call(CampaignsRoute, "GET", "/api/v1/campaigns?cursor=bad", { key: keyA() })).body[
        "code"
      ],
    ).toBe("invalid_cursor");
  });

  it("cancel: a sending campaign is cancelled and its queued recipients skipped; after it finished, refused", async () => {
    seedCampaign({ id: "camp-live", created_at: "2026-10-02T00:00:00Z" });
    seedCampaign({ id: "camp-done", status: "completed", created_at: "2026-10-01T00:00:00Z" });
    rows("campaign_recipients").push(
      { id: "r1", campaign_id: "camp-live", organization_id: ORG, status: "queued" },
      { id: "r2", campaign_id: "camp-live", organization_id: ORG, status: "sent" },
    );
    const res = await call(CancelRoute, "POST", "/api/v1/campaigns/camp-live/cancel", {
      key: keyA(),
      params: { campaignId: "camp-live" },
    });
    expect(res.status).toBe(200);
    expect((res.body["campaign"] as Record<string, unknown>)["status"]).toBe("cancelled");
    expect(rows("campaign_recipients").map((r) => r["status"])).toEqual(["skipped", "sent"]);

    const late = await call(CancelRoute, "POST", "/api/v1/campaigns/camp-done/cancel", {
      key: keyA(),
      params: { campaignId: "camp-done" },
    });
    expect(late.status).toBe(409);
    expect(late.body["code"]).toBe("campaign_finished");
    expect(rows("campaigns").find((c) => c["id"] === "camp-done")!["status"]).toBe("completed");
  });

  it("cancel: another workspace's campaign is a 404 and stays as it was", async () => {
    seedCampaign({ id: "camp-b", organization_id: OTHER_ORG, created_at: "2026-10-02T00:00:00Z" });
    const res = await call(CancelRoute, "POST", "/api/v1/campaigns/camp-b/cancel", {
      key: keyA(),
      params: { campaignId: "camp-b" },
    });
    expect(res.status).toBe(404);
    expect(rows("campaigns")[0]!["status"]).toBe("sending");
  });
});

describe("campaign.completed", () => {
  const setWebhook = () =>
    rows("workspace_connections").push({
      id: "wc-a",
      organization_id: ORG,
      provider: "api_webhook",
      status: "active",
      public_config: { url: "https://hooks.example.com/aidwar" },
    });

  it("is queued once for a workspace whose webhook is set, with the campaign's counts", async () => {
    setWebhook();
    rows("campaigns").push({
      id: "camp-a",
      organization_id: ORG,
      name: "Diwali",
      status: "completed",
      template_name: "festive_offer",
      total_recipients: 2,
      sent_count: 2,
      delivered_count: 2,
      read_count: 1,
      failed_count: 0,
      completed_at: "2026-10-20T10:00:00.000Z",
    });
    await queueCampaignCompleted(h.world!.db.supabase, {
      organizationId: ORG,
      campaignId: "camp-a",
    });
    await queueCampaignCompleted(h.world!.db.supabase, {
      organizationId: ORG,
      campaignId: "camp-a",
    });
    const queued = rows("api_webhook_deliveries");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      organization_id: ORG,
      event: "campaign.completed",
      message_id: null,
      state: "pending",
      dedupe_key: "campaign.completed:camp-a",
      payload: {
        event: "campaign.completed",
        campaign_id: "camp-a",
        status: "completed",
        counts: { recipients: 2, sent: 2, delivered: 2, read: 1, failed: 0, replied: 0 },
        completed_at: "2026-10-20T10:00:00.000Z",
      },
    });
  });

  it("nothing is queued without a webhook, with public_api off, or for another workspace's campaign", async () => {
    rows("campaigns").push({ id: "camp-a", organization_id: ORG, status: "completed" });
    await queueCampaignCompleted(h.world!.db.supabase, {
      organizationId: ORG,
      campaignId: "camp-a",
    });
    expect(rows("api_webhook_deliveries")).toHaveLength(0);
    setWebhook();
    forgetApiEventsWanted();
    h.world!.flags.on = false;
    await queueCampaignCompleted(h.world!.db.supabase, {
      organizationId: ORG,
      campaignId: "camp-a",
    });
    expect(rows("api_webhook_deliveries")).toHaveLength(0);
    h.world!.flags.on = true;
    forgetApiEventsWanted();
    await queueCampaignCompleted(h.world!.db.supabase, {
      organizationId: OTHER_ORG,
      campaignId: "camp-a",
    });
    expect(rows("api_webhook_deliveries")).toHaveLength(0);
  });
});
