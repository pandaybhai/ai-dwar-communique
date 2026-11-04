import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  fakeFetch,
  metaRoutes,
  ORG,
  PDF,
  publicApiWorld,
  type FetchCall,
} from "./test-support/public-api-world";

/**
 * Batch 64 — the API docs' gaps a real integrator (a billing app sending
 * invoices) hit: resending, accepted vs delivered, WhatsApp's own errors,
 * retrying, template value rules, phone numbers, PDF rules and the invoice
 * recipe. Docs only: these tests hold every code, event, number and rule the
 * docs name to the server's own code, and run the claims through the real
 * send route (fakes only: Meta is a fake fetch, the database is in memory).
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/messages/template";
import {
  ALL_WEBHOOK_EVENTS,
  API_ERRORS,
  IDEMPOTENCY_WINDOW_HOURS,
  MAX_DOCUMENT_MB,
  RATE_PER_KEY_PER_MIN,
} from "./public-api";
import {
  FAILED_DELIVERY_EXAMPLE,
  FAILED_STATUS_EXAMPLE,
  FILENAME_EXAMPLES,
  INVOICE_KEY,
  INVOICE_RECIPE_BODY,
  INVOICE_RECIPE_NODE,
  INVOICE_RESEND_BODY,
  META_ERROR_CODES_URL,
  PHONE_EXAMPLES,
  RETRY_WAITS_SECONDS,
  WHATSAPP_ERRORS,
  allPages,
  errorCodes,
  guidePath,
  llmsFullTxt,
  pageByPath,
  pageMarkdown,
  whatToDo,
  DOCS_ROOT,
} from "./developer-portal";
import { API_ENDPOINTS, WEBHOOK_EVENTS, errorRow } from "./public-api-spec";
import { MAX_REQUEST_BYTES, cleanFilename, parseSendRequest } from "./public-api-send.server";
import { TEST_EVENT, webhookBody } from "./public-api-webhooks.server";
import { copyIdempotencyKey } from "./public-api-cc";
import { normalizePhone, toWaId } from "./phone";
import { UNREACHABLE_WARNING, UNREACHABLE_WARN_DAYS, failureReason } from "./wa-reachability";
import { classifyGraphAnswer } from "./campaign-dispatch.server";
import { MEDIA_FETCH_TIMEOUT_MS } from "./public-api-media.server";
import { MAX_REDIRECTS, clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";

const run = promisify(execFile);
const NEW_GUIDES = [
  "send-every-invoice-automatically",
  "know-it-was-delivered",
  "whatsapp-errors",
  "numbers-values-and-files",
];
const API_CODES = new Set(API_ERRORS.flatMap((r) => r.codes));
const md = (slug: string) => pageMarkdown(pageByPath(guidePath(slug))!);

/** Every key anywhere in a value (request bodies, answers, payloads). */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

