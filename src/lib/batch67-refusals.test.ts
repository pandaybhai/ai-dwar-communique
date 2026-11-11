import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, metaRoutes, ORG, PDF, publicApiWorld } from "./test-support/public-api-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";
import { refusalReason, refusalRow } from "./api-refusals";

/**
 * Batch 67 — a Public API send we refuse before sending is recorded once in
 * api_refusals (for the shop's Sent report, Needs attention and the daily
 * summary), through the real template and session routes. The API's answer
 * is byte-identical with the recorder on, off, or failing; nothing secret is
 * stored; 401 and answers with a message_id (502 whatsapp_rejected) or
 * replayed from an idempotency key are never recorded. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
  recorderOff: false,
  insertThrows: false,
}));

/** The service client, with api_refusals writes that can be made to throw. */
vi.mock("@/lib/whatsapp-webhook.server", () => ({
  getServiceClient: () =>
    new Proxy(h.world!.db.supabase as object, {
      get(target, prop) {
        if (prop === "from")
          return (table: string) => {
            if (table === "api_refusals" && h.insertThrows) throw new Error("database is down");
            return (target as { from: (t: string) => unknown }).from(table);
          };
        return Reflect.get(target, prop);
      },
    }),
}));
/** The recorder, switchable off to compare answers with and without it. */
vi.mock("@/lib/api-refusals.server", async (orig) => {
  const actual = await orig<typeof import("./api-refusals.server")>();
  return {
    ...actual,
    recordRefusal: (...args: Parameters<typeof actual.recordRefusal>) =>
      h.recorderOff ? Promise.resolve(args[3]) : actual.recordRefusal(...args),
  };
});

import { Route as TemplateRoute } from "../routes/api/v1/messages/template";
import { Route as SessionRoute } from "../routes/api/v1/messages/session";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (r: unknown) =>
  (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

const SECRET_PARAM = "Priya-SECRET-param";
const B64 = Buffer.from(PDF).toString("base64");
const invoice = (extra: Record<string, unknown> = {}) => ({
  to: "+919876543210",
  template_name: "invoice_ready",
  document: { base64: B64, filename: "INV-1.pdf" },
  body_params: [SECRET_PARAM, "INV-1", "₹2,500.00"],
  cc: [],
  ...extra,
});

async function call(
  route: unknown,
  path: string,
  body: unknown,
  opts: { key?: string; raw?: string; headers?: Record<string, string> } = {},
) {
  const res = await post(route)({
    request: new Request(`https://aidwar.in${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.key ?? h.world!.keys.a}`,
        "content-type": "application/json",
        ...(opts.headers ?? {}),
      },
      body: opts.raw ?? JSON.stringify(body),
    }),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, text: await res.text(), headers };
}
const template = (body: unknown, opts?: Parameters<typeof call>[3]) =>
  call(TemplateRoute, "/api/v1/messages/template", body, opts);
const session = (body: unknown, opts?: Parameters<typeof call>[3]) =>
  call(SessionRoute, "/api/v1/messages/session", body, opts);
const refusals = () => h.world!.db.rows("api_refusals");

