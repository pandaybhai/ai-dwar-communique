import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
  DEFAULT_COUNTRY_CODE,
  enteredPhone,
  isCountryCode,
  normalizePhone,
  phoneProblemText,
} from "./phone";
import { DEFAULT_COUNTRY_READ_ERROR, defaultCountryFrom } from "./default-country";
import {
  planImportRows,
  readImportCsv,
  runContactImport,
  addedCountryLine,
  skippedRowsLine,
} from "./contact-import";
import { apiPhoneNumber, ccNumber, storedCcNumbers } from "./public-api-cc";

/**
 * Batch 66 — one phone rule everywhere a person types or an integrator sends
 * a number (enteredPhone, phone.ts), with the workspace's default country
 * code (organizations.default_country_code, "91" until 20261360 is applied):
 * 9908109123 → +919908109123 in the import, Add contact, the Public API's
 * to / cc and the Contacts API. Every number that already had its country
 * code is exactly what it was (Batch 65's recorded hashes still hold:
 * batch65-phone.test.ts). Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));
vi.mock("@/integrations/aidwar/client", () => ({ aidwar: {} }));

import { Route as TemplateRoute } from "../routes/api/v1/messages/template";
import { Route as SessionRoute } from "../routes/api/v1/messages/session";
import { Route as ContactsRoute } from "../routes/api/v1/contacts/index";
import { Route as BulkRoute } from "../routes/api/v1/contacts/bulk";
import { Route as OneRoute } from "../routes/api/v1/contacts/$phone";
import { Route as BalanceRoute } from "../routes/api/v1/account/balance";
import { ImportPhoneCheck } from "@/components/contacts/import-phone-check";
import { addContactPhone } from "@/lib/add-contact-phone";

const ZOORI_10 = "9908109123";
const ZOORI_E164 = "+919908109123";

/** The rule table the PR body shows: input → stored (default code 91). */
const TABLE: Array<[string, string | null]> = [
  ["9908109123", ZOORI_E164],
  ["09908109123", ZOORI_E164],
  ["99081 09123", ZOORI_E164],
  ["99081-09123", ZOORI_E164],
  ["+919908109123", ZOORI_E164],
  ["919908109123", ZOORI_E164],
  ["00919908109123", ZOORI_E164],
  ["+91 99081 09123", ZOORI_E164],
  ["+6591234567", "+6591234567"],
  ["+18133043903", "+18133043903"],
  ["12345", null],
  ["990810912", null],
  ["0990810912", null],
  ["9198765432101234", null],
  ["", null],
];

