import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batch38World, call, ORG, OTHER_ORG } from "./test-support/batch38-world";
import { fakeFetch, type FetchCall } from "./test-support/public-api-world";
import { forgetWorkspacePlans } from "./public-api-plans.server";
import { forgetApiEventsWanted, runApiWebhookDeliveries } from "./public-api-webhooks.server";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { ALL_WEBHOOK_EVENTS } from "./public-api";

/**
 * Batch 38 item 3 — up to 5 webhooks per workspace, each with its own secret
 * and event filter, managed from the API and from Settings. The existing
 * Settings webhook becomes entry #1 with the same address and the same
 * secret, and keeps getting every event; before 20261160 it works exactly as
 * before. Another workspace's webhook is a 404. Secrets are shown once.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/batch38-world").batch38World>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as ListRoute } from "../routes/api/v1/webhooks/index";
import { Route as OneRoute } from "../routes/api/v1/webhooks/$webhookId/index";
import { Route as TestRoute } from "../routes/api/v1/webhooks/$webhookId/test";
import { Route as EventsRoute } from "../routes/api/v1/webhooks/events";
import { Route as SettingsRoute } from "../routes/api/developer/webhook";

const rows = (t: string) => h.world!.db.rows(t);
const keyA = () => h.world!.keys.a;
const LEGACY_URL = "https://legacy.example.com/aidwar";
const LEGACY_SECRET = "whsec_legacy_original";

let net: ReturnType<typeof fakeFetch>;
/** Status each host answers (default 200). */
let answer: Record<string, number> = {};

