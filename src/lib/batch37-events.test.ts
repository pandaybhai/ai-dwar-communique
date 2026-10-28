import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { fakeFetch, ORG, publicApiWorld } from "./test-support/public-api-world";
import { processWebhookPayload, resetBurstWindowCache } from "./whatsapp-webhook.server";
import {
  forgetApiEventsWanted,
  inboundMessagePayload,
  queueApiEvent,
  runApiWebhookDeliveries,
} from "./public-api-webhooks.server";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";

/**
 * Batch 37 item 3 — inbound events on the Batch 34 webhook queue:
 * message.received (words, a file as a short-lived authenticated link, a
 * button / list / quick-reply tap, a map pin), contact.created for a new
 * number, contact.opted_out / contact.opted_in — queued once, after the reply,
 * only for a workspace whose webhook is set, signed and retried like every
 * delivery. GET /api/v1/media/{message_id} gives a 5-minute link that works
 * only with the same key. Fakes only.
 */

const h = vi.hoisted(() => ({
  flagOn: true,
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/public-api.server", async (orig) => ({
  ...(await orig<typeof import("./public-api.server")>()),
  publicApiEnabled: async () => h.flagOn,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("./whatsapp-webhook.server")>()),
  getServiceClient: () => h.world!.db.supabase,
}));

import { Route as MediaRoute } from "../routes/api/v1/media/$messageId";
import { Route as DownloadRoute } from "../routes/api/v1/media/$messageId.download";

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const queued = (ops: FakeOp[]) =>
  ops
    .filter((o) => o.table === "api_webhook_deliveries" && o.kind === "upsert")
    .map((o) => o.payload as Record<string, unknown>);

/** A customer number whose workspace has its webhook set (or not). */
function inboundWorld(
  opts: {
    webhook?: boolean;
    newContact?: boolean;
    duplicate?: boolean;
    deliveriesError?: boolean;
  } = {},
) {
  const w = latencyWorld({
    org: ORG,
    rttMs: 0,
    graphMs: 0,
    waitingRun: false,
    duplicate: opts.duplicate ?? false,
    override: (op: FakeOp) => {
      if (op.table === "platform_settings")
        return {
          data: { onboarding_whatsapp_account_id: null, ai_burst_quiet_ms: 0, ai_burst_cap_ms: 0 },
          error: null,
        };
      if (op.table === "workspace_connections")
        return {
          data: opts.webhook === false ? null : { id: "wc-1", status: "active" },
          error: null,
        };
      if (op.table === "contacts" && op.kind === "upsert" && opts.newContact)
        return {
          data: { id: "c1", opt_in_status: "unknown", created_at: new Date().toISOString() },
          error: null,
        };
      if (op.table === "api_webhook_deliveries" && opts.deliveriesError)
        return {
          data: null,
          error: {
            code: "23514",
            message: "violates check constraint api_webhook_deliveries_event_check",
          },
        };
      if (op.table === "flow_triggers") return { data: [], error: null };
      return undefined;
    },
  });
  vi.stubGlobal("fetch", w.fetchStub);
  return w;
}

const eventUpdates = (ops: FakeOp[]) =>
  ops
    .filter((o) => o.table === "webhook_events" && o.kind === "update")
    .map((o) => o.payload as Record<string, unknown>);

