import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  fakeFetch,
  metaRoutes,
  ORG,
  PDF,
  publicApiWorld,
  type FetchCall,
  type FetchRoute,
} from "./test-support/public-api-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";
import { requestFingerprint } from "./public-api.server";

/**
 * Batch 37 item 1 — POST /api/v1/messages/template sends ANY approved
 * template: header none / text / image / video / document / location, body
 * values, link / quick-reply / copy-code / one-time-code button values, an
 * offer's end — all checked against the template's stored components before
 * anything reaches Meta. A Batch 34 request still sends byte for byte what it
 * sent before. Fakes only: Meta, the file host and DNS are a fake fetch.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/messages/template";

type Post = (a: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: { POST: Post } } } }).options
  .server.handlers.POST;

const B64 = Buffer.from(PDF).toString("base64");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypmp42"), 0, 0, 0, 0, 1, 2, 3, 4]);

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };
let extraRoutes: FetchRoute[] = [];
let dns: Record<string, string[]> = {};

function install() {
  net = fakeFetch([(c) => extraRoutes.map((r) => r(c)).find(Boolean), metaRoutes(meta)], dns);
  vi.stubGlobal("fetch", net.impl);
}

async function send(body: unknown, key = h.world!.keys.a) {
  const res = await POST({
    request: new Request("https://aidwar.in/api/v1/messages/template", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  });
  return {
    status: res.status,
    headers: res.headers,
    text: "",
    body: (await res.json()) as Record<string, unknown>,
  };
}

const metaCalls = () => net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"));
const sends = () => metaCalls().filter((c) => c.url.endsWith("/messages"));
const uploads = () => metaCalls().filter((c) => c.url.endsWith("/media"));
const sendBody = (c: FetchCall) => JSON.parse(String(c.body)) as Record<string, unknown>;
const components = () =>
  (sendBody(sends()[0]!)["template"] as { components: Array<Record<string, unknown>> }).components;

function addTemplate(
  name: string,
  comps: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
) {
  h.world!.db.rows("message_templates").push({
    id: `t-${name}`,
    organization_id: ORG,
    waba_id: "waba-a",
    name,
    language: "en",
    category: "MARKETING",
    status: "APPROVED",
    components: comps,
    ...over,
  });
}

beforeEach(() => {
  h.world = publicApiWorld();
  meta.sendError = null;
  meta.uploadError = false;
  extraRoutes = [];
  dns = {};
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  install();
  addTemplate("promo_image", [
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } },
    { type: "BODY", text: "Hi {{1}}, our sale is on." },
    {
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Shop", url: "https://shop.example.com/s/{{1}}" },
        { type: "QUICK_REPLY", text: "Stop offers" },
        { type: "COPY_CODE", example: ["SAVE20"] },
      ],
    },
  ]);
  addTemplate(
    "order_text",
    [
      { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
      { type: "BODY", text: "Hi {{1}}, order {{2}} is packed." },
    ],
    { category: "UTILITY" },
  );
  addTemplate("plain_marketing", [{ type: "BODY", text: "Hello {{1}}" }]);
  addTemplate("clip", [
    { type: "HEADER", format: "VIDEO", example: { header_handle: ["h"] } },
    { type: "BODY", text: "Watch this" },
  ]);
  addTemplate(
    "store_pin",
    [
      { type: "HEADER", format: "LOCATION" },
      { type: "BODY", text: "We moved." },
    ],
    { category: "UTILITY" },
  );
  addTemplate(
    "login_code",
    [
      { type: "BODY", text: "*{{1}}* is your verification code." },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ],
    { category: "AUTHENTICATION" },
  );
  addTemplate("flash_sale", [
    { type: "LIMITED_TIME_OFFER", limited_time_offer: { text: "Ends soon", has_expiration: true } },
    { type: "BODY", text: "Sale!" },
  ]);
  addTemplate("own_picture", [
    {
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: ["h"], aidwar_media_url: "https://cdn.example.com/banner.jpg" },
    },
    { type: "BODY", text: "New in." },
  ]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Batch 34 requests are unchanged", () => {
  it("the old document request sends byte for byte the same Meta request, answers the same, and keeps its idempotency fingerprint", async () => {
    const res = await send({
      to: "+91 98765 43210",
      template_name: "invoice_ready",
      document: { base64: B64, filename: "INV-1001" },
      body_params: ["Asha", "INV-1001", "INR 2,500"],
      idempotency_key: "inv-1001",
    });
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual([
      "idempotency_key",
      "message_id",
      "status",
      "wamid",
    ]);
    expect(res.body).toMatchObject({
      status: "queued",
      wamid: "wamid.1",
      idempotency_key: "inv-1001",
    });
    // Exactly Batch 34's bytes.
    expect(String(sends()[0]!.body)).toBe(
      JSON.stringify({
        messaging_product: "whatsapp",
        to: "919876543210",
        type: "template",
        template: {
          name: "invoice_ready",
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [
                { type: "document", document: { id: "meta-media-1", filename: "INV-1001.pdf" } },
              ],
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: "Asha" },
                { type: "text", text: "INV-1001" },
                { type: "text", text: "INR 2,500" },
              ],
            },
          ],
        },
      }),
    );
    const form = uploads()[0]!.body as FormData;
    expect(form.get("type")).toBe("application/pdf");
    // The reservation hashes the fields Batch 34 hashed, so a retry across the deploy still replays.
    expect(h.world!.db.rows("api_requests")[0]!["request_hash"]).toBe(
      requestFingerprint({
        to: "919876543210",
        template_name: "invoice_ready",
        language: null,
        body_params: ["Asha", "INV-1001", "INR 2,500"],
        document_url: null,
        document_sha256: createHash("sha256").update(B64).digest("hex"),
        filename: "INV-1001.pdf",
      }),
    );
    const row = h.world!.db.rows("messages")[0]!;
    expect(row["metadata"]).toMatchObject({ document_filename: "INV-1001.pdf", source: "api" });
  });

  it("the same document, sent as header: { type: document }, sends the same template", async () => {
    const res = await send({
      to: "+919876543210",
      template_name: "invoice_ready",
      header: { type: "document", base64: B64, filename: "INV-1001.pdf" },
      body_params: ["Asha", "INV-1001", "INR 2,500"],
    });
    expect(res.status).toBe(202);
    expect(components()[0]).toEqual({
      type: "header",
      parameters: [
        { type: "document", document: { id: "meta-media-1", filename: "INV-1001.pdf" } },
      ],
    });
  });

  it("a template without a document header, sent WITH a document: a clear 400, nothing sent", async () => {
    for (const name of ["plain_hello", "promo_image"]) {
      const res = await send({
        to: "+919876543210",
        template_name: name,
        document: { base64: B64, filename: "x.pdf" },
        body_params: ["Asha"],
      });
      expect([res.status, res.body["code"]], name).toEqual([400, "template_not_document"]);
      expect(String(res.body["error"])).toContain("has no document header");
    }
    expect(metaCalls()).toEqual([]);
  });

  it("a document template without its document: 400 invalid_document (never the template's sample file)", async () => {
    const res = await send({
      to: "+919876543210",
      template_name: "invoice_ready",
      body_params: ["Asha", "INV-1001", "INR 2,500"],
    });
    expect([res.status, res.body["code"]]).toEqual([400, "invalid_document"]);
    expect(metaCalls()).toEqual([]);
  });
});

describe("any approved template", () => {
  it("an image header from a link, a link button's value, a quick-reply payload and a coupon code", async () => {
    extraRoutes = [
      (c) =>
        c.url === "https://files.example.com/sale.jpg"
          ? new Response(JPEG, { headers: { "content-type": "application/octet-stream" } })
          : undefined,
    ];
    const res = await send({
      to: "+919876543210",
      template_name: "promo_image",
      header: { type: "image", url: "https://files.example.com/sale.jpg" },
      body_params: ["Asha"],
      buttons: [
        { index: 0, type: "url", url_param: "diwali?ref=api" },
        { index: 1, type: "quick_reply", payload: "STOP_OFFERS" },
        { index: 2, type: "copy_code", code: "SAVE20" },
      ],
    });
    expect(res.status).toBe(202);
    expect((uploads()[0]!.body as FormData).get("type")).toBe("image/jpeg");
    expect(components()).toEqual([
      { type: "header", parameters: [{ type: "image", image: { id: "meta-media-1" } }] },
      { type: "body", parameters: [{ type: "text", text: "Asha" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "diwali?ref=api" }],
      },
      {
        type: "button",
        sub_type: "copy_code",
        index: "2",
        parameters: [{ type: "coupon_code", coupon_code: "SAVE20" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [{ type: "payload", payload: "STOP_OFFERS" }],
      },
    ]);
    // No short link was made for a value the caller gave.
    expect(h.world!.db.rows("short_links")).toEqual([]);
    // Our private copy of the picture, for the inbox.
    const row = h.world!.db.rows("messages")[0]!;
    expect(String(row["media_url"])).toMatch(/^storage:chat-media\/org-a\/.+\.jpg$/);
    expect(row["media_mime"]).toBe("image/jpeg");
  });

  it("a video header as base64; a text header with its own values; a map pin", async () => {
    expect(
      (
        await send({
          to: "+919876543210",
          template_name: "clip",
          header: { type: "video", base64: Buffer.from(MP4).toString("base64") },
        })
      ).status,
    ).toBe(202);
    expect((uploads()[0]!.body as FormData).get("type")).toBe("video/mp4");
    expect(components()[0]).toEqual({
      type: "header",
      parameters: [{ type: "video", video: { id: "meta-media-1" } }],
    });

    install();
    expect(
      (
        await send({
          to: "+919876543210",
          template_name: "order_text",
          header: { type: "text", params: ["#1042"] },
          body_params: ["Asha", "#1042"],
        })
      ).status,
    ).toBe(202);
    expect(components()).toEqual([
      { type: "header", parameters: [{ type: "text", text: "#1042" }] },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Asha" },
          { type: "text", text: "#1042" },
        ],
      },
    ]);

    install();
    expect(
      (
        await send({
          to: "+919876543210",
          template_name: "store_pin",
          header: { type: "location", latitude: 19.07, longitude: 72.87, name: "Shop" },
        })
      ).status,
    ).toBe(202);
    expect(components()[0]).toEqual({
      type: "header",
      parameters: [
        { type: "location", location: { latitude: "19.07", longitude: "72.87", name: "Shop" } },
      ],
    });
  });

  it("a one-time code (authentication) and a limited-time offer", async () => {
    expect(
      (
        await send({
          to: "+919876543210",
          template_name: "login_code",
          body_params: ["482913"],
          buttons: [{ index: 0, type: "url", url_param: "482913" }],
        })
      ).status,
    ).toBe(202);
    expect(components()).toContainEqual({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "482913" }],
    });

    install();
    const noEnd = await send({ to: "+919876543210", template_name: "flash_sale" });
    expect([noEnd.status, noEnd.body["code"]]).toEqual([400, "invalid_offer"]);
    const at = Date.UTC(2030, 0, 1);
    const ok = await send({
      to: "+919876543210",
      template_name: "flash_sale",
      offer_expires_at: new Date(at).toISOString(),
    });
    expect(ok.status).toBe(202);
    expect(components()).toContainEqual({
      type: "limited_time_offer",
      parameters: [{ type: "limited_time_offer", limited_time_offer: { expiration_time_ms: at } }],
    });
  });

  it("an image template the merchant built in AiDwar may leave the header out: its own picture goes", async () => {
    expect((await send({ to: "+919876543210", template_name: "own_picture" })).status).toBe(202);
    expect(uploads()).toEqual([]);
    expect(components()[0]).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { link: "https://cdn.example.com/banner.jpg" } }],
    });
  });
});

describe("checked against the template before anything is sent", () => {
  it("every mismatch is a 400 that names the part", async () => {
    const jpeg = Buffer.from(JPEG).toString("base64");
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ template_name: "promo_image", body_params: ["A"] }, "header_required", /image header/],
      [
        {
          template_name: "promo_image",
          header: { type: "video", base64: jpeg },
          body_params: ["A"],
        },
        "header_mismatch",
        /image header/,
      ],
      [
        {
          template_name: "promo_image",
          header: { type: "image", base64: jpeg },
          body_params: ["A"],
          buttons: [{ index: 2, type: "copy_code", code: "X" }],
        },
        "invalid_buttons",
        /button 0 \(link "Shop"\) needs a value/,
      ],
      [
        {
          template_name: "promo_image",
          header: { type: "image", base64: jpeg },
          body_params: ["A"],
          buttons: [
            { index: 0, type: "quick_reply", payload: "x" },
            { index: 2, type: "copy_code", code: "X" },
          ],
        },
        "invalid_buttons",
        /is a url button/,
      ],
      [
        {
          template_name: "promo_image",
          header: { type: "image", base64: jpeg },
          body_params: ["A"],
          buttons: [
            { index: 0, type: "url", url_param: "x" },
            { index: 2, type: "copy_code", code: "X" },
            { index: 5, type: "url", url_param: "y" },
          ],
        },
        "invalid_buttons",
        /has no button 5/,
      ],
      [
        { template_name: "order_text", body_params: ["A", "B"] },
        "param_count_mismatch",
        /header takes 1 value/,
      ],
      [
        {
          template_name: "plain_marketing",
          header: { type: "text", params: ["x"] },
          body_params: ["A"],
        },
        "header_mismatch",
        /no values to fill/,
      ],
      [{ template_name: "plain_marketing", body_params: [] }, "param_count_mismatch", /body value/],
      [{ template_name: "store_pin" }, "header_required", /location header/],
      [
        { template_name: "plain_marketing", header: { type: "gif" }, body_params: ["A"] },
        "invalid_header",
        /header.type/,
      ],
      [
        {
          template_name: "login_code",
          body_params: ["1"],
          buttons: [{ index: 0, type: "url", url_param: "1".repeat(16) }],
        },
        "invalid_buttons",
        /longer than/,
      ],
    ];
    for (const [over, code, words] of cases) {
      const res = await send({ to: "+919876543210", ...over });
      expect([res.status, res.body["code"]], code).toEqual([400, code]);
      expect(String(res.body["error"]), code).toMatch(words);
    }
    expect(metaCalls()).toEqual([]);
    expect(h.world!.db.rows("messages")).toEqual([]);
  });

  it("files: over 5 MB for a picture is 413, a GIF is refused, a private link is refused", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0xff);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    const tooBig = await send({
      to: "+919876543210",
      template_name: "promo_image",
      header: { type: "image", base64: big.toString("base64") },
      body_params: ["A"],
      buttons: [
        { index: 0, type: "url", url_param: "x" },
        { index: 2, type: "copy_code", code: "X" },
      ],
    });
    expect([tooBig.status, tooBig.body["code"]]).toEqual([413, "media_too_large"]);

    const gif = await send({
      to: "+919876543210",
      template_name: "promo_image",
      header: { type: "image", base64: Buffer.from("GIF89a....").toString("base64") },
      body_params: ["A"],
      buttons: [
        { index: 0, type: "url", url_param: "x" },
        { index: 2, type: "copy_code", code: "X" },
      ],
    });
    expect([gif.status, gif.body["code"]]).toEqual([400, "media_type_unsupported"]);

    dns = { "inside.example.com": ["10.1.2.3"] };
    install();
    const inside = await send({
      to: "+919876543210",
      template_name: "promo_image",
      header: { type: "image", url: "https://inside.example.com/a.jpg" },
      body_params: ["A"],
      buttons: [
        { index: 0, type: "url", url_param: "x" },
        { index: 2, type: "copy_code", code: "X" },
      ],
    });
    expect([inside.status, inside.body["code"]]).toEqual([400, "media_url_blocked"]);
    expect(metaCalls()).toEqual([]);
  });
});

describe("opt-out: the inbox's rule", () => {
  it("someone who opted out never gets a marketing template; a utility one still goes", async () => {
    const marketing = await send({
      to: "919800000009",
      template_name: "plain_marketing",
      body_params: ["Asha"],
    });
    expect([marketing.status, marketing.body["code"]]).toEqual([409, "contact_opted_out"]);
    expect(metaCalls()).toEqual([]);

    const utility = await send({
      to: "919800000009",
      template_name: "order_text",
      header: { type: "text", params: ["#7"] },
      body_params: ["Asha", "#7"],
    });
    expect(utility.status).toBe(202);
    expect(sends()).toHaveLength(1);
  });
});

describe("idempotency (v1.1 requests)", () => {
  it("a repeat replays; the same key with another header is refused", async () => {
    const body = {
      to: "+919876543210",
      template_name: "order_text",
      header: { type: "text", params: ["#1"] },
      body_params: ["Asha", "#1"],
      idempotency_key: "ord-1",
    };
    const first = await send(body);
    const again = await send(body);
    expect(first.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const other = await send({ ...body, header: { type: "text", params: ["#2"] } });
    expect([other.status, other.body["code"]]).toEqual([409, "idempotency_key_reused"]);
    expect(sends()).toHaveLength(1);
  });
});
