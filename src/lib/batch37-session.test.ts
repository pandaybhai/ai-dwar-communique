import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeFetch,
  metaRoutes,
  ORG,
  OTHER_ORG,
  publicApiWorld,
  type FetchCall,
} from "./test-support/public-api-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { meterForMessageCategory } from "./events";

/**
 * Batch 37 item 2 — POST /api/v1/messages/session: a free-form message inside
 * the customer's 24-hour window, through the shared session senders, from the
 * number the customer last wrote to; outside it 409 window_closed. Charged as
 * an inbox reply (no credit check, the service meter). Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/messages/session";

type Post = (a: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: { POST: Post } } } }).options
  .server.handlers.POST;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const OGG = new Uint8Array([...Buffer.from("OggS"), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
const CUSTOMER = "+919876543210";

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };

async function send(body: unknown, key = h.world!.keys.a) {
  const res = await POST({
    request: new Request("https://aidwar.in/api/v1/messages/session", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const sends = () => net.calls.filter((c) => c.url.endsWith("/messages"));
const sendBody = (c: FetchCall) => JSON.parse(String(c.body)) as Record<string, unknown>;

/** The customer wrote `hoursAgo` hours ago on the second number (acc-a2). */
function customerWrote(hoursAgo: number) {
  const w = h.world!;
  w.db.rows("contacts").push({
    id: "c-1",
    organization_id: ORG,
    phone: CUSTOMER,
    wa_id: "919876543210",
    opt_in_status: "unknown",
  });
  w.db.rows("conversations").push({
    id: "conv-1",
    organization_id: ORG,
    contact_id: "c-1",
    whatsapp_account_id: "acc-a2",
    status: "open",
    last_customer_message_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  });
}

beforeEach(() => {
  h.world = publicApiWorld();
  h.world.db.rows("whatsapp_accounts").push({
    id: "acc-a2",
    organization_id: ORG,
    waba_id: "waba-a",
    phone_number_id: "pn-a2",
    display_phone_number: "+91 90000 00002",
    status: "active",
    is_default: false,
    connected_at: "2026-02-01T00:00:00Z",
  });
  meta.sendError = null;
  meta.uploadError = false;
  clearSafeFetchDnsCache();
  net = fakeFetch([metaRoutes(meta)]);
  vi.stubGlobal("fetch", net.impl);
});
afterEach(() => vi.unstubAllGlobals());

describe("inside the 24-hour window", () => {
  it("text (WhatsApp formatting as written) leaves from the number the customer wrote to, recorded and metered as an inbox reply", async () => {
    customerWrote(2);
    const res = await send({
      to: CUSTOMER,
      type: "text",
      text: "Hi *Asha*, your order _ships_ today",
      preview_url: true,
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "queued",
      wamid: "wamid.1",
      message_id: expect.any(String),
    });
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.url).toBe("https://graph.facebook.com/v25.0/pn-a2/messages");
    expect(sendBody(sends()[0]!)).toEqual({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "text",
      text: { body: "Hi *Asha*, your order _ships_ today", preview_url: true },
    });
    const row = h.world!.db.rows("messages").find((m) => m["id"] === res.body["message_id"])!;
    expect(row).toMatchObject({
      organization_id: ORG,
      conversation_id: "conv-1",
      direction: "outbound",
      type: "text",
      status: "pending",
    });
    expect(row["metadata"]).toMatchObject({ source: "api", api_key_id: "key-a", to: CUSTOMER });
    expect(row["sent_by"]).toBeUndefined();
    const usage = h
      .world!.db.rows("usage_records")
      .filter((u) => u["meter_key"] === meterForMessageCategory("service"));
    expect(usage).toHaveLength(1);
    expect(
      h.world!.db.rows("analytics_events").some((e) => e["event_type"] === "message.sent"),
    ).toBe(true);
  });

  it("reply buttons (at most 3) and a list with sections", async () => {
    customerWrote(1);
    const buttons = await send({
      to: CUSTOMER,
      type: "buttons",
      body: "When should we deliver?",
      buttons: [
        { id: "am", title: "Morning" },
        { id: "pm", title: "Evening" },
      ],
    });
    expect(buttons.status).toBe(202);
    expect(sendBody(sends()[0]!)["interactive"]).toEqual({
      type: "button",
      body: { text: "When should we deliver?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "am", title: "Morning" } },
          { type: "reply", reply: { id: "pm", title: "Evening" } },
        ],
      },
    });

    const list = await send({
      to: CUSTOMER,
      type: "list",
      body: "Pick a size",
      button: "Sizes",
      sections: [
        { title: "Small", rows: [{ id: "s", title: "S", description: "Chest 36" }] },
        {
          title: "Large",
          rows: [
            { id: "l", title: "L" },
            { id: "xl", title: "XL" },
          ],
        },
      ],
    });
    expect(list.status).toBe(202);
    expect(sendBody(sends()[1]!)["interactive"]).toEqual({
      type: "list",
      body: { text: "Pick a size" },
      action: {
        button: "Sizes",
        sections: [
          { title: "Small", rows: [{ id: "s", title: "S", description: "Chest 36" }] },
          {
            title: "Large",
            rows: [
              { id: "l", title: "L" },
              { id: "xl", title: "XL" },
            ],
          },
        ],
      },
    });
    for (const m of h.world!.db.rows("messages"))
      expect(m["metadata"]).toMatchObject({ source: "api" });
  });

  it("a picture and a voice note: uploaded to Meta, sent by id, our copy kept for the inbox", async () => {
    customerWrote(1);
    const image = await send({
      to: CUSTOMER,
      type: "image",
      image: { base64: Buffer.from(JPEG).toString("base64"), caption: "Your *receipt*" },
    });
    expect(image.status).toBe(202);
    expect(sendBody(sends()[0]!)).toMatchObject({
      type: "image",
      image: { id: "meta-media-1", caption: "Your *receipt*" },
    });
    const row = h.world!.db.rows("messages")[0]!;
    expect(row).toMatchObject({ type: "image", media_mime: "image/jpeg" });
    expect(String(row["media_url"])).toBe(`storage:chat-media/${ORG}/conv-1/${row["id"]}.jpg`);

    const audio = await send({
      to: CUSTOMER,
      type: "audio",
      audio: { base64: Buffer.from(OGG).toString("base64") },
    });
    expect(audio.status).toBe(202);
    expect(sendBody(sends()[1]!)).toMatchObject({ type: "audio", audio: { id: "meta-media-1" } });
  });

  it("no credit check, as an inbox reply: an empty wallet still sends; a locked workspace doesn't", async () => {
    h.world = publicApiWorld({ balance: 0 });
    h.world.db.rows("whatsapp_accounts").push({
      id: "acc-a2",
      organization_id: ORG,
      waba_id: "waba-a",
      phone_number_id: "pn-a2",
      status: "active",
    });
    customerWrote(1);
    expect((await send({ to: CUSTOMER, type: "text", text: "Hello" })).status).toBe(202);
    h.world.db.rows("organizations").find((o) => o["id"] === ORG)!["plan_status"] = "locked";
    const locked = await send({ to: CUSTOMER, type: "text", text: "Hello" });
    expect([locked.status, locked.body["code"]]).toEqual([402, "workspace_locked"]);
    expect(sends()).toHaveLength(1);
  });
});