describe("message.received / contact.created from the webhook pass", () => {
  beforeEach(() => {
    quiet();
    h.flagOn = true;
    forgetApiEventsWanted();
    resetBurstWindowCache();
  });

  it("a text from a new number: contact.created, then exactly one message.received", async () => {
    const w = inboundWorld({ newContact: true });
    await processWebhookPayload(
      w.supabase,
      "ev-1",
      inboundPayload({
        id: "wamid.in1",
        type: "text",
        text: { body: "Is the blue kurta in stock?" },
      }),
    );
    const rows = queued(w.ops);
    expect(rows.map((r) => r["event"])).toEqual(["contact.created", "message.received"]);
    expect(rows[0]).toMatchObject({
      organization_id: ORG,
      message_id: null,
      dedupe_key: "contact.created:c1",
    });
    expect(rows[0]!["payload"]).toMatchObject({
      event: "contact.created",
      contact: { phone: "+919800000001", name: "Asha" },
    });
    expect(rows[1]).toMatchObject({ organization_id: ORG, message_id: "m-in", state: "pending" });
    expect(rows[1]!["payload"]).toMatchObject({
      event: "message.received",
      message_id: "m-in",
      wamid: "wamid.in1",
      from: "+919800000001",
      contact: { phone: "+919800000001", name: "Asha" },
      type: "text",
      text: "Is the blue kurta in stock?",
      media: null,
      reply: null,
    });
  });

  it("Meta delivers the same message again: nothing new is queued (once per message)", async () => {
    const first = inboundWorld();
    await processWebhookPayload(
      first.supabase,
      "ev-2",
      inboundPayload({ id: "wamid.same", type: "text", text: { body: "hi" } }),
    );
    expect(queued(first.ops).filter((r) => r["event"] === "message.received")).toHaveLength(1);
    const again = inboundWorld({ duplicate: true });
    await processWebhookPayload(
      again.supabase,
      "ev-2b",
      inboundPayload({ id: "wamid.same", type: "text", text: { body: "hi" } }),
    );
    expect(queued(again.ops)).toEqual([]);
  });

  it("no webhook set (or public_api off): nothing queued", async () => {
    const off = inboundWorld({ webhook: false });
    await processWebhookPayload(
      off.supabase,
      "ev-3",
      inboundPayload({ id: "wamid.3", type: "text", text: { body: "hi" } }),
    );
    expect(queued(off.ops)).toEqual([]);
    forgetApiEventsWanted();
    h.flagOn = false;
    const flagOff = inboundWorld();
    await processWebhookPayload(
      flagOff.supabase,
      "ev-3b",
      inboundPayload({ id: "wamid.3b", type: "text", text: { body: "hi" } }),
    );
    expect(queued(flagOff.ops)).toEqual([]);
  });

  it("before 20261150 is applied (the CHECK refuses the new event): the message is handled and the event closed as always", async () => {
    const w = inboundWorld({ deliveriesError: true });
    await processWebhookPayload(
      w.supabase,
      "ev-4",
      inboundPayload({ id: "wamid.4", type: "text", text: { body: "hello" } }),
    );
    expect(queued(w.ops)).toHaveLength(1); // tried once, refused
    const closed = eventUpdates(w.ops).at(-1)!;
    expect(closed["processed_at"]).toBeTruthy();
    expect(closed["error"] ?? null).toBeNull();
  });

  it("STOP: contact.opted_out is queued (and START: contact.opted_in)", async () => {
    const w = inboundWorld();
    await processWebhookPayload(
      w.supabase,
      "ev-5",
      inboundPayload({ id: "wamid.5", type: "text", text: { body: "STOP" } }),
    );
    const stop = queued(w.ops).find((r) => r["event"] === "contact.opted_out")!;
    expect(stop).toMatchObject({ organization_id: ORG, message_id: null });
    expect(String(stop["dedupe_key"])).toMatch(/^contact\.opted_out:c1:\d+$/);
    expect(stop["payload"]).toMatchObject({
      event: "contact.opted_out",
      contact: { phone: "+919800000001" },
    });
  });
});

