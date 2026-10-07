import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 21b:
 *  (1) Admin → Billing → "Create billing templates": each template on its
 *      own (one failure never stops the rest), held ones skipped whatever
 *      their language, the invoice notice's DOCUMENT sample uploaded, Meta's
 *      own error text per template, and a time budget per run;
 *      plus the tslib resolution that broke pdf-lib on the server.
 *  (2) billing notices: float_low / low_credits never pile up, and a notice
 *      older than 48 h is failed as stale, never sent late.
 */

const h = vi.hoisted(() => ({
  created: [] as Array<{ organizationId: string; draft: Record<string, unknown> }>,
  uploads: [] as Array<Record<string, unknown>>,
  createFails: {} as Record<string, string>,
  createThrows: {} as Record<string, string>,
  uploadResult: null as null | Record<string, unknown>,
  onCreate: null as null | (() => void),
}));

vi.mock("@/lib/template-create.server", () => ({
  createTemplateFromDraft: async (_db: unknown, input: { organizationId: string; draft: Record<string, unknown> }) => {
    const name = String(input.draft["name"]);
    h.onCreate?.();
    if (h.createThrows[name]) throw new Error(h.createThrows[name]);
    if (h.createFails[name]) return { ok: false, error: h.createFails[name] };
    h.created.push(input);
    return { ok: true, id: name, metaTemplateId: name, status: "PENDING" };
  },
}));
vi.mock("@/lib/template-media.server", () => ({
  uploadTemplateMedia: async (_db: unknown, input: Record<string, unknown>) => {
    h.uploads.push(input);
    return (
      h.uploadResult ?? {
        ok: true,
        id: "asset-1",
        format: "DOCUMENT",
        handle: "4::sample-handle",
        mediaUrl: "https://files.example/sample-invoice.pdf",
        fileName: "sample-invoice.pdf",
        byteSize: 100,
      }
    );
  },
}));

import { BILLING_TEMPLATES, ensureBillingTemplates, drainBillingNotifications, isStaleNotice, NOTICE_STALE_MS } from "./billing-notify.server";
import { notify, STANDING_NOTICE_REPEAT_MS } from "./billing.server";
import { runBillingSweep } from "./billing-sweep.server";
import { tslibEsmFile } from "./tslib-esm.build";

const ALL = BILLING_TEMPLATES.map((t) => t.name);
const FIRST_EIGHT = ALL.slice(0, ALL.indexOf("admin_settle_failed") + 1);

