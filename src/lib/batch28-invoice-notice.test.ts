import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "./test-support/memory-db";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 28 item 10 — invoice notices re-sent daily.
 *
 * 7 Oct 2026: the email for AD/2026-27/00013 (Growth plan) reached the client
 * six times (10:36–10:40 x5, then 19:00) because the WhatsApp half kept
 * failing (client_invoice_issued pending at Meta) and every pass queued both
 * channels again.
 *
 * Rule: an invoice_issued notice goes out at most once per invoice and
 * channel once that channel has succeeded; a failing channel is retried
 * alone, with backoff, up to the cap — never re-sending the channel that
 * already went out.
 */

const h = vi.hoisted(() => ({ sends: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/invoice-pdf.server", () => ({
  renderInvoicePdf: async () => new Uint8Array([37, 80, 68, 70]),
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ phoneNumberId: "pn", accessToken: "tok" }),
  sendCampaignTemplate: async (
    _db: unknown,
    _org: string,
    _sender: unknown,
    to: Record<string, unknown>,
  ) => {
    h.sends.push(to);
    return { messageId: `wamid.${h.sends.length}`, error: null };
  },
}));

import { deliverInvoice } from "./invoices.server";
import { notify } from "./billing.server";
import {
  drainBillingNotifications,
  NOTICE_MAX_ATTEMPTS,
  NOTICE_RETRY_BACKOFF_MS,
  noticeRetryDue,
  writeNoticeOutcome,
} from "./billing-notify.server";
import { drainEmailNotices } from "./email-notices.server";

const ORG = "org-growth";
const INVOICE = "00000000-0000-4000-8000-000000000013"; // a test id
const NUMBER = "AD/2026-27/00013";
const T0 = Date.parse("2026-10-09T10:36:00Z");
const MIN = 60_000;

beforeEach(() => {
  h.sends.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("PLATFORM_ORG_ID", "platform-org");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const invoiceRow = (extra: Row = {}): Row => ({
  id: INVOICE,
  organization_id: ORG,
  invoice_number: NUMBER,
  kind: "tax_invoice",
  purpose: "plan_fee",
  status: "issued",
  total: 2950,
  pdf_path: `${ORG}/AD-2026-27-00013.pdf`,
  pdf_error: null,
  sent: {},
  buyer_snapshot: { billing_email: "accounts@example.com" },
  created_at: "2026-10-09T10:30:00Z",
  ...extra,
});

/**
 * The database refuses a second 'sent' invoice notice per org, channel and
 * invoice, as billing_notifications_invoice_sent_uidx does (23505).
 */
function enforceSentIndex(db: ReturnType<typeof memoryDb>) {
  const client = db.supabase as unknown as { from: (name: string) => Record<string, unknown> };
  const from = client.from.bind(client);
  client.from = (name: string) => {
    const b = from(name);
    if (name !== "billing_notifications") return b;
    const update = b["update"] as (p: unknown) => Record<string, unknown>;
    b["update"] = (patch: Record<string, unknown>) => {
      update(patch);
      if (patch["status"] !== "sent") return b;
      const eq = b["eq"] as (c: string, v: unknown) => Record<string, unknown>;
      b["eq"] = (c: string, v: unknown) => {
        eq(c, v);
        if (c !== "id") return b;
        const rows = db.rows("billing_notifications");
        const self = rows.find((r) => r["id"] === v);
        const invoiceOf = (r: Row) =>
          (r["payload"] as Record<string, unknown> | null)?.["invoice_id"];
        const clash =
          self?.["kind"] === "invoice_issued" &&
          rows.some(
            (r) =>
              r["id"] !== v &&
              r["kind"] === "invoice_issued" &&
              r["status"] === "sent" &&
              r["channel"] === self["channel"] &&
              r["organization_id"] === self["organization_id"] &&
              invoiceOf(r) === invoiceOf(self),
          );
        if (!clash) return b;
        return {
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({
              data: null,
              error: {
                code: "23505",
                message:
                  'duplicate key value violates unique constraint "billing_notifications_invoice_sent_uidx"',
              },
            }).then(res),
        };
      };
      return b;
    };
    return b;
  };
}

/** The platform number is connected, the WhatsApp template is still pending at Meta. */
function world(notices: Row[] = [], invoice: Row = invoiceRow()) {
  const db = memoryDb({
    invoices: [invoice],
    invoice_lines: [{ id: "l-1", invoice_id: INVOICE, line_no: 1 }],
    billing_notifications: notices,
    activity_log: [],
    organizations: [
      { id: ORG, name: "Growth Co", billing_accounts: { billing_whatsapp: "+919800000013" } },
    ],
    message_templates: [
      {
        organization_id: "platform-org",
        name: "client_invoice_issued",
        language: "en",
        status: "PENDING",
        components: null,
      },
    ],
    whatsapp_accounts: [
      {
        id: "acc",
        organization_id: "platform-org",
        waba_id: "w",
        phone_number_id: "pn",
        display_phone_number: "91",
        status: "active",
        is_default: true,
      },
    ],
    whatsapp_credentials: [{ organization_id: "platform-org", waba_id: "w", access_token: "tok" }],
    contacts: [],
  });
  enforceSentIndex(db);
  Object.assign(db.supabase, {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://files.example/${path}` },
        }),
      }),
    },
  });

  // Meta refuses the template while it is pending.
  const metaCalls: Array<Record<string, unknown>> = [];
  let metaOk = false;
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    metaCalls.push(JSON.parse(String(init.body)));
    return metaOk
      ? new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 })
      : new Response(
          JSON.stringify({
            error: { code: 132001, message: "Template name does not exist in the translation" },
          }),
          { status: 404 },
        );
  });
  const emails: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (message: Record<string, unknown>) => {
    emails.push(message);
    return { ok: true, id: `email_${emails.length}`, attachment: "attached" as const };
  });

  const notices_ = (channel?: string) =>
    db.rows("billing_notifications").filter((n) => !channel || n["channel"] === channel);

  /** One pass of the incident: the automatic delivery, then both drains. */
  const pass = async (at: number) => {
    vi.setSystemTime(at);
    await deliverInvoice(db.supabase, INVOICE, { fallbackToQueue: true });
    await drains(at);
  };
  const drains = async (at: number) => {
    vi.setSystemTime(at);
    const wa = await drainBillingNotifications(db.supabase);
    const email = await drainEmailNotices(db.supabase, 20, { send: send as never, now: () => at });
    return { wa, email };
  };
  return {
    ...db,
    metaCalls,
    emails,
    send,
    notices: notices_,
    pass,
    drains,
    approveTemplate: () => {
      metaOk = true;
    },
  };
}

