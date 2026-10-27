import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { latencyWorld } from "./test-support/latency-world";
import { fakeFetch, ORG, publicApiWorld, type FetchRoute } from "./test-support/public-api-world";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import {
  BACKOFF_MS,
  DELIVERY_GIVE_UP_MS,
  backoffAfter,
  enqueueApiWebhookEvent,
  runApiWebhookDeliveries,
  signWebhook,
} from "./public-api-webhooks.server";
import { apiMessageStatus } from "./public-api-messages.server";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";

/**
 * Batch 34 item 4 — the merchant's webhook. The existing status handling
 * queues message.sent / delivered / read / failed for an API message (once
 * per message and event; nothing else re-reads Meta's payload); the minute
 * tick delivers it signed (sha256=HMAC(secret, timestamp + "." + body)),
 * retries a 500 with backoff for up to 24 h, never follows a redirect or
 * calls a private address; Settings sets the address, shows the secret once
 * and sends a test event. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("./whatsapp-webhook.server")>()),
  getServiceClient: () => h.world!.db.supabase,
}));

import { Route as WebhookRoute } from "../routes/api/developer/webhook";

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------ the hook

const statusPayload = (status: string, extra: Record<string, unknown> = {}) => ({
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn" },
            statuses: [{ id: "wamid.api", status, timestamp: "1793000000", ...extra }],
          },
        },
      ],
    },
  ],
});
const API_META = {
  source: "api",
  api_key_id: "key-a",
  idempotency_key: "inv-1001",
  to: "+919876543210",
};
const rowOf = (status: string, metadata: Record<string, unknown> | null) => ({
  id: "m-api",
  status,
  type: "template",
  template_name: "invoice_ready",
  conversation_id: "cv1",
  campaign_id: null,
  flow_id: null,
  created_at: new Date().toISOString(),
  metadata,
  conversations: { contact_id: "c1", whatsapp_account_id: "acc" },
});
const queued = (ops: FakeOp[]) =>
  ops
    .filter((o) => o.table === "api_webhook_deliveries")
    .map((o) => o.payload as Record<string, unknown>);
const lastEventUpdate = (ops: FakeOp[]) =>
  ops
    .filter((o) => o.table === "webhook_events" && o.kind === "update")
    .map((o) => o.payload as Record<string, unknown>)
    .at(-1)!;

describe("the status webhook queues the merchant's event (no second parse of Meta's payload)", () => {
  beforeEach(quiet);

  it("delivered for an API message: one queued event with the body the merchant gets", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "update"
          ? { data: [rowOf("delivered", API_META)], error: null }
          : undefined,
    });
    await processWebhookPayload(w.supabase, "ev-d", statusPayload("delivered"));
    expect(queued(w.ops)).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        message_id: "m-api",
        event: "message.delivered",
        occurred_at: new Date(1793000000 * 1000).toISOString(),
        state: "pending",
        payload: {
          event: "message.delivered",
          message_id: "m-api",
          idempotency_key: "inv-1001",
          to: "+919876543210",
          status: "delivered",
          error: null,
          timestamp: new Date(1793000000 * 1000).toISOString(),
        },
      }),
    ]);
    expect(w.ops.find((o) => o.table === "api_webhook_deliveries")!.kind).toBe("upsert");
    expect(lastEventUpdate(w.ops)["error"]).toBeNull();
  });

  it("failed: message.failed with Meta's reason", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "update"
          ? { data: [rowOf("failed", API_META)], error: null }
          : undefined,
    });
    await processWebhookPayload(
      w.supabase,
      "ev-f",
      statusPayload("failed", { errors: [{ code: 131026, title: "Message undeliverable" }] }),
    );
    expect(queued(w.ops)[0]).toMatchObject({
      event: "message.failed",
      payload: { status: "failed", error: { code: "131026", message: "Message undeliverable" } },
    });
  });

  it("an inbox, flow or campaign message: nothing queued, nothing extra read", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "update"
          ? { data: [rowOf("read", { template_params: { "1": "x" } })], error: null }
          : undefined,
    });
    await processWebhookPayload(w.supabase, "ev-n", statusPayload("read"));
    expect(queued(w.ops)).toEqual([]);
  });

  it("a status the message already has (a repeat, or read before delivered): queued again — the (message, event) pair is unique, so once", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) => {
        if (op.table === "messages" && op.kind === "update") return { data: [], error: null };
        if (op.table === "messages" && op.kind === "select")
          return {
            data: {
              id: "m-api",
              status: "read",
              cost_amount: 1,
              campaign_id: null,
              flow_id: null,
              created_at: new Date().toISOString(),
              metadata: API_META,
            },
            error: null,
          };
        return undefined;
      },
    });
    await processWebhookPayload(w.supabase, "ev-r", statusPayload("delivered"));
    expect(queued(w.ops).map((q) => q["event"])).toEqual(["message.delivered"]);
    expect(lastEventUpdate(w.ops)["processed_at"]).toBeTruthy();
  });

  it("queueing failed: the event stays retryable (its retry queues it)", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) => {
        if (op.table === "messages" && op.kind === "update")
          return { data: [rowOf("sent", API_META)], error: null };
        if (op.table === "api_webhook_deliveries")
          return { data: null, error: { message: "relation does not exist" } };
        return undefined;
      },
    });
    await processWebhookPayload(w.supabase, "ev-x", statusPayload("sent"));
    expect(lastEventUpdate(w.ops)["processed_at"]).toBeNull();
    expect(String(lastEventUpdate(w.ops)["error"])).toMatch(/api webhook: relation does not exist/);
  });
});

// ------------------------------------------------------------ delivery

const HOOK = "https://hooks.example.com/aidwar";
const SECRET = "whsec_test_secret";
let net: ReturnType<typeof fakeFetch>;
let answers: number[] = [];
let dns: Record<string, string[]> = {};
let extra: FetchRoute[] = [];

function install() {
  net = fakeFetch(
    [
      (c) => extra.map((r) => r(c)).find(Boolean),
      (c) => (c.url === HOOK ? new Response("ok", { status: answers.shift() ?? 200 }) : undefined),
    ],
    dns,
  );
  vi.stubGlobal("fetch", net.impl);
}

function setWebhook(url = HOOK) {
  const w = h.world!;
  w.db
    .rows("workspace_connections")
    .push({
      id: "wc-1",
      organization_id: ORG,
      provider: "api_webhook",
      status: "active",
      public_config: { url },
      secret_vault_name: "workspace_conn_wc-1",
    });
  w.vault.set("workspace_conn_wc-1", JSON.stringify({ signing_secret: SECRET }));
}

async function queueOne(
  event: "message.sent" | "message.delivered" = "message.delivered",
  createdAgoMs = 0,
) {
  const w = h.world!;
  w.db
    .rows("messages")
    .push({
      id: "m-api",
      organization_id: ORG,
      status: "delivered",
      metadata: API_META,
      created_at: new Date().toISOString(),
    });
  expect(
    await enqueueApiWebhookEvent(w.db.supabase, {
      organizationId: ORG,
      messageId: "m-api",
      event,
      occurredAt: "2026-10-27T10:00:00.000Z",
      metadata: API_META,
    }),
  ).toBeNull();
  const row = w.db.rows("api_webhook_deliveries").at(-1)!;
  row["created_at"] = new Date(Date.now() - createdAgoMs).toISOString();
  row["attempts"] = 0;
  return row;
}
const hookCalls = () => net.calls.filter((c) => c.url.startsWith("https://hooks.example.com"));

describe("delivery: signed, retried, given up, never to a private address", () => {
  beforeEach(() => {
    quiet();
    h.world = publicApiWorld();
    answers = [];
    dns = {};
    extra = [];
    clearSafeFetchDnsCache();
    install();
  });

  it("signed correctly: X-AiDwar-Signature = sha256=HMAC(secret, timestamp + '.' + body), with the timestamp header", async () => {
    setWebhook();
    const row = await queueOne();
    const report = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(report).toMatchObject({ claimed: 1, delivered: 1 });
    const call = hookCalls()[0]!;
    expect(call.method).toBe("POST");
    const body = String(call.body);
    const ts = call.headers["x-aidwar-timestamp"]!;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    expect(call.headers["x-aidwar-signature"]).toBe(expected);
    expect(signWebhook(SECRET, ts, body)).toBe(expected);
    expect(call.headers["x-aidwar-event"]).toBe("message.delivered");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(body)).toEqual({
      event: "message.delivered",
      message_id: "m-api",
      idempotency_key: "inv-1001",
      to: "+919876543210",
      status: "delivered",
      error: null,
      timestamp: "2026-10-27T10:00:00.000Z",
    });
    expect(row).toMatchObject({
      state: "delivered",
      attempts: 1,
      last_status: 200,
      lease_until: null,
    });
    // The secret is in no header and no body.
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("retried on 500 with backoff, delivered on the next try", async () => {
    setWebhook();
    const row = await queueOne();
    answers = [500, 200];
    const first = await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(first).toMatchObject({ claimed: 1, retrying: 1 });
    expect(row).toMatchObject({
      state: "pending",
      attempts: 1,
      last_status: 500,
      last_error: "http_500",
      lease_until: null,
    });
    const wait = Date.parse(String(row["next_attempt_at"])) - Date.now();
    expect(wait).toBeGreaterThan(BACKOFF_MS[0]! - 5_000);
    expect(wait).toBeLessThanOrEqual(BACKOFF_MS[0]!);
    // Not due yet: nothing is sent.
    expect((await runApiWebhookDeliveries(h.world!.db.supabase)).claimed).toBe(0);
    row["next_attempt_at"] = new Date(Date.now() - 1000).toISOString();
    expect(await runApiWebhookDeliveries(h.world!.db.supabase)).toMatchObject({ delivered: 1 });
    expect(row).toMatchObject({ state: "delivered", attempts: 2, last_status: 200 });
    expect(hookCalls()).toHaveLength(2);
  });

  it("the backoff grows and stops at its last step; after 24 h a failure is final", async () => {
    expect([1, 2, 3, 8, 50].map(backoffAfter)).toEqual([
      BACKOFF_MS[0],
      BACKOFF_MS[1],
      BACKOFF_MS[2],
      BACKOFF_MS[7],
      BACKOFF_MS[7],
    ]);
    setWebhook();
    const row = await queueOne("message.delivered", DELIVERY_GIVE_UP_MS + 60_000);
    answers = [503];
    expect(await runApiWebhookDeliveries(h.world!.db.supabase)).toMatchObject({ failed: 1 });
    expect(row).toMatchObject({ state: "failed", last_status: 503 });
  });

  it("a retry is never scheduled past 24 h after the event", async () => {
    setWebhook();
    const row = await queueOne("message.delivered", DELIVERY_GIVE_UP_MS - 30_000);
    row["attempts"] = 7;
    answers = [500];
    await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(Date.parse(String(row["next_attempt_at"]))).toBeLessThanOrEqual(
      Date.parse(String(row["created_at"])) + DELIVERY_GIVE_UP_MS,
    );
  });

  it("SSRF: an address that resolves privately is never called; a redirect is never followed", async () => {
    dns = { "inside.example.com": ["10.0.0.9"] };
    install();
    setWebhook("https://inside.example.com/hook");
    const row = await queueOne();
    await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(row).toMatchObject({
      state: "pending",
      last_error: "private_address_blocked",
      last_status: null,
    });
    expect(net.calls.some((c) => c.url.includes("inside.example.com"))).toBe(false);

    h.world = publicApiWorld();
    extra = [
      (c) =>
        c.url === HOOK
          ? new Response(null, { status: 307, headers: { location: "https://169.254.169.254/" } })
          : undefined,
    ];
    setWebhook();
    const second = await queueOne();
    await runApiWebhookDeliveries(h.world!.db.supabase);
    expect(second).toMatchObject({
      state: "pending",
      last_error: "redirect_not_followed",
      last_status: 307,
    });
    expect(net.calls.some((c) => c.url.includes("169.254"))).toBe(false);
  });

  it("no webhook set: the event is skipped, nothing sent", async () => {
    const row = await queueOne();
    expect(await runApiWebhookDeliveries(h.world!.db.supabase)).toMatchObject({ skipped: 1 });
    expect(row).toMatchObject({ state: "skipped", last_error: "no_webhook_set" });
    expect(hookCalls()).toEqual([]);
  });

  it("past the tick's deadline: claimed rows are handed back, not sent", async () => {
    setWebhook();
    const row = await queueOne();
    expect(
      await runApiWebhookDeliveries(h.world!.db.supabase, { deadlineAt: Date.now() - 1 }),
    ).toMatchObject({ claimed: 1, released: 1 });
    expect(row).toMatchObject({ state: "pending", lease_until: null, attempts: 0 });
    expect(hookCalls()).toEqual([]);
  });

  it("the status endpoint's times come from the queued events", async () => {
    await queueOne("message.sent");
    await enqueueApiWebhookEvent(h.world!.db.supabase, {
      organizationId: ORG,
      messageId: "m-api",
      event: "message.delivered",
      occurredAt: "2026-10-27T10:00:09.000Z",
      metadata: API_META,
    });
    const answer = await apiMessageStatus(
      h.world!.db.supabase,
      { keyId: "key-a", organizationId: ORG },
      "m-api",
    );
    expect(answer.body).toMatchObject({
      sent_at: "2026-10-27T10:00:00.000Z",
      delivered_at: "2026-10-27T10:00:09.000Z",
      read_at: null,
      failed_at: null,
    });
  });
});

// ------------------------------------------------------------ settings

type Handler = (a: { request: Request }) => Promise<Response>;
const handlers = (
  WebhookRoute as unknown as { options: { server: { handlers: { GET: Handler; POST: Handler } } } }
).options.server.handlers;
const post = async (body: Record<string, unknown>, token = "u-admin") => {
  const res = await handlers.POST({
    request: new Request("https://aidwar.in/api/developer/webhook", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: ORG, ...body }),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const get = async (token = "u-admin") => {
  const res = await handlers.GET({
    request: new Request(`https://aidwar.in/api/developer/webhook?organization_id=${ORG}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("Settings: address, secret shown once, rotate, test event", () => {
  beforeEach(() => {
    quiet();
    h.world = publicApiWorld();
    answers = [];
    dns = {};
    extra = [];
    clearSafeFetchDnsCache();
    install();
  });

  it("saving a new address makes a secret, shown in that answer only; it lives in Vault, never in the table or GET", async () => {
    const saved = await post({ action: "save", url: HOOK });
    expect(saved.status).toBe(200);
    const secret = String(saved.body["secret"]);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(h.world!.db.rows("workspace_connections"))).not.toContain(secret);
    expect([...h.world!.vault.values()].join()).toContain(secret);
    const read = await get();
    expect(read.body["url"]).toBe(HOOK);
    expect(JSON.stringify(read.body)).not.toContain(secret);

    // Changing the address keeps the secret (and doesn't show it again).
    const moved = await post({ action: "save", url: "https://hooks.example.com/v2" });
    expect(moved.body["secret"]).toBeUndefined();
    expect([...h.world!.vault.values()].join()).toContain(secret);

    const rotated = await post({ action: "rotate" });
    expect(rotated.body["secret"]).toMatch(/^whsec_/);
    expect(rotated.body["secret"]).not.toBe(secret);
    expect([...h.world!.vault.values()].join()).not.toContain(secret);
  });

  it("an http, private or unknown address is refused", async () => {
    dns = { "inside.example.com": ["192.168.1.4"] };
    install();
    for (const url of [
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://inside.example.com/x",
      "https://user:pw@hooks.example.com/x",
      "nope",
    ]) {
      expect((await post({ action: "save", url })).status, url).toBe(400);
    }
    expect(h.world!.db.rows("workspace_connections")).toEqual([]);
  });

  it("Send test event: delivered now, signed with the secret, and shown as the last delivery", async () => {
    const { body } = await post({ action: "save", url: HOOK });
    const test = await post({ action: "test" });
    expect(test.body["result"]).toEqual({ ok: true, status: 200, error: null });
    const call = hookCalls().at(-1)!;
    expect(JSON.parse(String(call.body))).toMatchObject({
      event: "webhook.test",
      status: "test",
      message_id: null,
    });
    expect(call.headers["x-aidwar-signature"]).toBe(
      signWebhook(String(body["secret"]), call.headers["x-aidwar-timestamp"]!, String(call.body)),
    );
    const read = await get();
    expect(read.body["last_delivery"]).toMatchObject({
      event: "webhook.test",
      state: "delivered",
      last_status: 200,
    });

    answers = [500];
    const failing = await post({ action: "test" });
    expect(failing.body["result"]).toEqual({ ok: false, status: 500, error: "http_500" });
    expect((await get()).body["last_delivery"]).toMatchObject({
      state: "failed",
      last_status: 500,
    });
  });

  it("needs public_api.manage; remove always works, the rest needs the flag", async () => {
    expect((await post({ action: "save", url: HOOK }, "u-agent")).status).toBe(403);
    expect((await get("u-agent")).status).toBe(403);
    await post({ action: "save", url: HOOK });
    h.world!.flags.on = false;
    expect((await post({ action: "test" })).status).toBe(403);
    expect((await post({ action: "remove" })).status).toBe(200);
    expect(h.world!.db.rows("workspace_connections")).toEqual([]);
    expect(h.world!.vault.size).toBe(0);
  });
});