beforeEach(() => {
  h.world = publicApiWorld();
  h.recorderOff = false;
  h.insertThrows = false;
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  vi.stubGlobal("fetch", fakeFetch([metaRoutes({})]).impl);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Each refusal the send can answer, made through the real route. */
const CASES: Array<{
  code: string;
  status: number;
  make: () => ReturnType<typeof call>;
  template?: string | null;
  field?: string;
}> = [
  {
    code: "invalid_phone",
    status: 400,
    make: () => template(invoice({ to: "12345" })),
    field: "to",
  },
  {
    code: "invalid_phone",
    status: 400,
    make: () => template(invoice({ cc: ["+918121310333", "91218"], idempotency_key: "cc-bad" })),
    field: "cc[1]",
  },
  { code: "invalid_cc", status: 400, make: () => template(invoice({ cc: "+918121310333" })) },
  {
    code: "template_not_found",
    status: 400,
    make: () => template(invoice({ template_name: "nope" })),
    template: "nope",
  },
  {
    code: "template_not_approved",
    status: 400,
    make: () => template(invoice({ template_name: "invoice_pending" })),
    template: "invoice_pending",
  },
  {
    code: "param_count_mismatch",
    status: 400,
    make: () => template(invoice({ body_params: [SECRET_PARAM, "INV-1"] })),
  },
  {
    code: "document_unreachable",
    status: 400,
    make: () =>
      template(
        invoice({
          document: {
            url: "https://files.example.com/inv.pdf?token=SECRET-TOKEN",
            filename: "x.pdf",
          },
        }),
      ),
  },
  {
    code: "invalid_json",
    status: 400,
    make: () => template(null, { raw: "{nope" }),
    template: null,
  },
  {
    code: "invalid_template_name",
    status: 400,
    make: () => template(invoice({ template_name: "" })),
    template: null,
  },
];

describe("each refusal is recorded once, with its reason", () => {
  for (const c of CASES)
    it(`${c.status} ${c.code}${c.field ? ` (${c.field})` : ""}`, async () => {
      const res = await c.make();
      expect(res.status).toBe(c.status);
      const answer = JSON.parse(res.text) as { code: string; error: string };
      expect(answer.code).toBe(c.code);
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]).toMatchObject({
        organization_id: ORG,
        api_key_id: "key-a",
        source: "api",
        endpoint: "template",
        http_status: c.status,
        error_code: c.code,
        reason: refusalReason(answer.error),
        template_name: c.template === undefined ? "invoice_ready" : c.template,
        field: c.field ?? null,
      });
    });

  it("429 rate_limited and 403 public_api_disabled (the key is known) are recorded; 401 never is", async () => {
    h.world!.rate.windows.set("key:key-a", 10_000);
    expect((await template(invoice())).status).toBe(429);
    h.world!.rate.windows.clear();
    h.world!.flags.on = false;
    expect((await template(invoice())).status).toBe(403);
    h.world!.flags.on = true;
    expect((await template(invoice(), { key: "adw_live_nope" })).status).toBe(401);
    expect((await template(invoice(), { key: h.world!.keys.revoked })).status).toBe(401);
    expect(refusals().map((r) => [r["http_status"], r["error_code"]])).toEqual([
      [429, "rate_limited"],
      [403, "public_api_disabled"],
    ]);
  });

  it("the session endpoint: 409 window_closed is recorded with no template", async () => {
    const res = await session({ to: "+919876543210", type: "text", text: "Hi" });
    expect(res.status).toBe(409);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({
      endpoint: "session",
      http_status: 409,
      error_code: "window_closed",
      template_name: null,
      to_received: "+919876543210",
    });
  });

  it("a 202, a 502 whatsapp_rejected (a messages row exists) and an idempotent replay are never recorded", async () => {
    expect((await template(invoice({ idempotency_key: "ok-1" }))).status).toBe(202);
    expect(
      (await template(invoice({ idempotency_key: "ok-1" }))).headers["idempotent-replayed"],
    ).toBe("true");
    h.world = publicApiWorld();
    vi.stubGlobal(
      "fetch",
      fakeFetch([metaRoutes({ sendError: { message: "(#131026) undeliverable", code: 131026 } })])
        .impl,
    );
    const rejected = await template(invoice({ idempotency_key: "rej-1" }));
    expect(rejected.status).toBe(502);
    expect(
      (await template(invoice({ idempotency_key: "rej-1" }))).headers["idempotent-replayed"],
    ).toBe("true");
    expect(refusals()).toHaveLength(0);
  });

  it("the same refused request retried with the same key is one row; a different key is another", async () => {
    await template(invoice({ to: "12345", idempotency_key: "inv-9" }));
    await template(invoice({ to: "12345", idempotency_key: "inv-9" }));
    await template(invoice({ to: "12345" }), { headers: { "idempotency-key": "inv-9" } });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({
      idempotency_key: "inv-9",
      dedupe_key: "template:inv-9:invalid_phone",
    });
    await template(invoice({ to: "12345", idempotency_key: "inv-10" }));
    expect(refusals()).toHaveLength(2);
  });
});