/** Field and payload names the docs may quote in `backticks` (they aren't error codes). */
function knownNames(): Set<string> {
  const names = new Set<string>();
  for (const e of API_ENDPOINTS) {
    keysOf([e.body, e.more?.map((m) => m.body), e.response.body, e.responses], names);
    for (const f of e.fields ?? []) names.add(f.name.split(/[.[]/)[0]!);
    for (const q of e.query ?? []) names.add(q.name);
  }
  for (const ev of WEBHOOK_EVENTS) keysOf(ev.example, names);
  keysOf([FAILED_DELIVERY_EXAMPLE, FAILED_STATUS_EXAMPLE, INVOICE_RECIPE_BODY], names);
  // Template names the examples send.
  for (const e of API_ENDPOINTS)
    for (const b of [e.body, ...(e.more ?? []).map((m) => m.body)])
      if (typeof b?.["template_name"] === "string") names.add(b["template_name"]);
  // Words the server writes that no example shows: a copy's status (CopyResult), a
  // copy's payload / status field (webhookBody, apiMessageStatus) and the 403 body's field.
  for (const w of ["not_sent", "cc_of", "plan_needed"]) names.add(w);
  return names;
}

describe("every error code and webhook event the docs name exists in the code", () => {
  const text = llmsFullTxt();

  it("every `snake_case` word is an error code the server answers with, or a real field name", () => {
    const fields = knownNames();
    const unknown = new Set<string>();
    for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      const word = m[1]!;
      if (!API_CODES.has(word) && !fields.has(word) && word !== UNREACHABLE_WARNING)
        unknown.add(word);
    }
    expect([...unknown]).toEqual([]);
  });

  it("every “<status> <code>” the docs write is that code's real status", () => {
    const seen: string[] = [];
    for (const m of text.matchAll(/\b([1-5]\d\d)(?:\*\*)?\s+`?([a-z]+(?:_[a-z]+)+)\b/g)) {
      const [, status, code] = m as unknown as [string, string, string];
      if (!API_CODES.has(code)) continue; // "400 characters"-style words have no underscore; field names aren't codes
      const row = errorRow(code)!;
      expect(row.status === status || (row.status === "5xx" && status.startsWith("5")), code).toBe(
        true,
      );
      seen.push(code);
    }
    // The new pages name these with their status.
    for (const c of [
      "whatsapp_rejected",
      "idempotency_key_reused",
      "invalid_to",
      "invalid_body_params",
      "param_count_mismatch",
      "document_not_pdf",
      "document_too_large",
      "request_too_large",
      "window_closed",
    ])
      expect(seen, c).toContain(c);
  });

  it("every webhook event named is one a webhook can receive", () => {
    const events = new Set<string>([...ALL_WEBHOOK_EVENTS, TEST_EVENT]);
    // A payload's dotted field names (contact.phone, template.status…) aren't events.
    const paths = new Set<string>();
    const walk = (v: unknown, prefix: string) => {
      if (v && typeof v === "object" && !Array.isArray(v))
        for (const [k, x] of Object.entries(v)) {
          paths.add(`${prefix}${k}`);
          walk(x, `${prefix}${k}.`);
        }
    };
    for (const ev of WEBHOOK_EVENTS) walk(ev.example, "");
    const named = new Set<string>();
    for (const m of text.matchAll(
      /\b(?:message|contact|template|campaign|phone_number|account|messaging_limit|webhook)\.[a-z_]+\b/g,
    ))
      if (!paths.has(m[0])) named.add(m[0]);
    expect([...named].filter((n) => !events.has(n))).toEqual([]);
    for (const e of ["message.sent", "message.delivered", "message.read", "message.failed"])
      expect(md("know-it-was-delivered"), e).toContain(e);
  });

  it("every WhatsApp error code named is in the table, and each one is a code our code knows", () => {
    const table = new Set(WHATSAPP_ERRORS.map((e) => e.code));
    for (const m of text.matchAll(/\b13\d{4}\b/g)) expect(table, m[0]).toContain(m[0]);
    expect([...table].sort()).toEqual(
      ["130429", "131026", "131047", "131049", "131053", "131056", "132000", "132001"].sort(),
    );
    for (const e of WHATSAPP_ERRORS) {
      // Known to the failure wording (the Sent report, the reachability mark)…
      const reason = failureReason(JSON.stringify({ code: Number(e.code) }));
      // …or to the sender's throughput handling.
      const verdict = classifyGraphAnswer({
        kind: "response",
        ok: false,
        status: 400,
        body: { error: { code: Number(e.code) } },
      });
      expect(reason !== "Not delivered" || verdict.kind === "throttled", e.code).toBe(true);
      for (const c of e.ours) expect(API_CODES, `${e.code} → ${c}`).toContain(c);
    }
    expect(md("whatsapp-errors")).toContain(META_ERROR_CODES_URL);
  });

  it("the failed-delivery examples have exactly the fields the server writes", () => {
    const built = webhookBody({
      event: "message.failed",
      messageId: "m",
      idempotencyKey: "k",
      to: "+1",
      error: { code: "131026", message: "x" },
      occurredAt: "2026-11-04T10:00:04.000Z",
    });
    expect(Object.keys(FAILED_DELIVERY_EXAMPLE).sort()).toEqual(Object.keys(built).sort());
    expect(FAILED_DELIVERY_EXAMPLE.status).toBe(built["status"]);
    const statusEndpoint = API_ENDPOINTS.find((e) => e.id === "message-status")!;
    expect(Object.keys(FAILED_STATUS_EXAMPLE).sort()).toEqual(
      Object.keys(statusEndpoint.response.body as object).sort(),
    );
  });

  it("each new page is listed in the sidebar's guides and says what the code does", () => {
    for (const slug of NEW_GUIDES) expect(pageByPath(guidePath(slug)), slug).not.toBeNull();
    const rules = md("numbers-values-and-files");
    expect(rules).toContain(`${MEDIA_FETCH_TIMEOUT_MS / 1000} seconds`);
    expect(rules).toContain(`up to ${MAX_REDIRECTS} redirects`);
    expect(rules).toContain(`up to ${MAX_REQUEST_BYTES / 1024 / 1024} MB`);
    expect(rules).toContain(`up to ${MAX_DOCUMENT_MB} MB`);
    expect(md("whatsapp-errors")).toContain(`for ${UNREACHABLE_WARN_DAYS} days`);
    expect(md("whatsapp-errors")).toContain(`${RATE_PER_KEY_PER_MIN} requests a minute`);
    const idem = pageMarkdown(pageByPath(`${DOCS_ROOT}/idempotency`)!);
    expect(idem).toContain(`within ${IDEMPOTENCY_WINDOW_HOURS} hours never sends again`);
    expect(idem).toContain(copyIdempotencyKey(`${INVOICE_KEY}-r1`, "+918000000001"));
    const retry = pageMarkdown(pageByPath(guidePath("handle-errors-and-retries"))!);
    expect(retry).toContain(RETRY_WAITS_SECONDS.map((s) => `${s} s`).join(", then "));
    // whatsapp_rejected's own advice: never the generic "retry with the same key".
    expect(whatToDo("5xx", "whatsapp_rejected")).toContain("new key");
    expect(errorCodes({ status: "5xx" })).toContain("whatsapp_rejected");
  });

  it("no new page names an internal word, and every page still renders to Markdown", () => {
    for (const p of allPages()) expect(pageMarkdown(p).length, p.path).toBeGreaterThan(20);
    for (const slug of NEW_GUIDES)
      expect(md(slug)).not.toMatch(/\bbatch\s*\d|supabase|lovable|\bvault\b|graph\.facebook/i);
  });
});

// ------------------------------------------------------------ the claims, through the real route

type Handler = (a: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers["POST"]!;

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };

async function send(body: unknown) {
  const res = await POST({
    request: new Request("https://aidwar.in/api/v1/messages/template", {
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
const sends = () =>
  net.calls.filter(
    (c) => c.url.startsWith("https://graph.facebook.com/") && c.url.endsWith("/messages"),
  );
const sentTo = (c: FetchCall) => (JSON.parse(String(c.body)) as { to: string }).to;

/** The recipe's invoice, as the test world's document template and a base64 PDF. */
const invoice = (extra: Record<string, unknown> = {}) => ({
  ...INVOICE_RECIPE_BODY,
  template_name: "invoice_ready",
  document: { base64: Buffer.from(PDF).toString("base64"), filename: "ZADM2611A002.pdf" },
  cc: [],
  ...extra,
});

describe("what the docs say, the route does", () => {
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

  it("resending: the same key replays, a new key (-r1) sends, a changed body is idempotency_key_reused, after 24 h the key sends again", async () => {
    const first = await send(invoice());
    expect(first.status).toBe(202);
    const again = await send(invoice());
    expect(again).toMatchObject({ status: 202, replayed: "true", body: first.body });
    expect(sends()).toHaveLength(1);

    const changed = await send(invoice({ body_params: ["Asha", "ZADM2611A002", "₹2,600.00"] }));
    expect(changed).toMatchObject({ status: 409, body: { code: "idempotency_key_reused" } });
    expect(sends()).toHaveLength(1);

    const resend = await send(invoice({ idempotency_key: INVOICE_RESEND_BODY["idempotency_key"] }));
    expect(resend.status).toBe(202);
    expect(resend.body["message_id"]).not.toBe(first.body["message_id"]);
    expect(sends()).toHaveLength(2);

    const row = h.world!.db.rows("api_requests").find((r) => r["idempotency_key"] === INVOICE_KEY)!;
    row["created_at"] = new Date(
      Date.now() - (IDEMPOTENCY_WINDOW_HOURS + 1) * 3600_000,
    ).toISOString();
    const later = await send(invoice());
    expect(later.status).toBe(202);
    expect(later.replayed).toBeNull();
    expect(sends()).toHaveLength(3);
  });

  it("a 502 whatsapp_rejected is final for its key: the same key gives it back, a new key sends", async () => {
    meta.sendError = { message: "(#131026) Message undeliverable", code: 131026 };
    const refused = await send(invoice());
    expect(refused).toMatchObject({
      status: 502,
      body: { code: "whatsapp_rejected", status: "failed" },
    });
    meta.sendError = null;
    const same = await send(invoice());
    expect(same).toMatchObject({ status: 502, replayed: "true" });
    expect(sends()).toHaveLength(1); // only the first, refused, call reached WhatsApp
    const fresh = await send(invoice({ idempotency_key: `${INVOICE_KEY}-r1` }));
    expect(fresh.status).toBe(202);
    expect(sends()).toHaveLength(2);
  });

  it("phone numbers: each documented input goes where the docs say, or is refused with invalid_to", async () => {
    for (const [i, p] of PHONE_EXAMPLES.entries()) {
      const before = sends().length;
      const res = await send(invoice({ to: p.input, idempotency_key: `phone-${i}` }));
      if (p.sentTo === null) {
        expect(res.body["code"], p.input).toBe("invalid_to");
        expect(res.status).toBe(400);
        expect(sends()).toHaveLength(before);
      } else {
        expect(res.status, p.input).toBe(202);
        expect(sentTo(sends().at(-1)!), p.input).toBe(toWaId(p.sentTo));
        expect(normalizePhone(p.input)).toBe(p.sentTo);
      }
    }
  });

  it("template values: new lines, tabs, 5 spaces, empty values and a wrong count are refused; currency symbols and 1,024 characters are fine", async () => {
    const parse = (body_params: unknown[]) =>
      parseSendRequest({ ...INVOICE_RECIPE_BODY, body_params }, null);
    const code = (r: ReturnType<typeof parse>) => ("status" in r ? r.body["code"] : "ok");
    expect(code(parse(["Asha", "12 MG Road,\nPune", "₹1"]))).toBe("invalid_body_params");
    expect(code(parse(["Asha", "a\tb", "₹1"]))).toBe("invalid_body_params");
    expect(code(parse(["Asha", "a     b", "₹1"]))).toBe("invalid_body_params");
    expect(code(parse(["Asha", "a    b", "₹1"]))).toBe("ok");
    expect(code(parse(["Asha", "  ", "₹1"]))).toBe("invalid_body_params");
    expect(code(parse(["Asha", "x".repeat(1024), "₹1"]))).toBe("ok");
    expect(code(parse(["Asha", "x".repeat(1025), "₹1"]))).toBe("invalid_body_params");
    for (const money of ["₹2,500.00", "Rs. 2,500", "€45", "नमस्ते"])
      expect(code(parse(["Asha", "ZADM2611A002", money])), money).toBe("ok");
    const wrong = await send(invoice({ body_params: ["Asha", "ZADM2611A002"] }));
    expect(wrong).toMatchObject({ status: 400, body: { code: "param_count_mismatch" } });
  });

  it("files: the documented file names, a non-PDF and the recipe's bodies", async () => {
    for (const f of FILENAME_EXAMPLES) expect(cleanFilename(f.input), f.input).toBe(f.shown);
    const word = await send(
      invoice({
        document: {
          base64: Buffer.from("PK\u0003\u0004word").toString("base64"),
          filename: "x.pdf",
        },
      }),
    );
    expect(word).toMatchObject({ status: 400, body: { code: "document_not_pdf" } });
    for (const body of [INVOICE_RECIPE_BODY, INVOICE_RESEND_BODY])
      expect("status" in parseSendRequest(body, null)).toBe(false);
    expect(h.world!.db.rows("organizations").find((r) => r["id"] === ORG)).toBeTruthy();
  });
});

describe("the recipe's Node.js example, run", () => {
  it("retries a 503 with the same body and key, then reports the 202 and its warning", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        if (seen.length === 1) {
          res
            .writeHead(503, { "content-type": "application/json" })
            .end('{"error":"try again","code":"unavailable"}');
          return;
        }
        res.writeHead(202, { "content-type": "application/json" }).end(
          JSON.stringify({
            message_id: "m-1",
            status: "queued",
            wamid: "wamid.1",
            idempotency_key: INVOICE_KEY,
            warning: UNREACHABLE_WARNING,
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const dir = mkdtempSync(join(tmpdir(), "aidwar-recipe-"));
      const file = join(dir, "send-invoice.mjs");
      writeFileSync(file, INVOICE_RECIPE_NODE.replaceAll("https://aidwar.in", origin));
      const { stdout, stderr } = await run(process.execPath, [file], {
        env: {
          ...process.env,
          AIDWAR_API_KEY: "adw_live_test",
          TEST_WHATSAPP_NUMBER: "+919000000001",
        },
        timeout: 30_000,
      });
      expect(stdout).toContain("m-1 queued");
      expect(stderr).toContain("Check it with the customer");
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0]!["idempotency_key"]).toBe(INVOICE_KEY);
      expect("status" in parseSendRequest(seen[0], null)).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