describe("the rule (enteredPhone)", () => {
  it("each input becomes what the table says, with the default code 91", () => {
    for (const [input, stored] of TABLE) {
      const e = enteredPhone(input, "91");
      expect(e.ok ? e.phone : null, input).toBe(stored);
    }
    expect(enteredPhone("9908109123", "91")).toEqual({
      ok: true,
      phone: ZOORI_E164,
      addedCountry: true,
    });
    expect(enteredPhone("09908109123", "91")).toMatchObject({ addedCountry: true });
    expect(enteredPhone("919908109123", "91")).toMatchObject({ addedCountry: false });
  });

  it("a workspace with default code 1 turns 4155550123 into +14155550123", () => {
    expect(enteredPhone("4155550123", "1")).toMatchObject({ ok: true, phone: "+14155550123" });
    expect(enteredPhone("(415) 555-0123", "1")).toMatchObject({ phone: "+14155550123" });
    // A number with its code is never touched by the default.
    expect(enteredPhone("+919908109123", "1")).toMatchObject({ phone: ZOORI_E164 });
  });

  it("refused numbers say why; without a default a 10-digit number is refused, never guessed", () => {
    expect(enteredPhone("12345", "91")).toEqual({ ok: false, problem: "too_short" });
    expect(enteredPhone("9198765432101234", "91")).toEqual({ ok: false, problem: "too_long" });
    expect(enteredPhone("0990810912", "91")).toEqual({ ok: false, problem: "leading_zero" });
    expect(enteredPhone("", "91")).toEqual({ ok: false, problem: "empty" });
    expect(enteredPhone(ZOORI_10, null)).toEqual({ ok: false, problem: "needs_country" });
    expect(phoneProblemText("too_short")).toBe(
      "Too short: needs 10 digits, or + and the country code",
    );
    expect(isCountryCode("91")).toBe(true);
    for (const bad of ["+91", "091", "12345", "", "9a"]) expect(isCountryCode(bad)).toBe(false);
  });

  it("every number that already had its country code is exactly normalizePhone's (byte-identical)", () => {
    let n = 0;
    for (let len = 8; len <= 15; len += 1)
      for (const first of "123456789")
        for (const fmt of [
          (d: string) => `+${d}`,
          (d: string) => `+${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`,
          (d: string) => (d.length >= 11 ? d : `+${d}`),
        ]) {
          const input = fmt((first + "8765432109876543").slice(0, len));
          const e = enteredPhone(input, "91");
          expect(e.ok && e.phone, input).toBe(normalizePhone(input));
          expect(e.ok && e.addedCountry, input).toBe(false);
          n += 1;
        }
    expect(n).toBeGreaterThan(200);
  });

  it("stored numbers keep their own reading: a saved +E.164 default copy number is unchanged", () => {
    expect(storedCcNumbers(["+919121883067", "+9121883067"])).toEqual([
      "+919121883067",
      "+9121883067",
    ]);
    expect(ccNumber("+919121883067")).toBe("+919121883067");
    expect(apiPhoneNumber("9121883067", "91")).toBe("+919121883067");
  });
});

describe("the workspace's default code (20261360 not applied = 91)", () => {
  it("a missing column, row or value reads 91; any other failed read is an error, never a guess", () => {
    expect(
      defaultCountryFrom({
        data: null,
        error: {
          code: "42703",
          message: "column organizations.default_country_code does not exist",
        },
      }),
    ).toEqual({ code: "91" });
    expect(defaultCountryFrom({ data: null, error: { code: "PGRST204", message: "x" } })).toEqual({
      code: "91",
    });
    expect(defaultCountryFrom({ data: null, error: null })).toEqual({ code: DEFAULT_COUNTRY_CODE });
    expect(defaultCountryFrom({ data: { default_country_code: "1" }, error: null })).toEqual({
      code: "1",
    });
    expect(
      defaultCountryFrom({ data: null, error: { code: "57014", message: "statement timeout" } }),
    ).toEqual({ error: DEFAULT_COUNTRY_READ_ERROR });
  });
});

// ------------------------------------------------------------ the import

const CSV = [
  "phone,name",
  "9908109123,Asha", // + 91
  "09812345678,Ravi", // trunk 0 → + 91
  "99081 09124,Meena", // spaces → + 91
  "+919876543210,Priya", // unchanged
  "919876543211,Rahul", // unchanged
  "+6591234567,Mei", // unchanged
  "12345,Too short",
  "+919908109123,Asha again", // the same number as row 2
  ",No phone",
].join("\n");