beforeEach(() => {
  h.world = batch38World();
  forgetWorkspacePlans();
  forgetApiEventsWanted();
  clearSafeFetchDnsCache();
  answer = {};
  net = fakeFetch([
    (c) =>
      c.url.startsWith("https://") && !c.url.includes("graph.facebook.com")
        ? new Response("ok", { status: answer[new URL(c.url).host] ?? 200 })
        : undefined,
  ]);
  vi.stubGlobal("fetch", net.impl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const posts = () => net.calls.filter((c) => c.method === "POST");
const hostOf = (c: FetchCall) => new URL(c.url).host;
const signed = (c: FetchCall, secret: string) =>
  c.headers["x-aidwar-signature"] ===
  `sha256=${createHmac("sha256", secret)
    .update(`${c.headers["x-aidwar-timestamp"]}.${String(c.body)}`)
    .digest("hex")}`;

/** One API message's status, queued as the Meta webhook queues it. */
function queueStatus(event = "message.delivered", id = "d1") {
  rows("api_webhook_deliveries").push({
    id,
    organization_id: ORG,
    message_id: `m-${id}`,
    event,
    payload: { event, message_id: `m-${id}`, status: event.split(".")[1] },
    occurred_at: new Date().toISOString(),
    state: "pending",
    attempts: 0,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString(),
  });
}

const create = (body: unknown, key = keyA()) =>
  call(ListRoute, "POST", "/api/v1/webhooks", { key, body });

describe("the existing Settings webhook", () => {
  it("becomes entry #1 — same address, every event — and still delivers, signed with the SAME secret", async () => {
    h.world!.setLegacyWebhook(ORG, LEGACY_URL, LEGACY_SECRET);
    const list = await call(ListRoute, "GET", "/api/v1/webhooks", { key: keyA() });
    expect(list.status).toBe(200);
    expect(list.body["webhooks"]).toEqual([
      expect.objectContaining({
        url: LEGACY_URL,
        all_events: true,
        status: "active",
        events: [...ALL_WEBHOOK_EVENTS],
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(LEGACY_SECRET);
    // Its workspace_connections row is kept as it was.
    expect(rows("workspace_connections")).toHaveLength(1);

    queueStatus();
    const report = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(report.delivered).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe(LEGACY_URL);
    expect(signed(posts()[0]!, LEGACY_SECRET)).toBe(true);
    expect(rows("api_webhook_deliveries")[0]).toMatchObject({ state: "delivered" });
  });

  it("before 20261160 is applied it works exactly as before, and the API says it isn't available yet", async () => {
    h.world!.sql.applied = false;
    h.world!.setLegacyWebhook(ORG, LEGACY_URL, LEGACY_SECRET);
    queueStatus();
    const report = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(report.delivered).toBe(1);
    expect(signed(posts()[0]!, LEGACY_SECRET)).toBe(true);
    expect(rows("api_webhook_attempts")).toHaveLength(0);
    const list = await call(ListRoute, "GET", "/api/v1/webhooks", { key: keyA() });
    expect(list.status).toBe(503);
    expect(rows("api_webhook_endpoints")).toHaveLength(0);
  });

  it("removing it removes the Settings row too, so it is never copied back", async () => {
    h.world!.setLegacyWebhook(ORG, LEGACY_URL, LEGACY_SECRET);
    const id = (
      (await call(ListRoute, "GET", "/api/v1/webhooks", { key: keyA() })).body[
        "webhooks"
      ] as Array<{ webhook_id: string }>
    )[0]!.webhook_id;
    const del = await call(OneRoute, "DELETE", `/api/v1/webhooks/${id}`, {
      key: keyA(),
      params: { webhookId: id },
    });
    expect(del.status).toBe(200);
    expect(rows("workspace_connections")).toHaveLength(0);
    const after = await call(ListRoute, "GET", "/api/v1/webhooks", { key: keyA() });
    expect(after.body["webhooks"]).toEqual([]);
  });
});

describe("managing webhooks", () => {
  it("up to 5: each made with its own secret (shown once, never listed); a sixth is refused", async () => {
    const secrets = new Set<string>();
    for (let i = 1; i <= 5; i += 1) {
      const res = await create({
        url: `https://h${i}.example.com/hook`,
        events: ["message.delivered"],
      });
      expect(res.status).toBe(201);
      expect(String(res.body["secret"])).toMatch(/^whsec_/);
      secrets.add(String(res.body["secret"]));
    }
    expect(secrets.size).toBe(5);
    const sixth = await create({ url: "https://h6.example.com/hook" });
    expect(sixth.status).toBe(409);
    expect(sixth.body["code"]).toBe("webhook_limit_reached");
    const list = await call(ListRoute, "GET", "/api/v1/webhooks", { key: keyA() });
    expect((list.body["webhooks"] as unknown[]).length).toBe(5);
    for (const s of secrets) expect(JSON.stringify(list.body)).not.toContain(s);
  });

  it("refuses an address that isn't public https and an unknown event", async () => {
    expect((await create({ url: "http://x.example.com" })).body["code"]).toBe("invalid_url");
    expect(
      (await create({ url: "https://x.example.com", events: ["message.exploded"] })).body["code"],
    ).toBe("invalid_events");
    expect(rows("api_webhook_endpoints")).toHaveLength(0);
  });

  it("each webhook hears only its events, signed with its own secret; one failing is retried alone", async () => {
    const a = await create({ url: "https://a.example.com/hook", events: ["message.delivered"] });
    const b = await create({
      url: "https://b.example.com/hook",
      events: ["message.delivered", "message.read"],
    });
    await create({ url: "https://c.example.com/hook", events: ["message.read"] });
    answer["b.example.com"] = 500;
    queueStatus("message.delivered", "d1");
    const first = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(first).toMatchObject({ retrying: 1, delivered: 0 });
    expect(posts().map(hostOf).sort()).toEqual(["a.example.com", "b.example.com"]);
    const toA = posts().find((c) => hostOf(c) === "a.example.com")!;
    expect(signed(toA, String(a.body["secret"]))).toBe(true);
    expect(signed(toA, String(b.body["secret"]))).toBe(false);

    // Next try (after the backoff): only b again; now it answers.
    answer["b.example.com"] = 200;
    const due = rows("api_webhook_deliveries")[0]!;
    due["next_attempt_at"] = new Date(Date.now() - 1000).toISOString();
    for (const at of rows("api_webhook_attempts"))
      at["next_attempt_at"] = new Date(Date.now() - 1000).toISOString();
    due["lease_until"] = null;
    net.calls.length = 0;
    const second = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(second.delivered).toBe(1);
    expect(posts().map(hostOf)).toEqual(["b.example.com"]);
    expect(rows("api_webhook_deliveries")[0]).toMatchObject({ state: "delivered" });
    expect(
      rows("api_webhook_attempts")
        .map((x) => [x["state"], x["attempts"]])
        .sort(),
    ).toEqual([
      ["delivered", 1],
      ["delivered", 2],
    ]);
  });

  it("PATCH: events, pause, rotate (the new secret signs; the old doesn't)", async () => {
    const made = await create({ url: "https://a.example.com/hook" });
    const id = String((made.body["webhook"] as Record<string, unknown>)["webhook_id"]);
    const patch = (body: unknown) =>
      call(OneRoute, "PATCH", `/api/v1/webhooks/${id}`, {
        key: keyA(),
        body,
        params: { webhookId: id },
      });
    const rotated = await patch({ rotate_secret: true });
    expect(rotated.status).toBe(200);
    const fresh = String(rotated.body["secret"]);
    expect(fresh).not.toBe(String(made.body["secret"]));
    queueStatus();
    await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(signed(posts()[0]!, fresh)).toBe(true);
    expect(signed(posts()[0]!, String(made.body["secret"]))).toBe(false);

    const paused = await patch({ status: "disabled" });
    expect((paused.body["webhook"] as Record<string, unknown>)["status"]).toBe("disabled");
    net.calls.length = 0;
    queueStatus("message.read", "d2");
    const report = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(report.skipped).toBe(1);
    expect(posts()).toHaveLength(0);

    const narrowed = await patch({ events: ["message.read"], status: "active" });
    expect(narrowed.body["webhook"]).toMatchObject({
      events: ["message.read"],
      all_events: false,
      status: "active",
    });
    expect((await patch({ status: "maybe" })).body["code"]).toBe("invalid_status");
  });

  it("test: webhook.test to that webhook only, with what it answered", async () => {
    const a = await create({ url: "https://a.example.com/hook" });
    await create({ url: "https://b.example.com/hook" });
    const id = String((a.body["webhook"] as Record<string, unknown>)["webhook_id"]);
    answer["a.example.com"] = 418;
    const res = await call(TestRoute, "POST", `/api/v1/webhooks/${id}/test`, {
      key: keyA(),
      params: { webhookId: id },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ webhook_id: id, delivered: false, response_status: 418 });
    expect(posts().map(hostOf)).toEqual(["a.example.com"]);
    expect(posts()[0]!.headers["x-aidwar-event"]).toBe("webhook.test");
    expect(signed(posts()[0]!, String(a.body["secret"]))).toBe(true);
  });

  it("another workspace's webhook is a 404 for every operation, and stays as it was", async () => {
    const theirs = await create({ url: "https://b-only.example.com/hook" }, h.world!.keys.b);
    expect(theirs.status).toBe(201);
    const id = String((theirs.body["webhook"] as Record<string, unknown>)["webhook_id"]);
    const p = { key: keyA(), params: { webhookId: id } };
    expect((await call(OneRoute, "GET", `/api/v1/webhooks/${id}`, p)).status).toBe(404);
    expect(
      (
        await call(OneRoute, "PATCH", `/api/v1/webhooks/${id}`, {
          ...p,
          body: { status: "disabled" },
        })
      ).status,
    ).toBe(404);
    expect((await call(TestRoute, "POST", `/api/v1/webhooks/${id}/test`, p)).status).toBe(404);
    expect((await call(OneRoute, "DELETE", `/api/v1/webhooks/${id}`, p)).status).toBe(404);
    expect(rows("api_webhook_endpoints").find((e) => e["id"] === id)).toMatchObject({
      organization_id: OTHER_ORG,
      status: "active",
    });
    expect(
      (await call(ListRoute, "GET", "/api/v1/webhooks", { key: keyA() })).body["webhooks"],
    ).toEqual([]);
  });

  it("GET /api/v1/webhooks/events: the catalogue, with plans", async () => {
    const res = await call(EventsRoute, "GET", "/api/v1/webhooks/events", { key: keyA() });
    expect(res.status).toBe(200);
    const events = res.body["events"] as Array<Record<string, unknown>>;
    expect(events.map((e) => e["name"])).toEqual([...ALL_WEBHOOK_EVENTS]);
    expect(events[0]).toMatchObject({ plans: ["Scale", "Enterprise"], since: "v1.0" });
  });
});

describe("Settings", () => {
  const settings = async (action: "create" | "save", body: Record<string, unknown>) => {
    const handler = (
      SettingsRoute as unknown as {
        options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } };
      }
    ).options.server.handlers.POST;
    const res = await handler({
      request: new Request("https://aidwar.in/api/developer/webhook", {
        method: "POST",
        headers: { authorization: "Bearer u-admin", "content-type": "application/json" },
        body: JSON.stringify({ organization_id: ORG, action, ...body }),
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("adds, changes and removes webhooks through the same operations as the API", async () => {
    h.world!.setLegacyWebhook(ORG, LEGACY_URL, LEGACY_SECRET);
    const added = await settings("create", {
      url: "https://second.example.com/hook",
      events: ["message.failed"],
    });
    expect(added.status).toBe(200);
    expect(String(added.body["secret"])).toMatch(/^whsec_/);
    expect(rows("api_webhook_endpoints")).toHaveLength(2);
    // Batch 34's "save" with no id still means the first webhook (the old one).
    const saved = await settings("save", { url: "https://legacy2.example.com/aidwar" });
    expect(saved.status).toBe(200);
    expect(rows("api_webhook_endpoints").find((e) => e["legacy_connection_id"])!["url"]).toBe(
      "https://legacy2.example.com/aidwar",
    );
    expect(rows("activity_log").some((a) => a["action"] === "api_webhook_saved")).toBe(true);
  });
});
