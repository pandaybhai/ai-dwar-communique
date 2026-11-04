import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { MAX_CC, copyCostNote, parseCcNumbers, storedCcNumbers } from "./public-api-cc";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 62 — the API invoice copy (cc) limit is 10 (was 3): ZOORI Jewels
 * INDIA copies 7 staff numbers, one of them a US (+1) number. 10 numbers are
 * taken and 11 refused with a clear message on the API's `cc`, the workspace
 * default (Settings → API & webhooks) and 20261340's CHECK on a throwaway
 * Postgres. Rate limits are still 1 + copies (10 copies = 11). The docs and
 * the Settings card say the same. Fakes only: Meta and DNS are a fake fetch,
 * the database is in memory or a scratch Postgres — never the live one.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/messages/template";
import { Route as CopiesRoute } from "../routes/api/developer/copies";

type Handler = (a: { request: Request; params?: Record<string, string> }) => Promise<Response>;
type Handlers = { options: { server: { handlers: Record<string, Handler> } } };
const POST = (Route as unknown as Handlers).options.server.handlers["POST"]!;
const copies = (CopiesRoute as unknown as Handlers).options.server.handlers;

const CUSTOMER = "+919876543210";
const US_STAFF = "+12025550123";
/** `n` distinct valid staff numbers; the last of 10 is the US one. */
const staff = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i === 9 ? US_STAFF : `+9198000002${String(i).padStart(2, "0")}`,
  );
const TEN = staff(10);
const ELEVEN = [...TEN, "+919800000299"];
const B64 = Buffer.from(PDF).toString("base64");

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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const save = async (numbers: unknown) =>
  copies["POST"]!({
    request: new Request("https://aidwar.in/api/developer/copies", {
      method: "POST",
      headers: { authorization: "Bearer u-admin", "content-type": "application/json" },
      body: JSON.stringify({ organization_id: ORG, numbers }),
    }),
  });
const getCopies = async () =>
  copies["GET"]!({
    request: new Request(`https://aidwar.in/api/developer/copies?organization_id=${ORG}`, {
      headers: { authorization: "Bearer u-admin" },
    }),
  });

const metaCalls = () => net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"));
const sends = () => metaCalls().filter((c) => c.url.endsWith("/messages"));
const sendTo = (c: FetchCall) => (JSON.parse(String(c.body)) as Record<string, unknown>)["to"];
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
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  net = fakeFetch([metaRoutes(meta)]);
  vi.stubGlobal("fetch", net.impl);
});
afterEach(() => vi.unstubAllGlobals());

describe("the limit is 10", () => {
  it("MAX_CC is 10", () => {
    expect(MAX_CC).toBe(10);
  });

  it("parseCcNumbers takes 10 (a +1 number too) and refuses 11 with a clear message", () => {
    expect(parseCcNumbers(TEN, { to: CUSTOMER })).toEqual({ ok: true, numbers: TEN });
    expect(parseCcNumbers(ELEVEN)).toEqual({
      ok: false,
      error: "`cc` takes at most 10 numbers; it has 11.",
    });
  });

  it("a stored default is read up to 10", () => {
    expect(storedCcNumbers(ELEVEN)).toEqual(TEN);
  });
});

describe("API cc: 10 accepted, 11 refused", () => {
  it("10 copies: 11 sends, every copy queued, 11 against the rate limits", async () => {
    const res = await send(invoice({ cc: TEN, idempotency_key: "inv-62" }));
    expect(res.status).toBe(202);
    const list = res.body["copies"] as Array<{ to: string; status: string }>;
    expect(list.map((c) => [c.to, c.status])).toEqual(TEN.map((n) => [n, "queued"]));
    expect(sends().map(sendTo)).toEqual([CUSTOMER, ...TEN].map((n) => n.slice(1)));
    expect(h.world!.rate.windows.get("key:key-a")).toBe(11);
    expect(h.world!.rate.windows.get("org:org-a")).toBe(11);
  });

  it("11 copies: 400 invalid_cc saying the limit, nothing sent, reserved or counted", async () => {
    const res = await send(invoice({ cc: ELEVEN, idempotency_key: "inv-62b" }));
    expect([res.status, res.body["code"]]).toEqual([400, "invalid_cc"]);
    expect(res.body["error"]).toBe("`cc` takes at most 10 numbers; it has 11. Nothing was sent.");
    expect(metaCalls()).toEqual([]);
    expect(rows("api_requests")).toHaveLength(0);
    expect(rows("messages")).toHaveLength(0);
  });
});