beforeEach(() => {
  h.created.length = 0;
  h.uploads.length = 0;
  h.createFails = {};
  h.createThrows = {};
  h.uploadResult = null;
  h.onCreate = null;
  vi.stubEnv("PLATFORM_ORG_ID", "platform-org");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The platform workspace holding `held` (in the given language). */
const templatesWorld = (held: string[], language = "en") =>
  fakeDb((op) => {
    if (op.table === "profiles") return { data: { is_super_admin: true }, error: null };
    if (op.table === "message_templates")
      return { data: held.map((name) => ({ name, language, status: "PENDING" })), error: null };
    return undefined;
  });

// ------------------------------------------------------------------ (1)
describe("(1) Create billing templates", () => {
  it("the 14 notices in order: admin_settle_failed is the 8th, client_invoice_issued (DOCUMENT) the 9th", () => {
    expect(ALL).toHaveLength(14);
    expect(ALL[7]).toBe("admin_settle_failed");
    expect(BILLING_TEMPLATES[8]).toMatchObject({ name: "client_invoice_issued", headerFormat: "DOCUMENT" });
  });

  it("with the first 8 held, submits exactly the remaining 6 and skips the 8", async () => {
    const report = await ensureBillingTemplates(templatesWorld(FIRST_EIGHT).supabase, "admin-1");
    expect(report.skipped).toEqual(FIRST_EIGHT);
    expect(report.failed).toEqual([]);
    expect(report.created).toEqual(ALL.slice(8));
    expect(report.remaining).toEqual([]);
    expect(h.created.map((c) => c.draft["name"]).sort()).toEqual(ALL.slice(8).sort());
    expect(h.created.every((c) => c.organizationId === "platform-org" && c.draft["category"] === "UTILITY")).toBe(true);
  });

  it("a template held in another language (staff_handoff_alert, en_US) is skipped, not resubmitted", async () => {
    const report = await ensureBillingTemplates(templatesWorld(["staff_handoff_alert"], "en_US").supabase, "admin-1");
    expect(report.skipped).toEqual(["staff_handoff_alert"]);
    expect(h.created.some((c) => c.draft["name"] === "staff_handoff_alert")).toBe(false);
  });

  it("the invoice notice uploads a real sample PDF and carries the upload handle as its header sample", async () => {
    await ensureBillingTemplates(templatesWorld(FIRST_EIGHT).supabase, "admin-1");
    expect(h.uploads).toHaveLength(1);
    const upload = h.uploads[0]!;
    expect(upload).toMatchObject({ organizationId: "platform-org", mime: "application/pdf", format: "DOCUMENT", slot: "header" });
    const bytes = upload["bytes"] as Uint8Array;
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const draft = h.created.find((c) => c.draft["name"] === "client_invoice_issued")!.draft;
    expect(draft).toMatchObject({ headerFormat: "DOCUMENT", headerHandle: "4::sample-handle", headerMediaUrl: "https://files.example/sample-invoice.pdf" });
  });

  it("the DOCUMENT upload failing fails only that template, with Meta's own text; the rest are created", async () => {
    const meta = "Meta wouldn't accept the file: (#100) Invalid parameter";
    h.uploadResult = { ok: false, error: meta, status: 400 };
    const report = await ensureBillingTemplates(templatesWorld(FIRST_EIGHT).supabase, "admin-1");
    expect(report.failed).toEqual([{ name: "client_invoice_issued", error: meta }]);
    expect(report.created).toEqual(ALL.slice(9));
    expect(report.results.find((r) => r.name === "client_invoice_issued")).toEqual({ name: "client_invoice_issued", outcome: "failed", error: meta });
    expect(report.templates.find((t) => t.name === "client_invoice_issued")!.error).toBe(meta);
  });

  it("a template that throws (as pdf-lib did) or that Meta refuses never stops the others", async () => {
    h.createThrows["client_invoice_overdue"] = "Cannot destructure property '__extends'";
    h.createFails["client_trial_ending"] = "(#2388024) Content in this language already exists";
    const report = await ensureBillingTemplates(templatesWorld(FIRST_EIGHT).supabase, "admin-1");
    expect(report.failed).toEqual([
      { name: "client_invoice_overdue", error: "Cannot destructure property '__extends'" },
      { name: "client_trial_ending", error: "(#2388024) Content in this language already exists" },
    ]);
    expect(report.created).toEqual(["client_invoice_issued", "client_payment_failed", "admin_ai_provider_alert", "staff_handoff_alert"]);
  });

  it("starts nothing new past the time budget; the rest come back as remaining, and the next run takes only those", async () => {
    let clock = 0;
    h.onCreate = () => {
      clock += 4_000; // ~4 s per template at Meta
    };
    const db = templatesWorld([]);
    const first = await ensureBillingTemplates(db.supabase, "admin-1", { budgetMs: 10_000, now: () => clock });
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.remaining.length).toBeGreaterThan(0);
    expect(first.created.length + first.remaining.length).toBe(14);
    expect(first.results.filter((r) => r.outcome === "remaining").map((r) => r.name)).toEqual(first.remaining);

    h.created.length = 0;
    clock = 0;
    const second = await ensureBillingTemplates(templatesWorld(first.created).supabase, "admin-1", {
      names: first.remaining.slice(0, 2),
      now: () => clock,
    });
    expect(h.created.map((c) => c.draft["name"]).sort()).toEqual(first.remaining.slice(0, 2).sort());
    expect(second.created.sort()).toEqual(first.remaining.slice(0, 2).sort());
  });

  it("can't read what is already held → submits nothing and says why", async () => {
    const db = fakeDb((op) => {
      if (op.table === "profiles") return { data: { is_super_admin: true }, error: null };
      if (op.table === "message_templates") return { data: null, error: { message: "timeout" } };
      return undefined;
    });
    const report = await ensureBillingTemplates(db.supabase, "admin-1");
    expect(h.created).toHaveLength(0);
    expect(report.failed).toEqual([{ name: "all", error: "We couldn't read the existing templates: timeout" }]);
  });

  it("the default budget fits a request: ≤ 20 s before the last template starts", async () => {
    const { BILLING_TEMPLATE_BUDGET_MS } = await import("./billing-notify.server");
    expect(BILLING_TEMPLATE_BUDGET_MS).toBeLessThanOrEqual(20_000);
  });
});

describe("(1) tslib resolves to its ESM file in the server bundle", () => {
  it("modules/index.js (the CommonJS-default wrapper) → tslib.es6.mjs / tslib.es6.js", () => {
    const files = new Set(["/n/tslib/tslib.es6.mjs", "/n/pdf-lib/node_modules/tslib/tslib.es6.js"]);
    const exists = (p: string) => files.has(p);
    expect(tslibEsmFile("/n/tslib/modules/index.js", exists)).toBe("/n/tslib/tslib.es6.mjs");
    expect(tslibEsmFile("/n/pdf-lib/node_modules/tslib/modules/index.js?x=1", exists)).toBe("/n/pdf-lib/node_modules/tslib/tslib.es6.js");
    expect(tslibEsmFile("C:\\n\\tslib\\modules\\index.js", (p) => p === "C:/n/tslib/tslib.es6.mjs")).toBe("C:/n/tslib/tslib.es6.mjs");
    expect(tslibEsmFile("/n/other/index.js", exists)).toBeNull();
  });

  it("the installed tslib that pdf-lib uses really has that file", () => {
    const fromPdfLib = createRequire(createRequire(import.meta.url).resolve("pdf-lib"));
    const main = fromPdfLib.resolve("tslib").replace(/\\/g, "/");
    const dir = main.slice(0, main.lastIndexOf("/tslib/") + "/tslib".length);
    expect(existsSync(`${dir}/tslib.es6.mjs`) || existsSync(`${dir}/tslib.es6.js`)).toBe(true);
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) notify(): standing warnings never pile up", () => {
  const world = (existing: unknown[], error: { message: string } | null = null) =>
    fakeDb((op) => {
      if (op.table === "billing_notifications" && op.kind === "select") return { data: existing, error };
      return undefined;
    });
  const inserts = (db: ReturnType<typeof fakeDb>) =>
    db.ops.filter((o) => o.table === "billing_notifications" && o.kind === "insert");
  const guardQuery = (db: ReturnType<typeof fakeDb>) =>
    db.ops.find((o) => o.table === "billing_notifications" && o.kind === "select") as FakeOp;

  for (const [kind, audience] of [
    ["float_low", "admin"],
    ["low_credits", "client"],
  ] as const) {
    it(`${kind}: none queued, nothing in 24 h → queued once`, async () => {
      const db = world([]);
      await notify(db.supabase, { organizationId: "org-1", audience, kind, payload: {} });
      expect(inserts(db)).toHaveLength(1);
    });

    it(`${kind}: an earlier one still queued (any age) or sent/failed within 24 h → nothing new`, async () => {
      const db = world([{ id: "n0" }]);
      const before = Date.now();
      await notify(db.supabase, { organizationId: "org-1", audience, kind, payload: {} });
      expect(inserts(db)).toHaveLength(0);
      const q = guardQuery(db);
      expect(db.has(q, "eq", "organization_id", "org-1")).toBe(true);
      expect(db.has(q, "eq", "audience", audience)).toBe(true);
      expect(db.has(q, "eq", "kind", kind)).toBe(true);
      const or = String(q.filters.find(([f]) => f === "or")?.[1][0]);
      const m = /^status\.eq\.queued,created_at\.gte\.(.+)$/.exec(or);
      expect(m).not.toBeNull();
      const since = Date.parse(m![1]!);
      expect(Math.abs(before - STANDING_NOTICE_REPEAT_MS - since)).toBeLessThan(5_000);
    });
  }

  it("the guard can't read → no notice (a missed warning beats a pile)", async () => {
    const db = world([], { message: "timeout" });
    await notify(db.supabase, { organizationId: "org-1", audience: "admin", kind: "float_low", payload: {} });
    expect(inserts(db)).toHaveLength(0);
  });

  it("event notices (trial_ending, invoice_issued) are never held by the guard", async () => {
    const db = world([{ id: "n0" }]);
    await notify(db.supabase, { organizationId: "org-1", audience: "client", kind: "trial_ending", payload: {} });
    expect(guardQuery(db)).toBeUndefined();
    expect(inserts(db)).toHaveLength(1);
  });
});

describe("(2) the sweep: low_credits once per low spell, until credits recover", () => {
  const sweepWorld = (state: { available: number; marker: string | null; threshold?: number }) =>
    fakeDb(
      (op) => {
        if (op.table === "organizations") return { data: [{ id: "org-1", name: "Shop", funding_model: "merchant" }], error: null };
        if (op.table === "organization_billing_settings" && op.kind === "select")
          return {
            data: {
              low_credit_threshold: state.threshold ?? 500,
              last_low_credit_notice_at: state.marker,
              last_expiry_sweep_at: new Date().toISOString(),
            },
            error: null,
          };
        if (op.table === "wallet_balances") return { data: { balance: state.available, held: 0 }, error: null };
        if (op.table === "billing_notifications" && op.kind === "select") return { data: [], error: null };
        if (op.table === "topup_tasks") return { data: [], error: null };
        return undefined;
      },
      (call) => (call.name === "org_flag_enabled" ? { data: true, error: null } : undefined),
    );
  const queued = (db: ReturnType<typeof fakeDb>) =>
    db.ops.filter((o) => o.table === "billing_notifications" && o.kind === "insert");
  const settingsWrites = (db: ReturnType<typeof fakeDb>) =>
    db.ops.filter((o) => o.table === "organization_billing_settings" && o.kind !== "select");

  it("first time below the threshold → one notice, spell marked", async () => {
    const db = sweepWorld({ available: 120, marker: null });
    const counts = await runBillingSweep(db.supabase);
    expect(counts.low_credits).toBe(1);
    expect(queued(db)).toHaveLength(1);
    expect(queued(db)[0]!.payload).toMatchObject({ organization_id: "org-1", audience: "client", kind: "low_credits" });
    expect(settingsWrites(db)[0]!.payload).toMatchObject({ organization_id: "org-1", last_low_credit_notice_at: expect.any(String) });
  });

  it("still low days later (the 17-in-10-days case) → nothing", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
    const db = sweepWorld({ available: 120, marker: threeDaysAgo });
    const counts = await runBillingSweep(db.supabase);
    expect(counts.low_credits).toBe(0);
    expect(queued(db)).toHaveLength(0);
    expect(settingsWrites(db)).toHaveLength(0);
  });

  it("credits recovered → spell cleared (no notice); the next drop warns again", async () => {
    const recovered = sweepWorld({ available: 800, marker: new Date().toISOString() });
    await runBillingSweep(recovered.supabase);
    expect(queued(recovered)).toHaveLength(0);
    const clear = settingsWrites(recovered);
    expect(clear).toHaveLength(1);
    expect(clear[0]).toMatchObject({ kind: "update", payload: { last_low_credit_notice_at: null } });
    expect(recovered.has(clear[0]!, "eq", "organization_id", "org-1")).toBe(true);

    const droppedAgain = sweepWorld({ available: 90, marker: null });
    expect((await runBillingSweep(droppedAgain.supabase)).low_credits).toBe(1);
  });

  it("above the threshold with no spell open → no writes at all", async () => {
    const db = sweepWorld({ available: 800, marker: null });
    await runBillingSweep(db.supabase);
    expect(settingsWrites(db)).toHaveLength(0);
    expect(queued(db)).toHaveLength(0);
  });
});

describe("(2) the drain: older than 48 h → failed stale, never sent late", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const notice = (id: string, kind: string, ageMs: number, extra: Record<string, unknown> = {}) => ({
    id,
    organization_id: "org-1",
    audience: "client",
    kind,
    channel: "whatsapp",
    recipient: "+919811111111",
    status: "queued",
    payload: { amount: 2950 },
    sent_at: null,
    created_at: new Date(Date.now() - ageMs).toISOString(),
    ...extra,
  });
  const drainWorld = (rows: unknown[]) =>
    fakeDb((op) => {
      if (op.table === "billing_notifications" && op.kind === "update" && !(op.payload as { status?: string }).status)
        return { data: [{ id: "claimed" }], error: null };
      if (op.table === "billing_notifications" && op.kind === "select") return { data: rows, error: null };
      if (op.table === "whatsapp_accounts")
        return { data: [{ id: "acc", organization_id: "platform-org", waba_id: "w", phone_number_id: "pn", display_phone_number: "91", status: "active", is_default: true }], error: null };
      if (op.table === "whatsapp_credentials") return { data: { access_token: "tok" }, error: null };
      if (op.table === "contacts") return { data: [], error: null };
      if (op.table === "organizations") return { data: { name: "Sharma Textiles" }, error: null };
      if (op.table === "message_templates") return { data: { name: "client_trial_ending", language: "en", status: "APPROVED" }, error: null };
      return undefined;
    });
  const statusWrites = (db: ReturnType<typeof fakeDb>) =>
    db.ops.filter((o) => o.table === "billing_notifications" && o.kind === "update" && (o.payload as { status?: string }).status);

  it("isStaleNotice: 48 h is the line; a missing date is never stale", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(NOTICE_STALE_MS).toBe(48 * 3600_000);
    expect(isStaleNotice("2026-10-05T11:59:00Z", now)).toBe(true);
    expect(isStaleNotice("2026-10-05T12:01:00Z", now)).toBe(false);
    expect(isStaleNotice(undefined, now)).toBe(false);
  });

  for (const kind of ["trial_ending", "invoice_issued", "float_low", "low_credits"]) {
    it(`${kind} queued 49 h ago → failed "stale", out of attempts, nothing sent`, async () => {
      const db = drainWorld([notice("n1", kind, 49 * 3600_000)]);
      const fetchSpy = vi.fn(async () => json({ messages: [{ id: "wamid" }] }));
      vi.stubGlobal("fetch", fetchSpy);
      const counts = await drainBillingNotifications(db.supabase);
      expect(counts).toEqual({ sent: 0, failed: 1, skipped: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(statusWrites(db)).toHaveLength(1);
      expect(statusWrites(db)[0]!.payload).toMatchObject({ status: "failed", error: "stale", payload: { attempts: 3 } });
    });
  }

  it("trial_ending queued 47 h ago still goes out", async () => {
    const db = drainWorld([notice("n1", "trial_ending", 47 * 3600_000, { payload: { days: 3 } })]);
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json({ messages: [{ id: "wamid" }] });
    });
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts.sent).toBe(1);
    expect(sent[0]).toMatchObject({ type: "template", template: { name: "client_trial_ending" } });
  });

  it("dead rows are left out by the query itself, and a row failed by hand (no attempt count) is never retried", async () => {
    const handFailed = notice("n9", "low_credits", 3600_000, { status: "failed", payload: {}, error: "stale_skipped_2026-10-07" });
    const db = drainWorld([handFailed]);
    const fetchSpy = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchSpy);
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const read = db.ops.find((o) => o.table === "billing_notifications" && o.kind === "select")!;
    expect(read.filters.find(([f]) => f === "or")?.[1][0]).toBe("status.eq.queued,and(status.eq.failed,payload->>attempts.in.(1,2))");
  });
});