describe("message.received: what the customer sent", () => {
  const base = {
    messageId: "m-1",
    phone: "+919800000001",
    name: "Asha",
    occurredAt: "2026-10-28T10:00:00.000Z",
  };
  it("a picture: its words, and a link to GET /api/v1/media/{message_id}", () => {
    expect(
      inboundMessagePayload({
        ...base,
        msg: {
          id: "wamid.p",
          type: "image",
          image: { id: "meta-9", mime_type: "image/jpeg", caption: "this one" },
        },
      }),
    ).toMatchObject({
      type: "image",
      text: "this one",
      media: {
        url: "https://aidwar.in/api/v1/media/m-1",
        mime_type: "image/jpeg",
        caption: "this one",
      },
    });
  });
  it("a reply button, a list row, a template's quick reply, a map pin, a quoted message", () => {
    expect(
      inboundMessagePayload({
        ...base,
        msg: {
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "am", title: "Morning" } },
        },
      }),
    ).toMatchObject({
      type: "button_reply",
      reply: { id: "am", title: "Morning" },
      text: "Morning",
    });
    expect(
      inboundMessagePayload({
        ...base,
        msg: {
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "xl", title: "XL", description: "Chest 44" },
          },
        },
      }),
    ).toMatchObject({
      type: "list_reply",
      reply: { id: "xl", title: "XL", description: "Chest 44" },
    });
    expect(
      inboundMessagePayload({
        ...base,
        msg: { type: "button", button: { payload: "STOP_OFFERS", text: "Stop offers" } },
      }),
    ).toMatchObject({ type: "quick_reply", reply: { id: "STOP_OFFERS", title: "Stop offers" } });
    expect(
      inboundMessagePayload({
        ...base,
        msg: {
          type: "location",
          location: { latitude: 19.07, longitude: 72.87, name: "Home" },
          context: { id: "wamid.q" },
        },
      }),
    ).toMatchObject({
      type: "location",
      location: { latitude: 19.07, longitude: 72.87, name: "Home", address: null },
      context: { wamid: "wamid.q" },
    });
  });
});

// ------------------------------------------------------------ delivery + media

const SECRET = "whsec_test_secret";
function setWebhook() {
  const w = h.world!;
  w.db.rows("workspace_connections").push({
    id: "wc-1",
    organization_id: ORG,
    provider: "api_webhook",
    status: "active",
    public_config: { url: "https://hooks.example.com/aidwar" },
    secret_vault_name: "workspace_conn_wc-1",
  });
  w.vault.set("workspace_conn_wc-1", JSON.stringify({ signing_secret: SECRET }));
}

describe("delivered like every event: one row per event, signed", () => {
  beforeEach(() => {
    quiet();
    h.world = publicApiWorld();
    clearSafeFetchDnsCache();
  });

  it("the same event twice is one row; it is POSTed with X-AiDwar-Signature", async () => {
    setWebhook();
    const w = h.world!;
    w.db.rows("messages").push({ id: "m-in", organization_id: ORG });
    const payload = inboundMessagePayload({
      messageId: "m-in",
      msg: { id: "wamid.x", type: "text", text: { body: "hi" } },
      phone: "+919800000001",
      name: null,
      occurredAt: "2026-10-28T10:00:00.000Z",
    });
    for (let i = 0; i < 2; i += 1)
      expect(
        await queueApiEvent(w.db.supabase, {
          organizationId: ORG,
          event: "message.received",
          messageId: "m-in",
          occurredAt: "2026-10-28T10:00:00.000Z",
          payload,
        }),
      ).toBeNull();
    for (let i = 0; i < 2; i += 1)
      await queueApiEvent(w.db.supabase, {
        organizationId: ORG,
        event: "contact.created",
        dedupeKey: "contact.created:c1",
        occurredAt: "2026-10-28T10:00:00.000Z",
        payload: { event: "contact.created" },
      });
    expect(w.db.rows("api_webhook_deliveries").map((r) => r["event"])).toEqual([
      "message.received",
      "contact.created",
    ]);

    const net = fakeFetch([
      (c) => (c.url.startsWith("https://hooks.example.com") ? new Response("ok") : undefined),
    ]);
    vi.stubGlobal("fetch", net.impl);
    expect(await runApiWebhookDeliveries(w.db.supabase)).toMatchObject({
      claimed: 2,
      delivered: 2,
    });
    const call = net.calls.find((c) => c.headers["x-aidwar-event"] === "message.received")!;
    const ts = call.headers["x-aidwar-timestamp"]!;
    expect(call.headers["x-aidwar-signature"]).toBe(
      "sha256=" +
        createHmac("sha256", SECRET)
          .update(`${ts}.${String(call.body)}`)
          .digest("hex"),
    );
    expect(JSON.parse(String(call.body))).toEqual(payload);
  });
});