describe("nothing secret is stored", () => {
  it("no API key, Authorization header, body_params values or document link / bytes", async () => {
    for (const c of CASES) await c.make();
    await template(invoice({ to: "123456789012345678901234567890123456789" }));
    const stored = JSON.stringify(refusals());
    for (const secret of [
      h.world!.keys.a,
      "Bearer",
      SECRET_PARAM,
      "SECRET-TOKEN",
      "files.example.com",
      B64.slice(0, 24),
    ])
      expect(stored, secret).not.toContain(secret);
    expect(refusals().every((r) => String(r["to_received"] ?? "").length <= 32)).toBe(true);
    expect(Object.keys(refusals()[0]!).sort()).toEqual(
      [
        "api_key_id",
        "created_at",
        "dedupe_key",
        "endpoint",
        "error_code",
        "field",
        "http_status",
        "id",
        "idempotency_key",
        "organization_id",
        "reason",
        "source",
        "template_name",
        "to_received",
        "updated_at",
      ].filter((k) => k in refusals()[0]!),
    );
    expect(refusals()[0]).not.toHaveProperty("body_params");
  });

  it("refusalRow keeps only the listed fields and strips links", () => {
    const row = refusalRow({
      organizationId: ORG,
      keyId: "k",
      endpoint: "template",
      status: 400,
      replayed: false,
      answer: {
        code: "document_unreachable",
        error: "We couldn't download `document.url` (https://x.example.com/a.pdf?sig=abc).",
      },
      request: {
        to: "+91 98765 43210",
        template_name: "t",
        body_params: ["secret"],
        document: { url: "https://x" },
      },
      idempotencyHeader: null,
    })!;
    expect(row.reason).toBe("We couldn't download `document.url` ([link]");
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(refusalRow({ ...baseInput(), status: 202 })).toBeNull();
    expect(refusalRow({ ...baseInput(), replayed: true })).toBeNull();
    expect(
      refusalRow({ ...baseInput(), answer: { code: "whatsapp_rejected", message_id: "m" } }),
    ).toBeNull();
    expect(refusalRow({ ...baseInput(), answer: { code: "idempotency_in_progress" } })).toBeNull();
  });
});

function baseInput() {
  return {
    organizationId: ORG,
    keyId: "k",
    endpoint: "template" as const,
    status: 400,
    replayed: false,
    answer: { code: "invalid_phone", error: "x" } as Record<string, unknown>,
    request: {},
    idempotencyHeader: null,
  };
}

describe("the API's answer is byte-identical with the recorder on, off, or failing", () => {
  const run = async () => {
    const out: Array<{ status: number; text: string; headers: Record<string, string> }> = [];
    for (const c of CASES) out.push(await c.make());
    h.world!.rate.windows.set("key:key-a", 10_000);
    out.push(await template(invoice()));
    h.world!.rate.windows.clear();
    out.push(await session({ to: "+919876543210", type: "text", text: "Hi" }));
    out.push(await template(invoice({ idempotency_key: "fine" })));
    return out.map((r) => ({
      ...r,
      text: r.text
        .replace(/"message_id":"[^"]+"/, '"message_id":"…"')
        // the fake Meta's counter runs on across the three worlds
        .replace(/"wamid":"[^"]+"/, '"wamid":"…"'),
    }));
  };

  it("on vs off vs the insert throwing", async () => {
    const on = await run();
    expect(refusals().length).toBeGreaterThan(5);

    h.world = publicApiWorld();
    h.recorderOff = true;
    const off = await run();
    expect(refusals()).toHaveLength(0);

    h.world = publicApiWorld();
    h.recorderOff = false;
    h.insertThrows = true;
    const failing = await run();

    expect(on).toEqual(off);
    expect(failing).toEqual(off);
  });
});
