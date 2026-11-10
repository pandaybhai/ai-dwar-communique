import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeFetch,
  metaRoutes,
  ORG,
  PDF,
  publicApiWorld,
  type FetchCall,
} from "./test-support/public-api-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";
import {
  apiPhoneError,
  apiPhoneNumber,
  ccNumber,
  copyIdempotencyKey,
  parseCcNumbers,
  storedCcNumbers,
} from "./public-api-cc";
import { normalizePhone, toWaId } from "./phone";
import { API_ERRORS } from "./public-api";
import { API_ENDPOINTS } from "./public-api-spec";

/**
 * Batch 65 — the Public API refuses a phone number without its country code.
 * `to` on POST /api/v1/messages/template and /api/v1/messages/session, and a
 * request's own `cc`, go through apiPhoneNumber (public-api-cc.ts): "+" or
 * "00" then 8–15 digits, or 11–15 digits; 10 or fewer digits without a
 * prefix, or a leading 0, is 400 invalid_phone naming the field, before
 * anything is sent or reserved. Everything valid before with its country
 * code is byte-identical: the E.164 string, the idempotency fingerprint
 * (checked against hashes recorded on main before this batch), the copies'
 * keys and the rate-limit count. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as TemplateRoute } from "../routes/api/v1/messages/template";
import { Route as SessionRoute } from "../routes/api/v1/messages/session";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (r: unknown) =>
  (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

const ACCEPTED: Array<[string, string]> = [
  ["+919876543210", "919876543210"],
  ["919876543210", "919876543210"],
  ["00919876543210", "919876543210"],
  ["+91 98765 43210", "919876543210"],
  ["+91-98765-43210", "919876543210"],
  ["+6591234567", "6591234567"],
  ["+18133043903", "18133043903"],
];
// Batch 66: a 10-digit number (or 0 + 10 digits) now gets the workspace's default
// country code (batch66-phone.test.ts); what is still refused is too short or too long.
const REFUSED = ["12345", "+91 98765", "9198765432101234"];

/** Recorded on main before Batch 65 (the same requests, the same fakes). */
const MAIN = {
  templateHash: "4ed7799fe403422f627a489c2361a4fc6fc6acce004bc2a599b1786e02340b31",
  copyHashes: {
    "inv-919876543210:cc:+918121310333":
      "e7b37842f58adc7f35d40d51d30db6f50fa46e2f1a175a664527000ee41b6171",
    "inv-919876543210:cc:+919121883067":
      "e3ba96db4cb896feaa84c2985581ba49f9604456d68f035a5a5ac797cf4fd88c",
  },
  sessionHash: "103ea29397d18c02c26b5bdc7293c5ae82201e67c66f05c3d1eb4f08187eb527",
  /** Rate-limit units after the six calls below: 3 + 1 + 1 template, 1 + 1 + 1 session. */
  rateUnits: 8,
};

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };
const rows = (t: string) => h.world!.db.rows(t);
const sends = () =>
  net.calls.filter(
    (c) => c.url.startsWith("https://graph.facebook.com/") && c.url.endsWith("/messages"),
  );
const sentTo = (c: FetchCall) => (JSON.parse(String(c.body)) as { to: string }).to;