describe("the import (preview and commit share one plan)", () => {
  const parsed = readImportCsv(CSV)!;

  it("the plan: +91 added to 3 numbers, every number with a code unchanged, skipped rows with their reasons", () => {
    const plan = planImportRows(parsed.rows, parsed.mapping, "91");
    expect(plan.rows.map((r) => r.phone)).toEqual([
      ZOORI_E164,
      "+919812345678",
      "+919908109124",
      "+919876543210",
      "+919876543211",
      "+6591234567",
    ]);
    expect(plan.addedCountry).toBe(3);
    expect(plan.errors).toEqual([
      { row: 8, phone: "12345", reason: "Too short: needs 10 digits, or + and the country code" },
      { row: 9, phone: ZOORI_E164, reason: "Duplicate row in file" },
      { row: 10, phone: "", reason: "No phone number" },
    ]);
    expect(addedCountryLine(plan.addedCountry, "91")).toBe("3 numbers had +91 added");
    expect(skippedRowsLine(plan.errors.length)).toBe("3 rows will be skipped");
  });

  it("nothing is saved without a country code: no default read = the 10-digit rows are skipped", () => {
    const plan = planImportRows(parsed.rows, parsed.mapping, null);
    // Only the numbers that had their own country code (row 9's is +919908109123).
    expect(plan.rows.map((r) => r.phone)).toEqual([
      "+919876543210",
      "+919876543211",
      "+6591234567",
      ZOORI_E164,
    ]);
    expect(plan.rows.map((r) => r.phone)).not.toContain("+9908109123");
    expect(plan.errors.filter((e) => e.reason === "No country code")).toHaveLength(3);
  });

  it("the preview shows the counts and the skipped rows, in both designs", () => {
    const plan = planImportRows(parsed.rows, parsed.mapping, "91");
    for (const variant of ["classic", "new"] as const) {
      const html = renderToStaticMarkup(
        <ImportPhoneCheck plan={plan} code="91" error={null} loading={false} variant={variant} />,
      );
      expect(html, variant).toContain("3 numbers had +91 added");
      expect(html).toContain("3 rows will be skipped");
      expect(html).toContain("Row 8");
      expect(html).toContain("Too short: needs 10 digits, or + and the country code");
      expect(html).toContain("Duplicate row in file");
      expect(html).toContain("6 numbers are ready to import");
      expect(html).toContain("Nothing is saved without a country code.");
    }
    const failed = renderToStaticMarkup(
      <ImportPhoneCheck
        plan={null}
        code={null}
        error="We couldn't read it."
        loading={false}
        variant="new"
      />,
    );
    expect(failed).toContain("We couldn&#x27;t read it.");
  });

  it("the commit sends exactly the plan's rows: +919908109123, never +9908109123", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const call = (async (_path: string, init: { body: Record<string, unknown> }) => {
      bodies.push(init.body);
      if (init.body["action"] === "start") return { data: { import_id: "imp" }, error: null };
      if (init.body["action"] === "chunk")
        return { data: { created: 6, updated: 0, errors: [] }, error: null };
      return { data: {}, error: null };
    }) as unknown as typeof import("@/lib/whatsapp-client").callApi;
    const out = await runContactImport(
      {
        organizationId: ORG,
        filename: "BBB.csv",
        rows: parsed.rows,
        mapping: parsed.mapping,
        consent: true,
        startFlows: false,
        onProgress: () => {},
        defaultCountryCode: "91",
      },
      call,
    );
    const sent = (
      bodies.find((b) => b["action"] === "chunk")!["rows"] as Array<{ phone: string }>
    ).map((r) => r.phone);
    expect(sent).toContain(ZOORI_E164);
    expect(sent).not.toContain("+9908109123");
    expect("results" in out && out.results.skipped).toBe(3);
  });
});

describe("Add contact", () => {
  it("9908109123, 09908109123 and 99081 09123 are saved as +919908109123; 12345 is refused with why", () => {
    for (const typed of ["9908109123", "09908109123", "99081 09123", "+919908109123"])
      expect(addContactPhone(typed, "91"), typed).toEqual({
        phone: ZOORI_E164,
        waId: "919908109123",
      });
    expect(addContactPhone("4155550123", "1")).toEqual({
      phone: "+14155550123",
      waId: "14155550123",
    });
    expect(addContactPhone("12345", "91")).toEqual({
      error:
        "Too short: needs 10 digits, or + and the country code. Enter it with the country code, e.g. +91 98765 43210.",
    });
    // The code couldn't be read: a 10-digit number isn't saved.
    expect(addContactPhone(ZOORI_10, null, "We couldn't read it.")).toEqual({
      error: "We couldn't read it.",
    });
  });
});