describe("outside the window: 409 window_closed, send a template instead", () => {
  it("last wrote 25 hours ago, never wrote, or isn't a contact: nothing reaches Meta", async () => {
    customerWrote(25);
    for (const to of [CUSTOMER, "+919811111111"]) {
      const res = await send({ to, type: "text", text: "Hello" });
      expect(res.status, to).toBe(409);
      expect(res.body["code"]).toBe("window_closed");
      expect(String(res.body["error"])).toMatch(
        /Send a template instead \(POST \/api\/v1\/messages\/template\)/,
      );
    }
    expect(net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"))).toEqual([]);
    expect(h.world!.db.rows("messages")).toEqual([]);
  });

  it("another workspace's key never reaches this workspace's customer or thread", async () => {
    customerWrote(1);
    const res = await send({ to: CUSTOMER, type: "text", text: "Hello" }, h.world!.keys.b);
    expect([res.status, res.body["code"]]).toEqual([409, "window_closed"]);
    expect(sends()).toEqual([]);
    expect(h.world!.db.rows("messages").filter((m) => m["organization_id"] === OTHER_ORG)).toEqual(
      [],
    );
  });
});

describe("checked before anything is sent", () => {
  it("4 buttons, a long title, an audio caption, an unknown type, a GIF: 400", async () => {
    customerWrote(1);
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, title: `B${i}` }));
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "buttons", body: "x", buttons: four }, "invalid_message"],
      [
        { type: "buttons", body: "x", buttons: [{ id: "a", title: "x".repeat(21) }] },
        "invalid_message",
      ],
      [
        {
          type: "list",
          body: "x",
          button: "Go",
          sections: [
            {
              title: "",
              rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: "R" })),
            },
          ],
        },
        "invalid_message",
      ],
      [
        { type: "audio", audio: { base64: Buffer.from(OGG).toString("base64"), caption: "hi" } },
        "invalid_message",
      ],
      [{ type: "sticker" }, "invalid_message"],
      [{ type: "text", text: "" }, "invalid_message"],
      [
        { type: "image", image: { base64: Buffer.from("GIF89a..").toString("base64") } },
        "media_type_unsupported",
      ],
      [{ type: "image", image: { url: "http://x.example.com/a.jpg" } }, "media_url_not_https"],
    ];
    for (const [over, code] of cases) {
      const res = await send({ to: CUSTOMER, ...over });
      expect([res.status, res.body["code"]], JSON.stringify(over).slice(0, 60)).toEqual([
        400,
        code,
      ]);
    }
    expect(sends()).toEqual([]);
  });
});

describe("idempotency", () => {
  it("the same key twice sends once and answers the same; another message with it is refused", async () => {
    customerWrote(1);
    const body = { to: CUSTOMER, type: "text", text: "Your code is ready", idempotency_key: "s-1" };
    const first = await send(body);
    const again = await send(body);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const other = await send({ ...body, text: "Something else" });
    expect([other.status, other.body["code"]]).toEqual([409, "idempotency_key_reused"]);
    expect(sends()).toHaveLength(1);
  });

  it("a window_closed refusal frees the key: once the customer writes, the same key sends", async () => {
    customerWrote(30);
    expect(
      (await send({ to: CUSTOMER, type: "text", text: "Hi", idempotency_key: "s-2" })).status,
    ).toBe(409);
    h.world!.db.rows("conversations")[0]!["last_customer_message_at"] = new Date().toISOString();
    expect(
      (await send({ to: CUSTOMER, type: "text", text: "Hi", idempotency_key: "s-2" })).status,
    ).toBe(202);
  });
});
