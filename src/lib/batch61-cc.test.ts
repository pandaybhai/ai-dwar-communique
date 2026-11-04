import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { MAX_CC, copyIdempotencyKey, parseCcNumbers } from "./public-api-cc";

/**
 * Batch 61 — copies ("cc") of a Public API template send: POST
 * /api/v1/messages/template takes `cc` (up to MAX_CC numbers: 10 since Batch 62) and the workspace
 * default (Settings → API & webhooks) applies when it doesn't. Copies go
 * through the same sender after the customer's send is accepted, reuse the
 * one Meta media upload, each have a derived idempotency key, count against
 * the rate limits, never change the customer's answer, and are marked
 * metadata.copy / cc_of. Fakes only: Meta and DNS are a fake fetch, the
 * database is in memory.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/messages/template";
import { Route as CopiesRoute } from "../routes/api/developer/copies";
import { Route as StatusRoute } from "../routes/api/v1/messages/$messageId";

type Handler = (a: { request: Request; params?: Record<string, string> }) => Promise<Response>;
type Handlers = { options: { server: { handlers: Record<string, Handler> } } };
const POST = (Route as unknown as Handlers).options.server.handlers["POST"]!;
const copies = (CopiesRoute as unknown as Handlers).options.server.handlers;
const statusGet = (StatusRoute as unknown as Handlers).options.server.handlers["GET"]!;

const B64 = Buffer.from(PDF).toString("base64");
const STAFF_1 = "+918121310333";
const STAFF_2 = "+919121883067";
const CUSTOMER = "+919876543210";
/** Batch 62: one more number than the limit (MAX_CC + 1 valid, distinct numbers). */
const TOO_MANY = Array.from(
  { length: MAX_CC + 1 },
  (_, i) => `+9198000001${String(i).padStart(2, "0")}`,
);

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };
let extraRoutes: FetchRoute[] = [];

function install() {
  net = fakeFetch([(c) => extraRoutes.map((r) => r(c)).find(Boolean), metaRoutes(meta)]);
  vi.stubGlobal("fetch", net.impl);
}