describe("workspace default: 10 accepted, 11 refused", () => {
  it("saves 10 numbers (one +1); GET says max 10; a send without cc copies all 10", async () => {
    const res = await save(TEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, numbers: TEN });
    expect(org()["api_cc_numbers"]).toEqual(TEN);
    expect(await (await getCopies()).json()).toEqual({ available: true, max: 10, numbers: TEN });
    const sent = await send(invoice());
    expect(sent.status).toBe(202);
    expect((sent.body["copies"] as unknown[]).length).toBe(10);
    expect(sends()).toHaveLength(11);
    expect(h.world!.rate.windows.get("key:key-a")).toBe(11);
  });

  it("refuses 11 with a clear message and keeps what was saved", async () => {
    expect((await save(staff(7))).status).toBe(200);
    const res = await save(ELEVEN);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "The copy list takes at most 10 numbers; it has 11.",
    );
    expect(org()["api_cc_numbers"]).toEqual(staff(7));
  });
});

describe("the words say 10 (and 10 copies = 11 requests)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

  it("the docs: the cc field, the endpoint summary, invalid_cc and the rate-limit guide", async () => {
    const { API_ENDPOINTS } = await import("./public-api-spec");
    const ep = API_ENDPOINTS.find((e) => e.id === "send-template")!;
    expect(ep.summary).toContain("Add `cc` (up to 10 numbers)");
    const cc = (ep.fields ?? []).find((f) => f.name === "cc")!;
    expect(cc.description).toMatch(/^Up to 10 more WhatsApp numbers/);
    expect(cc.description).toContain("(a request with 10 copies counts as 11)");
    const portal = read("developer-portal.ts");
    expect(portal).toContain("a call with ${MAX_CC} copies (the most) counts as ${MAX_CC + 1}");
    expect(portal).toContain("must be a list of at most ${MAX_CC} WhatsApp numbers");
    const { ERROR_MEANINGS } = await import("./developer-portal");
    expect(ERROR_MEANINGS["invalid_cc"]).toBe(
      "`cc` must be a list of at most 10 WhatsApp numbers with their country code (duplicates and the `to` number are removed).",
    );
  });

  it("no cc text hard-codes 3 any more", () => {
    for (const p of [
      "public-api-cc.ts",
      "public-api-spec.ts",
      "developer-portal.ts",
      "public-api-cc.server.ts",
      "../components/settings/api-copies-card.tsx",
      "../routes/api/developer/copies.ts",
    ]) {
      const text = read(p);
      expect(text, p).not.toMatch(/(up to|at most) 3 (more )?(WhatsApp )?numbers/i);
      expect(text, p).not.toMatch(/MAX_CC = 3\b/);
    }
  });

  it("the Settings card: 10 boxes and the per-invoice cost note", () => {
    const card = read("../components/settings/api-copies-card.tsx");
    expect(card).toContain("Array.from({ length: MAX_CC }");
    expect(card).toContain("{copyCostNote(copyCount)}");
    expect(card).toContain("Up to {MAX_CC} numbers");
    expect(copyCostNote(0)).toBe(
      "1 WhatsApp message (the customer's), no copies. Each copy is a separate WhatsApp message charged by Meta at the template's category rate (utility, marketing or authentication); international numbers cost more.",
    );
    expect(copyCostNote(1)).toMatch(/^2 WhatsApp messages: the customer's and 1 copy\. /);
    expect(copyCostNote(7)).toMatch(/^8 WhatsApp messages: the customer's and 7 copies\. /);
    expect(copyCostNote(10)).toContain("international numbers cost more.");
  });
});

// ------------------------------------------------- 20261340 on real Postgres
const dir = import.meta.dirname;
const MIGRATIONS = join(dir, "../../supabase/aidwar-migrations");
const BATCH61 = join(MIGRATIONS, "20261330_batch61.sql");
const MIGRATION = join(MIGRATIONS, "20261340_batch62.sql");
const PG_ORG = "00000000-0000-0000-0000-0000000062a1";

describe("20261340_batch62.sql (text)", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("drops and re-adds only the CHECK, leaves the guard trigger alone, sets no numbers", () => {
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS organizations_api_cc_numbers_check/);
    expect(code).toContain("cardinality(api_cc_numbers) <= 10");
    expect(code).toContain(String.raw`'^(\+[0-9]{8,15}(,\+[0-9]{8,15}){0,9})?$'`);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|function|trigger)\b/i);
    expect(code).not.toMatch(/trg_guard_api_cc_numbers|guard_api_cc_numbers\b/);
    expect(code).not.toMatch(/\bupdate\s+public\.organizations\b|\binsert\s+into\b/i);
  });

  it("ends with mcp_block_oauth_writes() and mcp_block_oauth_reads()", () => {
    expect(
      code
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261340_batch62.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    const set = (v: string) =>
      pg.sql(`update public.organizations set api_cc_numbers = ${v} where id = '${PG_ORG}'`);
    const arr = (list: string[]) => `array[${list.map((n) => `'${n}'`).join(",")}]`;
    const guardDef = () =>
      pg.sql(`select pg_get_functiondef('public.trg_guard_api_cc_numbers()'::regprocedure)`);
    let guardBefore = "";

    beforeAll(() => {
      // 20261330 first (with 3 numbers saved under its limit), then 20261340 twice.
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch61-schema.sql"),
        migrations: [BATCH61],
      });
      pg.sql(`insert into public.organizations (id, name) values ('${PG_ORG}', 'Shop Z')`);
      set(arr(staff(3)));
      guardBefore = guardDef();
      pg.file(MIGRATION);
      pg.file(MIGRATION);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("keeps what was saved and has one CHECK", () => {
      expect(
        pg.sql(
          `select cardinality(api_cc_numbers) from public.organizations where id = '${PG_ORG}'`,
        ),
      ).toBe("3");
      expect(
        pg.sql(
          `select count(*) from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_api_cc_numbers_check'`,
        ),
      ).toBe("1");
    });

    it("takes 10 numbers (one +1) and refuses 11 by name", () => {
      set(arr(TEN));
      expect(
        pg.sql(
          `select cardinality(api_cc_numbers) from public.organizations where id = '${PG_ORG}'`,
        ),
      ).toBe("10");
      expect(() => set(arr(ELEVEN))).toThrow(/organizations_api_cc_numbers_check/);
      set("'{}'");
    });

    it("the same per-number pattern: no bad number in any of the 10 places", () => {
      for (const bad of ["918121310333", "+91 81213 10333", "+1234", "+1234567890123456"])
        for (const at of [0, 4, 9]) {
          const list = [...TEN];
          list[at] = bad;
          expect(() => set(arr(list)), `${bad} at ${at}`).toThrow(
            /organizations_api_cc_numbers_check/,
          );
        }
      expect(() => set("array[null]::text[]")).toThrow(/organizations_api_cc_numbers_check/);
      expect(() => set(`array['+918121310333', null]`)).toThrow(
        /organizations_api_cc_numbers_check/,
      );
      set("'{}'");
    });

    it("the guard trigger is unchanged: a signed-in member's update keeps the old value", () => {
      expect(guardDef()).toBe(guardBefore);
      set(arr(staff(2)));
      pg.sql(
        `set role authenticated; update public.organizations set api_cc_numbers = ${arr(TEN)} where id = '${PG_ORG}'; reset role;`,
      );
      expect(
        pg.sql(
          `select cardinality(api_cc_numbers) from public.organizations where id = '${PG_ORG}'`,
        ),
      ).toBe("2");
    });
  },
);
