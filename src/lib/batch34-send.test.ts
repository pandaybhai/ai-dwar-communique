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

/**
 * Batch 34 item 2 — POST /api/v1/messages/template. An approved document
 * template goes out through the shared template sender with the PDF
 * uploaded to Meta and sent by media id; the row is a normal template
 * message with metadata.source "api" and our private copy of the PDF.
 * Every refusal (wrong template, opted out, no credits, unsafe link, not a
 * PDF, too big, rate limit, repeat) happens before anything reaches Meta.
 * Fakes only: Meta, the merchant's file host and DNS are a fake fetch.
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
const good = (over: Record<string, unknown> = {}) => ({
  to: "+91 98765 43210",
  template_name: "invoice_ready",
  document: { base64: B64, filename: "INV-1001.pdf" },
  body_params: ["Asha", "INV-1001", "INR 2,500"],
  ...over,
});

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };
let extraRoutes: FetchRoute[] = [];
let dns: Record<string, string[]> = {};

function install() {
  net = fakeFetch([(c) => extraRoutes.map((r) => r(c)).find(Boolean), metaRoutes(meta)], dns);
  vi.stubGlobal("fetch", net.impl);
}

async function send(body: unknown, key = h.world!.keys.a, headers: Record<string, string> = {}) {
  const res = await POST({
    request: new Request("https://aidwar.in/api/v1/messages/template", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const metaCalls = () => net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"));
const sends = () => metaCalls().filter((c) => c.url.endsWith("/messages"));
const sendBody = (c: FetchCall) => JSON.parse(String(c.body)) as Record<string, unknown>;

beforeEach(() => {
  h.world = publicApiWorld();
  meta.sendError = null;
  meta.uploadError = false;
  extraRoutes = [];
  dns = {};
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  install();
});
afterEach(() => vi.unstubAllGlobals());

describe("a good send", () => {
  it("202 queued with the wamid; the PDF is uploaded to Meta and sent by media id through the approved template", async () => {
    const res = await send(good());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "queued",
      wamid: "wamid.1",
      message_id: expect.any(String),
    });

    const upload = metaCalls().find(
      (c) => c.url === "https://graph.facebook.com/v25.0/pn-a/media",
    )!;
    expect(upload.method).toBe("POST");
    expect(upload.headers["authorization"]).toBe("Bearer meta-token-a");
    const form = upload.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect((form.get("file") as File).name).toBe("INV-1001.pdf");
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(PDF);

    expect(sends()).toHaveLength(1);
    const sent = sendBody(sends()[0]!);
    expect(sent).toMatchObject({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "template",
    });
    expect(sent["template"]).toEqual({
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
    });
  });

  it("the row is a normal template message (inbox, analytics) marked source api, with our private copy of the PDF", async () => {
    const res = await send(good());
    const w = h.world!;
    const row = w.db.rows("messages").find((m) => m["id"] === res.body["message_id"])!;
    expect(row).toMatchObject({
      organization_id: ORG,
      direction: "outbound",
      type: "template",
      template_name: "invoice_ready",
      status: "pending",
      meta_message_id: "wamid.1",
      media_mime: "application/pdf",
    });
    expect(row["metadata"]).toMatchObject({
      source: "api",
      api_key_id: "key-a",
      document_filename: "INV-1001.pdf",
      to: "+919876543210",
      template_params: { "1": "Asha", "2": "INV-1001", "3": "INR 2,500" },
    });
    const path = `${ORG}/${row["conversation_id"]}/${row["id"]}.pdf`;
    expect(row["media_url"]).toBe(`storage:chat-media/${path}`);
    expect(w.storage.objects("chat-media").get(path)?.bytes).toEqual(PDF);

    const contact = w.db.rows("contacts").find((c) => c["phone"] === "+919876543210")!;
    expect(contact).toMatchObject({ source: "api", wa_id: "919876543210" });
    expect(
      w.db.rows("conversations").find((c) => c["id"] === row["conversation_id"]),
    ).toMatchObject({ contact_id: contact["id"], whatsapp_account_id: "acc-a" });
    // Metered and evented like every template send.
    expect(w.db.rows("analytics_events").some((e) => e["event_type"] === "message.sent")).toBe(
      true,
    );
    expect(w.db.rows("usage_records").some((u) => u["meter_key"] === "messages_utility")).toBe(
      true,
    );
  });

  it("a document link (https, public) is downloaded and sent the same way", async () => {
    extraRoutes = [
      (c) =>
        c.url === "https://files.example.com/inv.pdf"
          ? new Response(PDF, { headers: { "content-type": "application/pdf" } })
          : undefined,
    ];
    const res = await send(
      good({ document: { url: "https://files.example.com/inv.pdf", filename: "inv" } }),
    );
    expect(res.status).toBe(202);
    expect(
      (
        sendBody(sends()[0]!)["template"] as {
          components: Array<{ parameters: Array<{ document?: unknown }> }>;
        }
      ).components[0]!.parameters[0]!.document,
    ).toEqual({
      id: "meta-media-1",
      filename: "inv.pdf",
    });
  });

  it("an existing contact keeps its own source", async () => {
    h.world!.db.rows("contacts").push({
      id: "c-old",
      organization_id: ORG,
      phone: "+919876543210",
      wa_id: "919876543210",
      source: "import",
      opt_in_status: "opted_in",
    });
    expect((await send(good())).status).toBe(202);
    expect(h.world!.db.rows("contacts").filter((c) => c["phone"] === "+919876543210")).toEqual([
      expect.objectContaining({ id: "c-old", source: "import" }),
    ]);
  });
});

describe("refused before anything is sent", () => {
  const nothingSent = () => {
    expect(sends()).toEqual([]);
    expect(h.world!.db.rows("messages")).toEqual([]);
  };

  it("wrong template / not approved / no document header / param mismatch: 400 with a clear code", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ template_name: "no_such_template" }, "template_not_found"],
      [{ template_name: "b_invoice" }, "template_not_found"], // another workspace's template
      [{ template_name: "invoice_pending" }, "template_not_approved"],
      [{ template_name: "plain_hello", body_params: ["Asha"] }, "template_not_document"],
      [{ body_params: ["Asha", "INV-1001"] }, "param_count_mismatch"],
      [{ body_params: ["Asha", "INV-1001", "two\nlines"] }, "invalid_body_params"],
      [{ language: "hi" }, "template_not_found"],
    ];
    for (const [over, code] of cases) {
      const res = await send(good(over));
      expect(res.status, code).toBe(400);
      expect(res.body["code"]).toBe(code);
      expect(String(res.body["error"]).length).toBeGreaterThan(10);
    }
    expect(metaCalls()).toEqual([]);
    nothingSent();
  });

  it("an opted-out customer: 409, nothing uploaded or sent", async () => {
    const res = await send(good({ to: "919800000009" }));
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("contact_opted_out");
    expect(metaCalls()).toEqual([]);
    nothingSent();
  });

  it("low balance: 402 and nothing sent", async () => {
    h.world = publicApiWorld({ balance: 0.1, rate: 0.15 });
    const res = await send(good());
    expect(res.status).toBe(402);
    expect(res.body["code"]).toBe("insufficient_credits");
    expect(metaCalls()).toEqual([]);
    nothingSent();
  });

  it("a locked workspace: 402", async () => {
    h.world!.db.rows("organizations").find((o) => o["id"] === ORG)!["plan_status"] = "locked";
    const res = await send(good());
    expect(res.status).toBe(402);
    expect(res.body["code"]).toBe("workspace_locked");
    nothingSent();
  });

  it("SSRF: http, 127.0.0.1, 10.x, a name resolving to 10.x, a redirect to a private address or to http — all refused", async () => {
    dns = { "inside.example.com": ["10.1.2.3"], "redirector.example.com": ["93.184.216.34"] };
    install();
    extraRoutes = [
      (c) =>
        c.url === "https://redirector.example.com/meta"
          ? new Response(null, {
              status: 302,
              headers: { location: "https://169.254.169.254/latest/meta-data" },
            })
          : undefined,
      (c) =>
        c.url === "https://redirector.example.com/plain"
          ? new Response(null, {
              status: 301,
              headers: { location: "http://files.example.com/inv.pdf" },
            })
          : undefined,
      (c) =>
        c.url === "https://redirector.example.com/private"
          ? new Response(null, { status: 302, headers: { location: "https://10.0.0.8/inv.pdf" } })
          : undefined,
    ];
    const cases: Array<[string, string]> = [
      ["http://files.example.com/inv.pdf", "document_url_not_https"],
      ["https://127.0.0.1/inv.pdf", "document_url_blocked"],
      ["https://10.0.0.5/inv.pdf", "document_url_blocked"],
      ["https://localhost/inv.pdf", "document_url_blocked"],
      ["https://inside.example.com/inv.pdf", "document_url_blocked"],
      ["https://redirector.example.com/meta", "document_url_blocked"],
      ["https://redirector.example.com/plain", "document_url_blocked"],
      ["https://redirector.example.com/private", "document_url_blocked"],
    ];
    for (const [url, code] of cases) {
      const res = await send(good({ document: { url, filename: "inv.pdf" } }));
      expect(res.status, url).toBe(400);
      expect(res.body["code"], url).toBe(code);
    }
    // Nothing internal was ever asked for.
    expect(net.calls.some((c) => /\/\/(127\.|10\.|169\.254\.|localhost)/.test(c.url))).toBe(false);
    expect(metaCalls()).toEqual([]);
    nothingSent();
  });

  it("not a PDF: 400; over 16 MB as base64 or as a streamed link (no length given): 413", async () => {
    const notPdf = await send(
      good({ document: { base64: Buffer.from("hello").toString("base64"), filename: "x.pdf" } }),
    );
    expect([notPdf.status, notPdf.body["code"]]).toEqual([400, "document_not_pdf"]);

    const big = Buffer.alloc(16 * 1024 * 1024 + 10, 0x41).toString("base64");
    const tooBig = await send(good({ document: { base64: big, filename: "x.pdf" } }));
    expect([tooBig.status, tooBig.body["code"]]).toEqual([413, "document_too_large"]);

    let served = 0;
    extraRoutes = [
      (c) => {
        if (c.url !== "https://files.example.com/endless.pdf") return undefined;
        const chunk = new Uint8Array(1024 * 1024);
        const stream = new ReadableStream<Uint8Array>({
          pull(ctl) {
            served += 1;
            ctl.enqueue(chunk);
            if (served > 40) ctl.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/pdf" } });
      },
    ];
    const streamed = await send(
      good({ document: { url: "https://files.example.com/endless.pdf", filename: "x.pdf" } }),
    );
    expect([streamed.status, streamed.body["code"]]).toEqual([413, "document_too_large"]);
    expect(served).toBeLessThanOrEqual(18); // stopped reading just past 16 MB
    nothingSent();
  });

  it("rate limit: the 61st call of a minute on one key is 429 with Retry-After; a workspace over 300 too", async () => {
    h.world!.rate.windows.set("key:key-a", 60);
    const res = await send(good());
    expect(res.status).toBe(429);
    expect(res.body["code"]).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBe("42");

    h.world!.rate.windows.clear();
    h.world!.rate.windows.set("org:org-a", 300);
    const org = await send(good());
    expect(org.status).toBe(429);
    expect(String(org.body["error"])).toMatch(/per workspace/);
    nothingSent();
  });

  it("revoked key 401, flag off 403 — before the body is even read", async () => {
    expect((await send("not json", h.world!.keys.revoked)).status).toBe(401);
    h.world!.flags.on = false;
    const off = await send("not json");
    expect(off.status).toBe(403);
    expect(off.body["code"]).toBe("public_api_disabled");
    nothingSent();
  });

  it("bad JSON or a missing field: 400", async () => {
    expect((await send("{nope")).body["code"]).toBe("invalid_json");
    expect((await send(good({ to: "" }))).body["code"]).toBe("invalid_to");
    expect((await send(good({ to: "12" }))).body["code"]).toBe("invalid_to");
    expect(
      (await send(good({ document: { url: "https://x.example.com/a.pdf", base64: B64 } }))).body[
        "code"
      ],
    ).toBe("invalid_document");
  });
});

describe("idempotency", () => {
  it("a repeat gets the first answer even after the template was paused or the plan lapsed", async () => {
    const first = await send(good({ idempotency_key: "inv-77" }));
    expect(first.status).toBe(202);
    h.world!.db.rows("message_templates").find((t) => t["name"] === "invoice_ready")!["status"] =
      "PAUSED";
    h.world!.db.rows("organizations").find((o) => o["id"] === ORG)!["plan_status"] = "locked";
    const again = await send(good({ idempotency_key: "inv-77" }));
    expect([again.status, again.body]).toEqual([202, first.body]);
    expect(sends()).toHaveLength(1);
  });

  it("a refusal after the reservation (template, plan) frees the key", async () => {
    expect(
      (await send(good({ idempotency_key: "inv-78", template_name: "invoice_pending" }))).status,
    ).toBe(400);
    expect((await send(good({ idempotency_key: "inv-78" }))).status).toBe(202);
  });

  it("the same idempotency_key twice sends once and answers the same", async () => {
    const first = await send(good({ idempotency_key: "inv-1001" }));
    const again = await send(good({ idempotency_key: "inv-1001" }));
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(sends()).toHaveLength(1);
    expect(h.world!.db.rows("messages")).toHaveLength(1);
    expect(h.world!.db.rows("messages")[0]!["metadata"]).toMatchObject({
      idempotency_key: "inv-1001",
    });
  });

  it("the Idempotency-Key header works too; the same key with a different request is 409, never sent", async () => {
    expect((await send(good(), h.world!.keys.a, { "idempotency-key": "k-2" })).status).toBe(202);
    const other = await send(
      good({ body_params: ["Ravi", "INV-1002", "INR 900"] }),
      h.world!.keys.a,
      { "idempotency-key": "k-2" },
    );
    expect(other.status).toBe(409);
    expect(other.body["code"]).toBe("idempotency_key_reused");
    expect(sends()).toHaveLength(1);
  });

  it("a request still in flight with the key: 409 in progress", async () => {
    h.world!.db.rows("api_requests").push({
      id: "r-1",
      organization_id: ORG,
      idempotency_key: "busy",
      request_hash: "x",
      state: "processing",
      created_at: new Date().toISOString(),
    });
    const res = await send(good({ idempotency_key: "busy" }));
    expect(res.status).toBe(409);
    expect(sends()).toEqual([]);
  });

  it("a refusal before sending frees the key: after topping up, the same key sends", async () => {
    h.world = publicApiWorld({ balance: 0, rate: 0.15 });
    expect((await send(good({ idempotency_key: "inv-9" }))).status).toBe(402);
    h.world.db.rows("wallet_balances")[0]!["balance"] = 50;
    expect((await send(good({ idempotency_key: "inv-9" }))).status).toBe(202);
    expect(sends()).toHaveLength(1);
  });

  it("another workspace's identical key is its own", async () => {
    expect((await send(good({ idempotency_key: "same" }))).status).toBe(202);
    h.world!.db.rows("message_templates").push({
      id: "t5",
      organization_id: "org-b",
      waba_id: "waba-b",
      name: "invoice_ready",
      language: "en",
      category: "UTILITY",
      status: "APPROVED",
      components: h.world!.db.rows("message_templates")[0]!["components"],
    });
    h.world!.db.rows("wallet_balances").push({ organization_id: "org-b", balance: 10, held: 0 });
    expect((await send(good({ idempotency_key: "same" }), h.world!.keys.b)).status).toBe(202);
    expect(sends()).toHaveLength(2);
  });
});

describe("Meta says no", () => {
  it("the upload refused: 502, nothing sent", async () => {
    meta.uploadError = true;
    const res = await send(good());
    expect([res.status, res.body["code"]]).toEqual([502, "whatsapp_upload_failed"]);
    expect(sends()).toEqual([]);
  });

  it("the send refused: 502 with the failed message id; the failed row is in the inbox, marked api", async () => {
    meta.sendError = { message: "(#132000) Number of parameters does not match", code: 132000 };
    const res = await send(good());
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: "whatsapp_rejected",
      status: "failed",
      message_id: expect.any(String),
    });
    const row = h.world!.db.rows("messages")[0]!;
    expect(row).toMatchObject({ status: "failed", type: "template" });
    expect(row["metadata"]).toMatchObject({ source: "api", api_key_id: "key-a" });
  });
});

describe("never logged", () => {
  it("no key, no document bytes in any log line", async () => {
    const lines: string[] = [];
    const spy = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(spy);
    vi.spyOn(console, "warn").mockImplementation(spy);
    vi.spyOn(console, "error").mockImplementation(spy);
    meta.sendError = { message: "nope", code: 1 };
    await send(good());
    await send(good({ template_name: "nope" }));
    const all = lines.join("\n");
    expect(all).not.toContain(h.world!.keys.a);
    expect(all).not.toContain(B64.slice(0, 40));
    expect(all).not.toContain("%PDF");
  });
});