async function send(body: unknown, key = h.world!.keys.a) {
  const res = await POST({
    request: new Request("https://aidwar.in/api/v1/messages/template", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

const metaCalls = () => net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"));
const sends = () => metaCalls().filter((c) => c.url.endsWith("/messages"));
const uploads = () => metaCalls().filter((c) => c.url.endsWith("/media"));
const sendBody = (c: FetchCall) => JSON.parse(String(c.body)) as Record<string, unknown>;
const rows = (t: string) => h.world!.db.rows(t);
const org = () => rows("organizations").find((r) => r["id"] === ORG)!;

const invoice = (extra: Record<string, unknown> = {}) => ({
  to: CUSTOMER,
  template_name: "invoice_ready",
  document: { base64: B64, filename: "INV-1001.pdf" },
  body_params: ["Asha", "INV-1001", "INR 2,500"],
  ...extra,
});

beforeEach(() => {
  h.world = publicApiWorld();
  meta.sendError = null;
  meta.uploadError = false;
  extraRoutes = [];
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  install();
  rows("message_templates").push({
    id: "t-promo",
    organization_id: ORG,
    waba_id: "waba-a",
    name: "promo_text",
    language: "en",
    category: "MARKETING",
    status: "APPROVED",
    components: [{ type: "BODY", text: "Hello {{1}}" }],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("cc numbers are checked as `to` is", () => {
  it("removes duplicates and the `to` number; refuses more than MAX_CC or a bad number", () => {
    expect(parseCcNumbers(["+91 81213 10333", "918121310333", CUSTOMER], { to: CUSTOMER })).toEqual(
      { ok: true, numbers: [STAFF_1] },
    );
    expect(parseCcNumbers(TOO_MANY).ok).toBe(false);
    expect(parseCcNumbers(["12345"])).toMatchObject({
      ok: false,
      error: expect.stringContaining("cc[0]"),
    });
    expect(parseCcNumbers("+918121310333").ok).toBe(false);
    expect(copyIdempotencyKey("inv-1001", STAFF_1)).toBe("inv-1001:cc:+918121310333");
  });
});

describe("no cc: exactly today's request and answer", () => {
  it("the same Meta calls, the same bytes, the same answer, no `copies`", async () => {
    const res = await send(invoice({ idempotency_key: "inv-1001" }));
    expect(res.status).toBe(202);
    const id = String(res.body["message_id"]);
    // Recorded from main before Batch 61 (the same request, the same fakes).
    expect(res.text).toBe(
      JSON.stringify({
        message_id: id,
        status: "queued",
        wamid: "wamid.1",
        idempotency_key: "inv-1001",
      }),
    );
    expect(metaCalls().map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://graph.facebook.com/v25.0/pn-a/media",
      "POST https://graph.facebook.com/v25.0/pn-a/messages",
    ]);
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
    expect(rows("messages")).toHaveLength(1);
    expect(rows("messages")[0]!["metadata"]).not.toHaveProperty("copy");
    expect(rows("api_requests")).toHaveLength(1);
    expect(h.world!.rate.windows.get("key:key-a")).toBe(1);
  });

  it("a workspace whose default can't be read (20261330 not applied) sends exactly as before", async () => {
    const from = h.world!.db.supabase.from.bind(h.world!.db.supabase);
    (h.world!.db.supabase as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = from(t) as unknown as { select: (c: string) => unknown };
      if (t !== "organizations") return q;
      return {
        ...q,
        select: (cols: string) => {
          if (!cols.includes("api_cc_numbers")) return q.select(cols);
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({
              data: null,
              error: {
                code: "42703",
                message: "column organizations.api_cc_numbers does not exist",
              },
            }),
          };
          return chain;
        },
      };
    };
    const res = await send(invoice());
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual([
      "idempotency_key",
      "message_id",
      "status",
      "wamid",
    ]);
    expect(sends()).toHaveLength(1);
  });
});

describe("cc on the request", () => {
  it("2 numbers: 3 sends of the same message, 1 upload, distinct derived keys, copies marked", async () => {
    const res = await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-1001" }));
    expect(res.status).toBe(202);
    const mainId = String(res.body["message_id"]);
    expect(res.body).toMatchObject({
      status: "queued",
      wamid: "wamid.1",
      idempotency_key: "inv-1001",
    });
    const list = res.body["copies"] as Array<Record<string, unknown>>;
    expect(list.map((c) => [c["to"], c["status"]])).toEqual([
      [STAFF_1, "queued"],
      [STAFF_2, "queued"],
    ]);
    expect(uploads()).toHaveLength(1);
    expect(sends()).toHaveLength(3);
    // The customer first, then the copies; everything but `to` is the same bytes.
    const bodies = sends().map(sendBody);
    expect(bodies.map((b) => b["to"])).toEqual(["919876543210", "918121310333", "919121883067"]);
    for (const b of bodies.slice(1)) expect({ ...b, to: "x" }).toEqual({ ...bodies[0]!, to: "x" });

    expect(
      rows("api_requests")
        .map((r) => r["idempotency_key"])
        .sort(),
    ).toEqual(["inv-1001", "inv-1001:cc:+918121310333", "inv-1001:cc:+919121883067"]);
    const copyRows = rows("messages").filter(
      (m) => (m["metadata"] as Record<string, unknown>)["copy"],
    );
    expect(copyRows).toHaveLength(2);
    for (const [i, row] of copyRows.entries()) {
      expect(row["metadata"]).toMatchObject({
        source: "api",
        copy: true,
        cc_of: mainId,
        to: [STAFF_1, STAFF_2][i],
        idempotency_key: copyIdempotencyKey("inv-1001", [STAFF_1, STAFF_2][i]!),
        document_filename: "INV-1001.pdf",
      });
      expect(row["id"]).toBe(list[i]!["message_id"]);
    }
    const mainRow = rows("messages").find((m) => m["id"] === mainId)!;
    expect(mainRow["metadata"]).not.toHaveProperty("copy");
  });

  it("without an idempotency_key, copies get none either", async () => {
    const res = await send(invoice({ cc: [STAFF_1] }));
    expect(res.status).toBe(202);
    expect(rows("api_requests")).toHaveLength(0);
    const copy = rows("messages").find((m) => (m["metadata"] as Record<string, unknown>)["copy"])!;
    expect((copy["metadata"] as Record<string, unknown>)["idempotency_key"]).toBeNull();
  });

  it("a retry with the same key sends nothing new and answers with the same copies", async () => {
    const first = await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-1001" }));
    const again = await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-1001" }));
    expect(again.status).toBe(202);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(sends()).toHaveLength(3);
    expect(uploads()).toHaveLength(1);
    // A different cc under the same key is a different request.
    const other = await send(invoice({ cc: [STAFF_1], idempotency_key: "inv-1001" }));
    expect([other.status, other.body["code"]]).toEqual([409, "idempotency_key_reused"]);
    expect(sends()).toHaveLength(3);
  });

  it("a copy whose own key was already used is never sent again", async () => {
    // As if a copy had gone out under its derived key before (say, the main
    // reservation was taken over after 24 h): the copy answers from its row.
    const { requestFingerprint } = await import("./public-api.server");
    void requestFingerprint;
    rows("api_requests").push({
      id: "req-old-copy",
      organization_id: ORG,
      api_key_id: "key-a",
      idempotency_key: "inv-2002:cc:+918121310333",
      request_hash: "something-else",
      state: "done",
      http_status: 202,
      response: { to: STAFF_1, message_id: "old-copy", status: "queued" },
      created_at: new Date().toISOString(),
    });
    const res = await send(invoice({ cc: [STAFF_1], idempotency_key: "inv-2002" }));
    expect(res.status).toBe(202);
    expect((res.body["copies"] as unknown[])[0]).toMatchObject({
      to: STAFF_1,
      message_id: null,
      status: "not_sent",
      code: "idempotency_key_reused",
    });
    expect(sends()).toHaveLength(1);
  });

  it("an invalid cc number: 400 naming it, nothing sent or reserved", async () => {
    // Batch 65: a bad number in the list is invalid_phone naming cc[n]; a bad list stays invalid_cc.
    for (const [cc, code] of [
      [["+91 12"], "invalid_phone"],
      [[STAFF_1, "hello"], "invalid_phone"],
      [TOO_MANY, "invalid_cc"],
      ["+918121310333", "invalid_cc"],
    ] as const) {
      const res = await send(invoice({ cc, idempotency_key: "inv-bad" }));
      expect([res.status, res.body["code"]], JSON.stringify(cc)).toEqual([400, code]);
      expect(String(res.body["error"])).toMatch(/cc|WhatsApp number/);
    }
    expect(metaCalls()).toEqual([]);
    expect(rows("api_requests")).toHaveLength(0);
    expect(rows("messages")).toHaveLength(0);
  });

  it("duplicates and the `to` number are dropped", async () => {
    const res = await send(invoice({ cc: [STAFF_1, "918121310333", CUSTOMER] }));
    expect((res.body["copies"] as Array<{ to: string }>).map((c) => c.to)).toEqual([STAFF_1]);
    expect(sends()).toHaveLength(2);
  });
});

describe("the workspace default", () => {
  beforeEach(() => {
    org()["api_cc_numbers"] = [STAFF_1, STAFF_2];
  });

  it("applies to a request without cc", async () => {
    const res = await send(invoice());
    expect((res.body["copies"] as Array<{ to: string }>).map((c) => c.to)).toEqual([
      STAFF_1,
      STAFF_2,
    ]);
    expect(sends()).toHaveLength(3);
    expect(uploads()).toHaveLength(1);
  });

  it("a request's own cc overrides it, and an empty cc means no copies", async () => {
    const own = await send(invoice({ cc: ["+919800000001"] }));
    expect((own.body["copies"] as Array<{ to: string }>).map((c) => c.to)).toEqual([
      "+919800000001",
    ]);
    expect(sends()).toHaveLength(2);
    const none = await send(invoice({ cc: [] }));
    expect(none.status).toBe(202);
    expect(none.body["copies"]).toEqual([]);
    expect(sends()).toHaveLength(3);
  });

  it("never copies the customer to themselves", async () => {
    const res = await send(invoice({ to: STAFF_1 }));
    expect((res.body["copies"] as Array<{ to: string }>).map((c) => c.to)).toEqual([STAFF_2]);
  });
});

describe("a copy never changes the customer's answer", () => {
  it("the customer's send failing: 502 as today, no copies", async () => {
    meta.sendError = { message: "bad number", code: 131026 };
    const res = await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-f" }));
    expect([res.status, res.body["code"]]).toEqual([502, "whatsapp_rejected"]);
    expect(res.body).not.toHaveProperty("copies");
    expect(sends()).toHaveLength(1);
    expect(rows("api_requests").map((r) => r["idempotency_key"])).toEqual(["inv-f"]);
  });

  it("a copy WhatsApp refuses: the customer's 202 stands, the copy says failed", async () => {
    extraRoutes = [
      (c) =>
        c.url.endsWith("/messages") && sendBody(c)["to"] === "918121310333"
          ? Response.json({ error: { message: "not on WhatsApp", code: 131026 } }, { status: 400 })
          : undefined,
    ];
    const res = await send(invoice({ cc: [STAFF_1, STAFF_2] }));
    expect(res.status).toBe(202);
    expect(res.body["status"]).toBe("queued");
    const list = res.body["copies"] as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ to: STAFF_1, status: "failed", code: "whatsapp_rejected" });
    expect(list[0]!["message_id"]).toBeTruthy();
    expect(list[1]).toMatchObject({ to: STAFF_2, status: "queued" });
    // Its own message row says failed too, and the merchant's webhook hears it.
    const failed = rows("messages").find((m) => m["id"] === list[0]!["message_id"])!;
    expect(failed["status"]).toBe("failed");
    const event = rows("api_webhook_deliveries").find((d) => d["message_id"] === failed["id"])!;
    expect(event["payload"]).toMatchObject({
      event: "message.failed",
      cc_of: res.body["message_id"],
    });
  });

  it("a copy to an opted-out number (marketing): not sent, the customer's send goes", async () => {
    const res = await send({
      to: CUSTOMER,
      template_name: "promo_text",
      body_params: ["Asha"],
      cc: ["+919800000009"],
    });
    expect(res.status).toBe(202);
    expect((res.body["copies"] as unknown[])[0]).toMatchObject({
      status: "not_sent",
      code: "contact_opted_out",
    });
    expect(sends()).toHaveLength(1);
  });
});

describe("rate limits: 1 + the number of copies", () => {
  it("a send with 2 copies counts 3 against the key and the workspace", async () => {
    await send(invoice({ cc: [STAFF_1, STAFF_2] }));
    expect(h.world!.rate.windows.get("key:key-a")).toBe(3);
    expect(h.world!.rate.windows.get("org:org-a")).toBe(3);
  });

  it("copies over the limit: 429, nothing sent, the key free again", async () => {
    h.world!.rate.windows.set("key:key-a", 58);
    const res = await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-r" }));
    expect([res.status, res.body["code"]]).toEqual([429, "rate_limited"]);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(metaCalls()).toEqual([]);
    expect(rows("api_requests")).toHaveLength(0);
  });

  it("a replay counts 1", async () => {
    await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-1" }));
    await send(invoice({ cc: [STAFF_1, STAFF_2], idempotency_key: "inv-1" }));
    expect(h.world!.rate.windows.get("key:key-a")).toBe(4);
  });
});

describe("copies are told apart where API sends show", () => {
  it("the status endpoint and webhooks say cc_of for a copy only", async () => {
    const res = await send(invoice({ cc: [STAFF_1] }));
    const mainId = String(res.body["message_id"]);
    const copyId = String((res.body["copies"] as Array<{ message_id: string }>)[0]!.message_id);
    const status = async (id: string) =>
      (await (
        await statusGet({
          request: new Request(`https://aidwar.in/api/v1/messages/${id}`, {
            headers: { authorization: `Bearer ${h.world!.keys.a}` },
          }),
          params: { messageId: id },
        })
      ).json()) as Record<string, unknown>;
    expect(await status(copyId)).toMatchObject({ message_id: copyId, to: STAFF_1, cc_of: mainId });
    expect(await status(mainId)).not.toHaveProperty("cc_of");

    const { enqueueApiWebhookEvent } = await import("./public-api-webhooks.server");
    for (const id of [mainId, copyId]) {
      const row = rows("messages").find((m) => m["id"] === id)!;
      await enqueueApiWebhookEvent(h.world!.db.supabase, {
        organizationId: ORG,
        messageId: id,
        event: "message.delivered",
        occurredAt: "2026-11-03T10:00:00.000Z",
        metadata: row["metadata"] as Record<string, unknown>,
      });
    }
    const payload = (id: string) =>
      rows("api_webhook_deliveries").find((d) => d["message_id"] === id)!["payload"] as Record<
        string,
        unknown
      >;
    expect(payload(copyId)["cc_of"]).toBe(mainId);
    expect(Object.keys(payload(mainId))).toEqual([
      "event",
      "message_id",
      "idempotency_key",
      "to",
      "status",
      "error",
      "timestamp",
    ]);
  });
});

describe("Settings → API & webhooks: the default copy numbers", () => {
  const get = async (user: string) =>
    copies["GET"]!({
      request: new Request(`https://aidwar.in/api/developer/copies?organization_id=${ORG}`, {
        headers: { authorization: `Bearer ${user}` },
      }),
    });
  const save = async (user: string, numbers: unknown) =>
    copies["POST"]!({
      request: new Request("https://aidwar.in/api/developer/copies", {
        method: "POST",
        headers: { authorization: `Bearer ${user}`, "content-type": "application/json" },
        body: JSON.stringify({ organization_id: ORG, numbers }),
      }),
    });

  it("an admin saves up to MAX_CC checked numbers; it is in the activity log", async () => {
    const res = await save("u-admin", ["+91 81213 10333", STAFF_2, "918121310333"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, numbers: [STAFF_1, STAFF_2] });
    expect(org()["api_cc_numbers"]).toEqual([STAFF_1, STAFF_2]);
    expect(await (await get("u-admin")).json()).toEqual({
      available: true,
      max: 10,
      numbers: [STAFF_1, STAFF_2],
    });
    const log = rows("activity_log").find((a) => a["action"] === "api_cc_default_saved")!;
    expect(log).toMatchObject({ organization_id: ORG, user_id: "u-admin" });
    // An empty list switches copies off.
    expect((await save("u-admin", [])).status).toBe(200);
    expect(org()["api_cc_numbers"]).toEqual([]);
  });

  it("refuses a bad number, more than MAX_CC, and anyone without public_api.manage", async () => {
    const bad = await save("u-admin", ["+91 12"]);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("Number 1");
    expect((await save("u-admin", TOO_MANY)).status).toBe(400);
    expect((await save("u-agent", [STAFF_1])).status).toBe(403);
    expect((await get("u-agent")).status).toBe(403);
    expect(org()["api_cc_numbers"]).toBeUndefined();
  });
});