type Get = (a: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handler = (route: unknown) =>
  (route as { options: { server: { handlers: { GET: Get } } } }).options.server.handlers.GET;

describe("GET /api/v1/media/{message_id}: a 5-minute link for the same key", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  beforeEach(() => {
    quiet();
    h.world = publicApiWorld();
    const w = h.world;
    w.db.rows("messages").push(
      {
        id: "m-photo",
        organization_id: ORG,
        conversation_id: "cv-1",
        direction: "inbound",
        media_url: `storage:chat-media/${ORG}/cv-1/m-photo.jpg`,
        media_mime: "image/jpeg",
      },
      { id: "m-text", organization_id: ORG, direction: "inbound", media_url: null },
      {
        id: "m-other",
        organization_id: "org-b",
        conversation_id: "cv-b",
        media_url: "storage:chat-media/org-b/cv-b/m-other.jpg",
        media_mime: "image/jpeg",
      },
    );
    void w.storage; // the bucket is the world's fake storage
  });

  async function get(
    route: unknown,
    url: string,
    params: Record<string, string>,
    key = h.world!.keys.a,
  ) {
    const res = await handler(route)({
      request: new Request(url, { headers: { authorization: `Bearer ${key}` } }),
      params,
    });
    return res;
  }

  it("link → download streams our private copy; the link is bound to the key and expires", async () => {
    const w = h.world!;
    await w.db.supabase.storage
      .from("chat-media")
      .upload(`${ORG}/cv-1/m-photo.jpg`, JPEG, { contentType: "image/jpeg" });
    const res = await get(MediaRoute, "https://aidwar.in/api/v1/media/m-photo", {
      messageId: "m-photo",
    });
    expect(res.status).toBe(200);
    const link = (await res.json()) as Record<string, string>;
    expect(link).toMatchObject({
      message_id: "m-photo",
      mime_type: "image/jpeg",
      filename: "m-photo.jpg",
    });
    expect(link["url"]).toMatch(
      /^https:\/\/aidwar\.in\/api\/v1\/media\/m-photo\/download\?expires=\d+&signature=[0-9a-f]{64}$/,
    );
    expect(Date.parse(link["expires_at"]!) - Date.now()).toBeLessThanOrEqual(300_000);

    const download = await get(DownloadRoute, link["url"]!, { messageId: "m-photo" });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/jpeg");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(JPEG);

    // Another key of another workspace can't use it; nor can anyone without a key.
    const otherKey = await get(DownloadRoute, link["url"]!, { messageId: "m-photo" }, w.keys.b);
    expect(otherKey.status).toBe(403);
    const noKey = await handler(DownloadRoute)({
      request: new Request(link["url"]!),
      params: { messageId: "m-photo" },
    });
    expect(noKey.status).toBe(401);

    // Expired.
    const past = link["url"]!.replace(
      /expires=\d+/,
      `expires=${Math.floor(Date.now() / 1000) - 10}`,
    );
    expect((await get(DownloadRoute, past, { messageId: "m-photo" })).status).toBe(403); // signature no longer matches
  });

  it("another workspace's message, a message without a file, a made-up id: the same 404", async () => {
    for (const id of ["m-other", "m-text", "nope"]) {
      const res = await get(MediaRoute, `https://aidwar.in/api/v1/media/${id}`, { messageId: id });
      expect(res.status, id).toBe(404);
      expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("not_found");
    }
  });

  it("an expired link with a valid signature: 410", async () => {
    const { mediaDownload, mediaSignature } = await import("./public-api-media-links.server");
    const { hashApiKey } = await import("./public-api.server");
    const keyHash = hashApiKey(h.world!.keys.a);
    const expires = Math.floor(Date.now() / 1000) - 1;
    const sig = mediaSignature(keyHash, { organizationId: ORG, messageId: "m-photo", expires });
    const answer = await mediaDownload(
      h.world!.db.supabase,
      { keyId: "key-a", organizationId: ORG },
      keyHash,
      "m-photo",
      new URLSearchParams({ expires: String(expires), signature: sig }),
    );
    expect(answer instanceof Response ? answer.status : answer.status).toBe(410);
  });
});