const notice = (id: string, extra: Row = {}): Row => ({
  id,
  organization_id: ORG,
  audience: "client",
  kind: "invoice_issued",
  channel: "whatsapp",
  recipient: null,
  status: "queued",
  payload: { invoice_id: INVOICE, invoice_number: NUMBER, amount: 2950 },
  error: null,
  sent_at: null,
  created_at: new Date(T0 - MIN).toISOString(),
  ...extra,
});

// ---------------------------------------------------------------------------
describe("WhatsApp fails, email succeeds", () => {
  it("next passes retry WhatsApp only; the email is sent exactly once (the 7 Oct day, replayed)", async () => {
    const w = world();

    // 10:36–10:40: five passes, as on 7 Oct.
    for (let i = 0; i < 5; i++) await w.pass(T0 + i * MIN);
    expect(w.emails).toHaveLength(1);
    expect(w.emails[0]).toMatchObject({
      to: "accounts@example.com",
      idempotencyKey: expect.stringMatching(/^billing-notice-/),
    });
    expect(w.metaCalls).toHaveLength(1); // first try only; the retry waits out its backoff
    expect(w.notices()).toHaveLength(2); // one row per channel, never a second
    expect(w.notices("email")[0]).toMatchObject({ status: "sent" });
    expect(w.notices("whatsapp")[0]).toMatchObject({ status: "failed", payload: { attempts: 1 } });

    // 10:51: the WhatsApp row alone is retried (15 min after its failure).
    await w.pass(T0 + 15 * MIN);
    expect(w.metaCalls).toHaveLength(2);
    expect(w.notices("whatsapp")[0]).toMatchObject({ status: "failed", payload: { attempts: 2 } });
    expect(w.emails).toHaveLength(1);

    // 30 min later: still inside the 60-min backoff → nothing.
    await w.pass(T0 + 45 * MIN);
    expect(w.metaCalls).toHaveLength(2);

    // 60 min after the second failure: the last try.
    await w.pass(T0 + 75 * MIN);
    expect(w.metaCalls).toHaveLength(3);
    expect(w.notices("whatsapp")[0]).toMatchObject({
      status: "failed",
      payload: { attempts: NOTICE_MAX_ATTEMPTS },
    });

    // 19:00 the same day and the next morning: nothing more, on either channel.
    await w.pass(Date.parse("2026-10-09T19:00:00Z"));
    await w.pass(Date.parse("2026-10-10T10:36:00Z"));
    expect(w.metaCalls).toHaveLength(3);
    expect(w.emails).toHaveLength(1);
    expect(w.notices()).toHaveLength(2);
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it("the template is approved between tries: the WhatsApp retry goes out once, the email is not sent again", async () => {
    const w = world();
    await w.pass(T0);
    expect(w.notices("whatsapp")[0]).toMatchObject({ status: "failed", payload: { attempts: 1 } });
    w.approveTemplate();
    await w.pass(T0 + 16 * MIN);
    expect(w.notices("whatsapp")[0]).toMatchObject({ status: "sent" });
    await w.pass(T0 + 90 * MIN);
    expect(w.metaCalls).toHaveLength(2);
    expect(w.emails).toHaveLength(1);
    expect(w.notices()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe("retries stop at the cap, with backoff respected", () => {
  const failed = (attempts: number, minutesAgo: number): Row =>
    notice("n", {
      status: "failed",
      payload: { invoice_id: INVOICE, attempts },
      sent_at: new Date(T0 - minutesAgo * MIN).toISOString(),
    });

  it("noticeRetryDue: queued now; failed after 15 min, then 60 min; never at the cap or failed by hand", () => {
    expect(NOTICE_MAX_ATTEMPTS).toBe(3);
    expect(NOTICE_RETRY_BACKOFF_MS).toBe(15 * MIN);
    expect(noticeRetryDue(notice("q"), T0)).toBe(true);
    expect(noticeRetryDue(failed(1, 14), T0)).toBe(false);
    expect(noticeRetryDue(failed(1, 15), T0)).toBe(true);
    expect(noticeRetryDue(failed(2, 59), T0)).toBe(false);
    expect(noticeRetryDue(failed(2, 60), T0)).toBe(true);
    expect(noticeRetryDue(failed(3, 600), T0)).toBe(false);
    expect(noticeRetryDue(notice("hand", { status: "failed", payload: {} }), T0)).toBe(false);
    expect(noticeRetryDue(notice("s", { status: "sent" }), T0)).toBe(false);
    expect(noticeRetryDue(notice("k", { status: "skipped" }), T0)).toBe(false);
  });

  it("WhatsApp drain: a row in its backoff is not tried; past it, it is tried and its attempts go up", async () => {
    const w = world([failed(2, 30)]);
    expect(await w.drains(T0)).toMatchObject({ wa: { sent: 0, failed: 0, skipped: 0 } });
    expect(w.metaCalls).toHaveLength(0);
    await w.drains(T0 + 31 * MIN);
    expect(w.metaCalls).toHaveLength(1);
    expect(w.notices()[0]).toMatchObject({ status: "failed", payload: { attempts: 3 } });
    await w.drains(T0 + 24 * 60 * MIN);
    expect(w.metaCalls).toHaveLength(1);
  });

  it("email drain: same backoff and cap; the query leaves dead rows out", async () => {
    const w = world([
      notice("e1", {
        channel: "email",
        recipient: "accounts@example.com",
        status: "failed",
        payload: { invoice_id: INVOICE, attempts: 1 },
        sent_at: new Date(T0 - 5 * MIN).toISOString(),
      }),
      notice("e-dead", {
        channel: "email",
        recipient: "accounts@example.com",
        status: "failed",
        payload: { invoice_id: "inv-other", attempts: 3 },
      }),
    ]);
    await w.drains(T0);
    expect(w.emails).toHaveLength(0);
    await w.drains(T0 + 10 * MIN);
    expect(w.emails).toHaveLength(1);
    expect(w.notices().find((n) => n["id"] === "e1")).toMatchObject({ status: "sent" });
    expect(w.notices().find((n) => n["id"] === "e-dead")).toMatchObject({ status: "failed" });

    const db = fakeDb((op) => (op.kind === "select" ? { data: [], error: null } : undefined));
    await drainEmailNotices(db.supabase, 20, { send: vi.fn() as never, now: () => T0 });
    const read = db.ops.find((o) => o.table === "billing_notifications" && o.kind === "select")!;
    expect(db.has(read, "eq", "channel", "email")).toBe(true);
    expect(
      db.has(read, "or", "status.eq.queued,and(status.eq.failed,payload->>attempts.in.(1,2))"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("queueing again never re-queues a channel already sent", () => {
  it("email sent, WhatsApp failing: a new delivery queues nothing", async () => {
    const w = world([
      notice("n-email", {
        channel: "email",
        recipient: "accounts@example.com",
        status: "sent",
        sent_at: new Date(T0 - 60 * MIN).toISOString(),
      }),
      notice("n-wa", {
        status: "failed",
        payload: { invoice_id: INVOICE, attempts: 1 },
        sent_at: new Date(T0 - 60 * MIN).toISOString(),
      }),
    ]);
    await deliverInvoice(w.supabase, INVOICE, { fallbackToQueue: true });
    expect(w.notices().map((n) => n["id"])).toEqual(["n-email", "n-wa"]);
  });

  it("a channel out of tries is not restarted by a later pass; one failed by hand is", async () => {
    const exhausted = world([
      notice("n-wa", { status: "failed", payload: { invoice_id: INVOICE, attempts: 3 } }),
    ]);
    await notify(exhausted.supabase, {
      organizationId: ORG,
      audience: "client",
      kind: "invoice_issued",
      payload: { invoice_id: INVOICE },
    });
    expect(exhausted.notices()).toHaveLength(1);

    const byHand = world([notice("n-wa", { status: "failed", payload: { invoice_id: INVOICE } })]);
    await notify(byHand.supabase, {
      organizationId: ORG,
      audience: "client",
      kind: "invoice_issued",
      payload: { invoice_id: INVOICE },
    });
    expect(byHand.notices().map((n) => n["status"])).toEqual(["failed", "queued"]);
  });

  it("the guard is a database read: sent/queued first, then failed rows with an attempt count", async () => {
    const db = fakeDb(() => undefined);
    await notify(db.supabase, {
      organizationId: ORG,
      audience: "client",
      kind: "invoice_issued",
      channel: "email",
      recipient: "accounts@example.com",
      payload: { invoice_id: INVOICE },
    });
    const reads = db.ops.filter((o) => o.table === "billing_notifications" && o.kind === "select");
    expect(reads).toHaveLength(2);
    expect(db.has(reads[0]!, "in", "status", ["queued", "sent"])).toBe(true);
    expect(db.has(reads[1]!, "eq", "status", "failed")).toBe(true);
    expect(db.has(reads[1]!, "not", "payload->>attempts", "is", null)).toBe(true);
    for (const r of reads) {
      expect(db.has(r, "eq", "channel", "email")).toBe(true);
      expect(db.has(r, "eq", "payload->>invoice_id", INVOICE)).toBe(true);
    }
    expect(db.ops.filter((o) => o.kind === "insert")).toHaveLength(1);

    const broken = fakeDb((op) =>
      op.kind === "select" && op.filters.some(([f]) => f === "not")
        ? { data: null, error: { message: "timeout" } }
        : undefined,
    );
    await notify(broken.supabase, {
      organizationId: ORG,
      audience: "client",
      kind: "invoice_issued",
      payload: { invoice_id: INVOICE },
    });
    expect(broken.ops.filter((o) => o.kind === "insert")).toHaveLength(0);
  });

  it("a second row for an invoice already sent on that channel is closed by the drain, not sent", async () => {
    const w = world([
      notice("wa-sent", { status: "sent", sent_at: new Date(T0 - 60 * MIN).toISOString() }),
      notice("wa-dup"),
      notice("em-sent", {
        channel: "email",
        recipient: "accounts@example.com",
        status: "sent",
        sent_at: new Date(T0 - 60 * MIN).toISOString(),
      }),
      notice("em-dup", { channel: "email", recipient: "accounts@example.com" }),
    ]);
    w.approveTemplate();
    const counts = await w.drains(T0);
    expect(w.metaCalls).toHaveLength(0);
    expect(w.emails).toHaveLength(0);
    expect(counts.wa).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(counts.email.skipped).toBe(1);
    for (const id of ["wa-dup", "em-dup"])
      expect(w.notices().find((n) => n["id"] === id)).toMatchObject({
        status: "skipped",
        error: "already_sent",
      });
  });

  it("can't tell whether it was sent → the row is left for the next drain, nothing sent", async () => {
    const db = fakeDb((op) => {
      if (op.table !== "billing_notifications" || op.kind !== "select") return undefined;
      if (op.filters.some(([f, a]) => f === "eq" && a[0] === "status" && a[1] === "sent"))
        return { data: null, error: { message: "timeout" } };
      return {
        data: [notice("em-1", { channel: "email", recipient: "accounts@example.com" })],
        error: null,
      };
    });
    const send = vi.fn();
    const counts = await drainEmailNotices(db.supabase, 20, { send: send as never, now: () => T0 });
    expect(counts.skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(db.ops.filter((o) => o.kind === "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("23505 on the sent-mark is treated as already sent", () => {
  it("WhatsApp: another drain sent the invoice meanwhile → the row is closed as skipped, never sent again", async () => {
    const w = world([
      notice("wa-a"),
      notice("wa-b", { created_at: new Date(T0 - 2 * MIN).toISOString() }),
    ]);
    w.approveTemplate();
    // Between this drain's check and its mark, another drain sends wa-a.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      const res = await realFetch(u, init);
      const other = w.rows("billing_notifications").find((n) => n["id"] === "wa-a")!;
      if (other["status"] === "queued")
        Object.assign(other, { status: "sent", sent_at: new Date().toISOString() });
      return res;
    });
    const first = await drainBillingNotifications(w.supabase);
    // wa-b (older) went out and was refused by the index; wa-a was closed by the pre-send check.
    expect(first.failed).toBe(0);
    expect(w.notices().find((n) => n["id"] === "wa-b")).toMatchObject({
      status: "skipped",
      error: "already_sent",
    });
    expect(w.notices().find((n) => n["id"] === "wa-a")).toMatchObject({ status: "sent" });
    const calls = w.metaCalls.length;

    // Later drains: neither row is pending, nothing goes out again.
    await w.drains(T0 + 20 * MIN);
    await w.drains(T0 + 24 * 60 * MIN);
    expect(w.metaCalls).toHaveLength(calls);
  });

  it("email: a 23505 on 'sent' is no failure — no attempt is added, the row is closed", async () => {
    const db = fakeDb((op) => {
      if (op.table === "billing_notifications" && op.kind === "select")
        return {
          data: [notice("em-1", { channel: "email", recipient: "accounts@example.com" })],
          error: null,
        };
      if (op.table === "billing_notifications" && op.kind === "update" && op.select)
        return { data: [{ id: "em-1" }], error: null };
      if (
        op.table === "billing_notifications" &&
        op.kind === "update" &&
        (op.payload as Row)["status"] === "sent"
      )
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (op.table === "organizations") return { data: { name: "Growth Co" }, error: null };
      if (op.table === "invoices")
        return { data: { invoice_number: NUMBER, total: 2950, pdf_path: null }, error: null };
      return undefined;
    });
    const send = vi.fn(async () => ({ ok: true, id: "email_1" }));
    const counts = await drainEmailNotices(db.supabase, 20, { send: send as never, now: () => T0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ sent: 1, failed: 0 });
    const writes = db.ops
      .filter((o) => o.table === "billing_notifications" && o.kind === "update" && !o.select)
      .map((o) => o.payload as Row);
    expect(writes.map((p) => [p["status"], p["error"]])).toEqual([
      ["sent", null],
      ["skipped", "already_sent"],
    ]);
    expect(writes.some((p) => p["status"] === "failed")).toBe(false);
  });

  it("writeNoticeOutcome: 23505 only matters for 'sent'; another failed write is tried once more", async () => {
    let n = 0;
    const flaky = fakeDb((op) =>
      op.kind === "update" && n++ === 0 ? { data: null, error: { message: "timeout" } } : undefined,
    );
    expect(await writeNoticeOutcome(flaky.supabase, "x", { status: "sent" })).toBe("written");
    expect(flaky.ops).toHaveLength(2);

    const dup = fakeDb((op) =>
      op.kind === "update" && (op.payload as Row)["status"] === "sent"
        ? { data: null, error: { code: "23505", message: "dup" } }
        : undefined,
    );
    expect(await writeNoticeOutcome(dup.supabase, "x", { status: "sent", sent_at: "t" })).toBe(
      "already_sent",
    );
    expect(dup.ops.map((o) => (o.payload as Row)["status"])).toEqual(["sent", "skipped"]);
    expect(dup.has(dup.ops[1]!, "eq", "id", "x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the index migration", () => {
  const sql = readFileSync(
    "supabase/aidwar-migrations/20261083_batch28_invoice_notice_once.sql",
    "utf8",
  );
  it("idempotent, not applied, short lock timeout, sent invoice rows from 9 Oct only", () => {
    expect(sql).toMatch(/NOT applied/);
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
    expect(sql).toMatch(/RESET lock_timeout;/);
    expect(sql).toMatch(
      /create unique index if not exists billing_notifications_invoice_sent_uidx\s+on public\.billing_notifications \(organization_id, channel, \(payload->>'invoice_id'\)\)/,
    );
    expect(sql).toMatch(/where kind = 'invoice_issued'\s+and status = 'sent'/);
    expect(sql).toMatch(/created_at >= '2026-10-09T00:00:00\+05:30'::timestamptz/);
    // The duplicate and pg_indexes checks are comments only; nothing is deleted.
    expect(sql).not.toMatch(/^\s*delete\b/im);
    expect(sql).toMatch(/--\s+having count\(\*\) > 1/);
    expect(sql).toMatch(/--\s+from pg_indexes/);
  });
});