async function call(route: unknown, path: string, body: unknown) {
  const res = await post(route)({
    request: new Request(`https://aidwar.in${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.world!.keys.a}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    body: (await res.json()) as Record<string, unknown>,
  };
}
const invoice = (extra: Record<string, unknown> = {}) => ({
  to: "+919876543210",
  template_name: "invoice_ready",
  document: { base64: Buffer.from(PDF).toString("base64"), filename: "ZADM2611A002.pdf" },
  body_params: ["Asha", "ZADM2611A002", "₹2,500.00"],
  ...extra,
});
const template = (body: unknown) => call(TemplateRoute, "/api/v1/messages/template", body);
const session = (body: unknown) => call(SessionRoute, "/api/v1/messages/session", body);

function windowOpen() {
  rows("contacts").push({
    id: "c-1",
    organization_id: ORG,
    phone: "+919876543210",
    wa_id: "919876543210",
    opt_in_status: "unknown",
  });
  rows("conversations").push({
    id: "conv-1",
    organization_id: ORG,
    contact_id: "c-1",
    whatsapp_account_id: "acc-a",
    status: "open",
    last_customer_message_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  h.world = publicApiWorld();
  meta.sendError = null;
  meta.uploadError = false;
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  net = fakeFetch([metaRoutes(meta)]);
  vi.stubGlobal("fetch", net.impl);
});
afterEach(() => vi.unstubAllGlobals());

describe("the rule", () => {
  it("accepts + / 00 with 8–15 digits and 11–15 bare digits; refuses ≤10 bare digits, a leading 0, too short or too long", () => {
    for (const [input, digits] of ACCEPTED) expect(apiPhoneNumber(input), input).toBe(`+${digits}`);
    for (const input of REFUSED) expect(apiPhoneNumber(input), input).toBeNull();
    expect(apiPhoneNumber(919876543210)).toBe("+919876543210"); // a JSON number
    expect(apiPhoneNumber("(+91) 98765.43210")).toBe("+919876543210");
    expect(apiPhoneNumber("6591234567")).toBeNull(); // no default code given: not guessed
    expect(apiPhoneNumber("")).toBeNull();
    expect(apiPhoneNumber(null)).toBeNull();
  });

  it("ZOORI's form (91XXXXXXXXXX, 12 digits, no +) is accepted unchanged", () => {
    expect(apiPhoneNumber("919876543210")).toBe(normalizePhone("919876543210"));
  });

  it("every number valid before with its country code gives exactly today's E.164 string (contact lookups, the Batch 63 warning, cc dedupe)", () => {
    let n = 0;
    for (let len = 8; len <= 15; len += 1)
      for (const first of "123456789")
        for (const fmt of [
          (d: string) => `+${d}`,
          (d: string) => `+${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`,
          (d: string) => d,
          (d: string) => `${d.slice(0, 2)} ${d.slice(2)}`,
        ]) {
          const digits = (first + "8765432109876543").slice(0, len);
          const input = fmt(digits);
          const before = toWaId(input).length >= 8 ? normalizePhone(input) : null;
          const now = apiPhoneNumber(input);
          // Bare digits ≤ 10 are the numbers without a country code: refused now.
          if (!input.startsWith("+") && len <= 10) expect(now, input).toBeNull();
          else {
            expect(now, input).toBe(before);
            expect(now, input).toBe(ccNumber(input));
            n += 1;
          }
        }
    expect(n).toBeGreaterThan(200);
  });

  it("the stored-number rule (ccNumber, the Settings default) is unchanged", () => {
    expect(ccNumber("9876543210")).toBe("+9876543210");
    expect(storedCcNumbers(["9876543210", "+918121310333"])).toEqual([
      "+9876543210",
      "+918121310333",
    ]);
    expect(parseCcNumbers(["9876543210"])).toEqual({ ok: true, numbers: ["+9876543210"] });
  });

  it("invalid_phone is in the error table, the send endpoints' errors and the docs' words", () => {
    expect(API_ERRORS.find((r) => r.status === "400")!.codes).toContain("invalid_phone");
    for (const id of ["send-template", "send-session"])
      expect(API_ENDPOINTS.find((e) => e.id === id)!.errors, id).toContain("invalid_phone");
    expect(apiPhoneError("cc[1]", "12345")).toEqual({
      error:
        "`cc[1]` isn't a WhatsApp number we can send to (too short: needs 10 digits, or + and the country code). Write it with the country code, e.g. +919876543210. Nothing was sent.",
      code: "invalid_phone",
      field: "cc[1]",
    });
  });
});

describe("POST /api/v1/messages/template", () => {
  it("each accepted number goes to WhatsApp as its full number", async () => {
    for (const [i, [input, digits]] of ACCEPTED.entries()) {
      const res = await template(invoice({ to: input, idempotency_key: `ok-${i}` }));
      expect(res.status, input).toBe(202);
      expect(sentTo(sends().at(-1)!), input).toBe(digits);
    }
  });

  it("each refused number: 400 invalid_phone naming `to`, nothing sent, nothing stored, and the same key then sends once fixed", async () => {
    for (const [i, input] of REFUSED.entries()) {
      const res = await template(invoice({ to: input, idempotency_key: `inv-fix-${i}` }));
      expect([res.status, res.body["code"], res.body["field"]], input).toEqual([
        400,
        "invalid_phone",
        "to",
      ]);
      expect(String(res.body["error"])).toContain(
        "Write it with the country code, e.g. +919876543210.",
      );
    }
    expect(sends()).toHaveLength(0);
    expect(rows("api_requests")).toHaveLength(0);
    expect(rows("messages")).toHaveLength(0);
    const fixed = await template(invoice({ to: "+919876543210", idempotency_key: "inv-fix-0" }));
    expect(fixed.status).toBe(202);
    expect(fixed.replayed).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it("cc with one bad number refuses the whole request, naming cc[n]", async () => {
    const res = await template(
      invoice({ cc: ["+918121310333", "91218"], idempotency_key: "inv-cc" }),
    );
    expect(res).toMatchObject({
      status: 400,
      body: { code: "invalid_phone", field: "cc[1]" },
    });
    expect(sends()).toHaveLength(0);
    expect(rows("api_requests")).toHaveLength(0);
    const fixed = await template(
      invoice({ cc: ["+918121310333", "919121883067"], idempotency_key: "inv-cc" }),
    );
    expect(fixed.status).toBe(202);
    expect(sends().map(sentTo)).toEqual(["919876543210", "918121310333", "919121883067"]);
  });

  it("the stored default copy numbers keep their own reading (a bare 10-digit default still copies, as before)", async () => {
    rows("organizations").find((r) => r["id"] === ORG)!["api_cc_numbers"] = ["9121883067"];
    const res = await template(invoice({ idempotency_key: "inv-default" }));
    expect(res.status).toBe(202);
    expect(sends().map(sentTo)).toEqual(["919876543210", "9121883067"]);
  });
});

describe("POST /api/v1/messages/session: the same rule, nothing else", () => {
  it("accepted numbers send; refused ones are invalid_phone with nothing sent or stored", async () => {
    windowOpen();
    for (const [i, [input]] of ACCEPTED.filter(([, d]) => d === "919876543210").entries()) {
      const res = await session({ to: input, type: "text", text: "Hi", idempotency_key: `s-${i}` });
      expect(res.status, input).toBe(202);
      expect(sentTo(sends().at(-1)!)).toBe("919876543210");
    }
    const before = sends().length;
    const stored = rows("api_requests").length;
    for (const input of REFUSED) {
      const res = await session({ to: input, type: "text", text: "Hi", idempotency_key: "s-bad" });
      expect([res.status, res.body["code"], res.body["field"]], input).toEqual([
        400,
        "invalid_phone",
        "to",
      ]);
    }
    expect(sends()).toHaveLength(before);
    expect(rows("api_requests")).toHaveLength(stored);
    const fixed = await session({
      to: "919876543210",
      type: "text",
      text: "Hi",
      idempotency_key: "s-bad",
    });
    expect(fixed.status).toBe(202);
  });
});

describe("byte-identical for valid requests (recorded on main before Batch 65)", () => {
  async function theSixCalls() {
    windowOpen();
    for (const to of ["+919876543210", "919876543210", "+91 98765-43210"]) {
      await template(
        invoice({
          to,
          cc: ["+918121310333", "91 9121883067"],
          idempotency_key: `inv-${to.replace(/\D/g, "")}`,
        }),
      );
      await session({
        to,
        type: "text",
        text: "Hi",
        idempotency_key: `ship-${to.replace(/\D/g, "")}`,
      });
    }
  }

  it("the same idempotency fingerprints, copy keys and rate-limit count as main", async () => {
    await theSixCalls();
    const stored = Object.fromEntries(
      rows("api_requests").map((r) => [String(r["idempotency_key"]), r["request_hash"]]),
    );
    expect(stored).toEqual({
      "inv-919876543210": MAIN.templateHash,
      ...MAIN.copyHashes,
      "ship-919876543210": MAIN.sessionHash,
    });
    expect(copyIdempotencyKey("inv-919876543210", "+918121310333")).toBe(
      "inv-919876543210:cc:+918121310333",
    );
    expect([...h.world!.rate.windows.values()]).toEqual([MAIN.rateUnits, MAIN.rateUnits]);
    expect(sends().map(sentTo)).toEqual([
      "919876543210",
      "918121310333",
      "919121883067",
      "919876543210",
    ]);
  });

  it("a key stored by the old code replays after this deploy: no second message", async () => {
    windowOpen();
    const old = (key: string, hash: string, response: Record<string, unknown>) =>
      rows("api_requests").push({
        id: `old-${key}`,
        organization_id: ORG,
        api_key_id: "key-a",
        idempotency_key: key,
        request_hash: hash,
        state: "done",
        http_status: 202,
        response,
        message_id: "m-old",
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
    const firstAnswer = {
      message_id: "m-old",
      status: "queued",
      wamid: "wamid.old",
      idempotency_key: "inv-919876543210",
    };
    old("inv-919876543210", MAIN.templateHash, firstAnswer);
    old("ship-919876543210", MAIN.sessionHash, {
      ...firstAnswer,
      idempotency_key: "ship-919876543210",
    });
    const t = await template(
      invoice({
        to: "919876543210",
        cc: ["+918121310333", "91 9121883067"],
        idempotency_key: "inv-919876543210",
      }),
    );
    expect(t).toMatchObject({ status: 202, replayed: "true", body: firstAnswer });
    const s = await session({
      to: "+91 98765-43210",
      type: "text",
      text: "Hi",
      idempotency_key: "ship-919876543210",
    });
    expect(s).toMatchObject({ status: 202, replayed: "true" });
    expect(sends()).toHaveLength(0);
  });
});