// ------------------------------------------------------------ the Public API

type Handler = (a: { request: Request; params?: Record<string, string> }) => Promise<Response>;
const handler = (route: unknown, method: string) =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers[
    method
  ]!;

let net: ReturnType<typeof fakeFetch>;
const meta = { sendError: null as Record<string, unknown> | null, uploadError: false };
const rows = (t: string) => h.world!.db.rows(t);
const sends = () =>
  net.calls.filter(
    (c) => c.url.startsWith("https://graph.facebook.com/") && c.url.endsWith("/messages"),
  );
const sentTo = (c: FetchCall) => (JSON.parse(String(c.body)) as { to: string }).to;

async function api(
  route: unknown,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
) {
  const res = await handler(
    route,
    method,
  )({
    request: new Request(`https://aidwar.in${path}`, {
      method,
      headers: { authorization: `Bearer ${h.world!.keys.a}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    params,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const invoice = (extra: Record<string, unknown> = {}) => ({
  to: ZOORI_10,
  template_name: "invoice_ready",
  document: { base64: Buffer.from(PDF).toString("base64"), filename: "ZADM2611A002.pdf" },
  body_params: ["Asha", "ZADM2611A002", "₹2,500.00"],
  cc: [],
  ...extra,
});
const org = () => rows("organizations").find((r) => r["id"] === ORG)!;

describe("the Public API", () => {
  beforeEach(() => {
    h.world = publicApiWorld();
    meta.sendError = null;
    meta.uploadError = false;
    clearSafeFetchDnsCache();
    resetDialCodeCache();
    net = fakeFetch([metaRoutes(meta)]);
    vi.stubGlobal("fetch", net.impl);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("to: 9908109123, 09908109123 and 99081 09123 go to 919908109123, and the 202 says to: +919908109123", async () => {
    for (const [i, to] of ["9908109123", "09908109123", "99081 09123"].entries()) {
      const res = await api(
        TemplateRoute,
        "POST",
        "/api/v1/messages/template",
        invoice({ to, idempotency_key: `t-${i}` }),
      );
      expect(res.status, to).toBe(202);
      expect(res.body["to"], to).toBe(ZOORI_E164);
      expect(sentTo(sends().at(-1)!)).toBe("919908109123");
    }
  });

  it("a number with its code: the 202 is exactly as before (no `to`)", async () => {
    const res = await api(
      TemplateRoute,
      "POST",
      "/api/v1/messages/template",
      invoice({ to: "+919908109123" }),
    );
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual([
      "copies",
      "idempotency_key",
      "message_id",
      "status",
      "wamid",
    ]);
  });

  it("cc: a 10-digit staff number gets +91; 12345 refuses the whole request naming cc[1]", async () => {
    const ok = await api(
      TemplateRoute,
      "POST",
      "/api/v1/messages/template",
      invoice({ to: "+919908109123", cc: ["9121883067"] }),
    );
    expect(ok.status).toBe(202);
    expect(ok.body["copies"]).toMatchObject([{ to: "+919121883067", status: "queued" }]);
    expect(sends().map(sentTo)).toEqual(["919908109123", "919121883067"]);
    const bad = await api(
      TemplateRoute,
      "POST",
      "/api/v1/messages/template",
      invoice({ cc: ["+918121310333", "12345"], idempotency_key: "cc-bad" }),
    );
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid_phone", field: "cc[1]" } });
    expect(sends()).toHaveLength(2);
    expect(rows("api_requests").some((r) => r["idempotency_key"] === "cc-bad")).toBe(false);
  });

  it("to: 12345 is invalid_phone with the reason; nothing sent or stored", async () => {
    const res = await api(
      TemplateRoute,
      "POST",
      "/api/v1/messages/template",
      invoice({ to: "12345", idempotency_key: "k" }),
    );
    expect(res).toMatchObject({ status: 400, body: { code: "invalid_phone", field: "to" } });
    expect(String(res.body["error"])).toContain("too short");
    expect(sends()).toHaveLength(0);
    expect(rows("api_requests")).toHaveLength(0);
  });

  it("a workspace with default code 1 sends 4155550123 to +14155550123", async () => {
    org()["default_country_code"] = "1";
    const res = await api(
      TemplateRoute,
      "POST",
      "/api/v1/messages/template",
      invoice({ to: "4155550123" }),
    );
    expect(res.status).toBe(202);
    expect(res.body["to"]).toBe("+14155550123");
    expect(sentTo(sends().at(-1)!)).toBe("14155550123");
  });

  it("the session endpoint: the same rule", async () => {
    rows("contacts").push({
      id: "c-z",
      organization_id: ORG,
      phone: ZOORI_E164,
      wa_id: "919908109123",
      opt_in_status: "unknown",
    });
    rows("conversations").push({
      id: "conv-z",
      organization_id: ORG,
      contact_id: "c-z",
      whatsapp_account_id: "acc-a",
      status: "open",
      last_customer_message_at: new Date().toISOString(),
    });
    const res = await api(SessionRoute, "POST", "/api/v1/messages/session", {
      to: ZOORI_10,
      type: "text",
      text: "Hi",
    });
    expect(res.status).toBe(202);
    expect(res.body["to"]).toBe(ZOORI_E164);
    expect(sentTo(sends().at(-1)!)).toBe("919908109123");
    const bad = await api(SessionRoute, "POST", "/api/v1/messages/session", {
      to: "12345",
      type: "text",
      text: "Hi",
    });
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid_phone", field: "to" } });
  });

  it("contacts: upsert and bulk save +919908109123; /contacts/9908109123 finds it; 12345 is invalid_phone", async () => {
    const one = await api(ContactsRoute, "POST", "/api/v1/contacts", {
      phone: ZOORI_10,
      name: "Asha",
    });
    expect(one.status).toBe(201);
    expect(rows("contacts").find((c) => c["phone"] === ZOORI_E164)).toBeTruthy();
    expect(rows("contacts").find((c) => c["phone"] === "+9908109123")).toBeFalsy();
    const bulk = await api(BulkRoute, "POST", "/api/v1/contacts/bulk", {
      contacts: [
        { phone: "09812345678" },
        { phone: "99081 09124" },
        { phone: "12345" },
        { phone: "+6591234567" },
      ],
    });
    expect(bulk.status).toBe(200);
    const results = bulk.body["results"] as Array<{ status: string; error?: { code: string } }>;
    expect(results.map((r) => r.status)).toEqual(["created", "created", "error", "created"]);
    expect(results[2]!.error!.code).toBe("invalid_phone");
    for (const p of ["+919812345678", "+919908109124", "+6591234567"])
      expect(
        rows("contacts").find((c) => c["phone"] === p),
        p,
      ).toBeTruthy();
    const found = await api(OneRoute, "GET", `/api/v1/contacts/${ZOORI_10}`, undefined, {
      phone: ZOORI_10,
    });
    expect(found.status).toBe(200);
    expect((found.body["contact"] as { phone: string }).phone).toBe(ZOORI_E164);
    const bad = await api(ContactsRoute, "POST", "/api/v1/contacts", { phone: "12345" });
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid_phone" } });
  });

  it("balance ?to=9908109123 prices India, as +919908109123 does", async () => {
    const a = await api(BalanceRoute, "GET", `/api/v1/account/balance?to=${ZOORI_10}`);
    const b = await api(BalanceRoute, "GET", "/api/v1/account/balance?to=%2B919908109123");
    expect(a.status).toBe(200);
    expect({ ...a.body, as_of: null }).toEqual({ ...b.body, as_of: null });
    expect(a.body["country"]).toBe("IN");
    const bad = await api(BalanceRoute, "GET", "/api/v1/account/balance?to=12345");
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid_to" } });
  });
});
