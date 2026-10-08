import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "./test-support/memory-db";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 23 — an invoice is delivered once.
 *
 * 7 Oct 2026, 10:36–10:40 UTC: five "Issue pending" runs (admin billing →
 * issue_pending_invoices → issuePendingInvoices). The first filed the missing
 * PDFs of AD/2026-27/00011–00014; every run's fourth sweep then called
 * deliverInvoice for each invoice still carrying whatsapp_error, and each
 * call queued one WhatsApp and (00013) one email invoice_issued notice.
 *
 *  (1) rendering / re-rendering never delivers; delivery is its own step
 *  (2) at most one invoice_issued notice per invoice and channel automatically
 *  (3) a super admin's resend is explicit, confirmed and logged with the actor
 *  (4) the backfill's PDF retry re-renders only
 *  (5) the WhatsApp drain reads WhatsApp rows only
 */

const h = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  renders: 0,
}));

vi.mock("@/lib/invoice-pdf.server", () => ({
  renderInvoicePdf: async () => {
    h.renders += 1;
    return new Uint8Array([37, 80, 68, 70]);
  },
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ phoneNumberId: "pn", accessToken: "tok" }),
  sendCampaignTemplate: async (_db: unknown, _org: string, _sender: unknown, to: Record<string, unknown>) => {
    h.sends.push(to);
    return { messageId: `wamid.${h.sends.length}`, error: null };
  },
}));

import {
  deliverInvoice,
  ensureInvoicePdf,
  issueInvoice,
  issuePendingInvoices,
  resendInvoice,
} from "./invoices.server";
import { notify } from "./billing.server";
import { drainBillingNotifications } from "./billing-notify.server";

beforeEach(() => {
  h.sends.length = 0;
  h.renders = 0;
  vi.stubEnv("PLATFORM_ORG_ID", "platform-org");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORG = "org-zoori";
const invoiceRow = (id: string, number: string, extra: Row = {}): Row => ({
  id,
  organization_id: ORG,
  invoice_number: number,
  kind: "tax_invoice",
  purpose: "credit_purchase",
  status: "paid",
  total: 2950,
  pdf_path: `${ORG}/${number.replace(/\//g, "-")}.pdf`,
  pdf_error: null,
  sent: { whatsapp_error: "template_missing" },
  buyer_snapshot: { billing_email: "accounts@example.com" },
  created_at: "2026-10-01T19:00:00Z",
  updated_at: "2026-10-01T19:00:01Z",
  ...extra,
});

/** The live state at 10:36: four numbered invoices, client_invoice_issued still PENDING. */
function world(invoices: Row[], templateStatus = "PENDING") {
  const db = memoryDb({
    invoices,
    invoice_lines: invoices.map((i) => ({ id: `l-${String(i["id"])}`, invoice_id: i["id"], line_no: 1 })),
    payments: [],
    billing_notifications: [],
    activity_log: [],
    organizations: [
      { id: ORG, name: "Zoori", billing_accounts: { billing_whatsapp: "+919800000001" } },
    ],
    message_templates: [
      { organization_id: "platform-org", name: "client_invoice_issued", language: "en", status: templateStatus, components: null },
    ],
  });
  const uploads: string[] = [];
  Object.assign(db.supabase, {
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://files.example/${path}` } }),
      }),
    },
  });
  const notices = (channel?: string) =>
    db.rows("billing_notifications").filter((n) => !channel || n["channel"] === channel);
  return { ...db, uploads, notices };
}

// ------------------------------------------------------------------ (1) + (4)
describe("(1)/(4) rendering never delivers", () => {
  it("admin re-render (ensureInvoicePdf force) files the PDF and queues nothing, sends nothing", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")]);
    const path = await ensureInvoicePdf(w.supabase, "inv-13", { force: true });
    expect(path).toBe(`${ORG}/AD-2026-27-00013.pdf`);
    expect(h.renders).toBe(1);
    expect(w.uploads).toEqual([`${ORG}/AD-2026-27-00013.pdf`]);
    expect(w.notices()).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it("the 7 Oct run, five times: missing PDFs are filed once, nothing is queued or sent by any run", async () => {
    const numbers = ["00011", "00012", "00013", "00014"];
    const w = world(numbers.map((n) => invoiceRow(`inv-${n}`, `AD/2026-27/${n}`, { pdf_path: null })));
    for (let run = 0; run < 5; run++) {
      const result = await issuePendingInvoices(w.supabase);
      expect(result.failed).toEqual([]);
      if (run === 0) expect(result.pdfs_regenerated).toHaveLength(4);
      else expect(result.pdfs_regenerated).toEqual([]);
      expect(result).not.toHaveProperty("delivered");
    }
    expect(h.renders).toBe(4);
    expect(w.notices()).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    // updated_at, sent untouched: only pdf_path / pdf_error were written.
    for (const inv of w.rows("invoices")) expect(inv["sent"]).toEqual({ whatsapp_error: "template_missing" });
  });

  it("an invoice already carrying a PDF and whatsapp_error is left alone by the backfill (no 4th sweep)", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")], "APPROVED");
    await issuePendingInvoices(w.supabase);
    expect(h.renders).toBe(0);
    expect(w.notices()).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it("a numbered invoice passed to issueInvoice is returned untouched: no render, no delivery", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")], "APPROVED");
    const r = await issueInvoice(w.supabase, "inv-13", { deliver: true });
    expect(r).toEqual({ invoice_number: "AD/2026-27/00013", pdf_path: `${ORG}/AD-2026-27-00013.pdf` });
    expect(h.renders).toBe(0);
    expect(h.sends).toHaveLength(0);
    expect(w.notices()).toHaveLength(0);
  });

  it("source: the render functions never reach a sender, and every issueInvoice call states deliver", () => {
    const src = readFileSync("src/lib/invoices.server.ts", "utf8");
    const body = (name: string) => {
      const start = src.indexOf(`function ${name}(`);
      const end =
        ["\nexport ", "\nasync function ", "\n/**"]
          .map((marker) => src.indexOf(marker, start + 1))
          .filter((i) => i > start)
          .sort((a, b) => a - b)[0] ?? src.length;
      return src.slice(start, end);
    };
    for (const fn of ["storeInvoicePdf", "ensureInvoicePdf"]) {
      expect(body(fn)).not.toMatch(/deliverInvoice|notify\(|billing_notifications|sendCampaignTemplate/);
    }
    const sweep = body("issuePendingInvoices");
    expect(sweep).not.toMatch(/deliverInvoice\(/);
    for (const file of ["src/lib/invoices.server.ts", "src/lib/billing.server.ts", "src/lib/subscriptions.server.ts", "src/lib/plan-billing.server.ts"]) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bissueInvoice\((.*)$/gm)) {
        if (m[1]!.trim() === "") continue; // the definition
        expect(m[1], `${file}: issueInvoice(${m[1]})`).toMatch(/deliver: (true|false)/);
      }
    }
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) one invoice_issued notice per invoice and channel", () => {
  it("two automatic deliveries of the same invoice queue one WhatsApp and one email notice", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013", { purpose: "plan_fee", status: "issued" })]);
    const first = await deliverInvoice(w.supabase, "inv-13", { fallbackToQueue: true });
    const second = await deliverInvoice(w.supabase, "inv-13", { fallbackToQueue: true });
    expect(first).toEqual({ ok: false, error: "template_missing" });
    expect(second).toEqual({ ok: false, error: "template_missing" });
    expect(w.notices("whatsapp")).toHaveLength(1);
    expect(w.notices("email")).toHaveLength(1);
    expect(w.notices("email")[0]).toMatchObject({ recipient: "accounts@example.com", payload: { invoice_id: "inv-13" } });
    expect(h.sends).toHaveLength(0);
  });

  it("an earlier notice already sent holds a new one; a failed one does not", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")]);
    w.rows("billing_notifications").push(
      { id: "n-sent", organization_id: ORG, kind: "invoice_issued", channel: "email", status: "sent", payload: { invoice_id: "inv-13" } },
      { id: "n-failed", organization_id: ORG, kind: "invoice_issued", channel: "whatsapp", status: "failed", payload: { invoice_id: "inv-13" } },
    );
    await deliverInvoice(w.supabase, "inv-13", { fallbackToQueue: true });
    expect(w.notices("email")).toHaveLength(1); // only the sent one
    expect(w.notices("whatsapp").map((n) => n["status"])).toEqual(["failed", "queued"]);
  });

  it("another invoice's notice holds nothing", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")]);
    w.rows("billing_notifications").push({
      id: "n-other", organization_id: ORG, kind: "invoice_issued", channel: "whatsapp", status: "queued", payload: { invoice_id: "inv-12" },
    });
    await deliverInvoice(w.supabase, "inv-13", { fallbackToQueue: true });
    expect(w.notices("whatsapp")).toHaveLength(2);
  });

  it("the guard reads by invoice id, channel and queued/sent; by number when there is no id", async () => {
    const db = fakeDb(() => undefined);
    await notify(db.supabase, {
      organizationId: ORG,
      audience: "client",
      kind: "invoice_issued",
      channel: "email",
      recipient: "accounts@example.com",
      payload: { invoice_id: "inv-13", invoice_number: "AD/2026-27/00013" },
    });
    const read = db.ops.find((o) => o.table === "billing_notifications" && o.kind === "select")!;
    expect(db.has(read, "eq", "kind", "invoice_issued")).toBe(true);
    expect(db.has(read, "eq", "channel", "email")).toBe(true);
    expect(db.has(read, "in", "status", ["queued", "sent"])).toBe(true);
    expect(db.has(read, "eq", "payload->>invoice_id", "inv-13")).toBe(true);
    expect(db.ops.filter((o) => o.kind === "insert")).toHaveLength(1);

    const byNumber = fakeDb(() => undefined);
    await notify(byNumber.supabase, {
      organizationId: ORG, audience: "client", kind: "invoice_issued", payload: { invoice_number: "AD/2026-27/00013" },
    });
    const read2 = byNumber.ops.find((o) => o.kind === "select")!;
    expect(byNumber.has(read2, "eq", "channel", "whatsapp")).toBe(true);
    expect(byNumber.has(read2, "eq", "payload->>invoice_number", "AD/2026-27/00013")).toBe(true);
  });

  it("the guard can't read → nothing queued (a super admin can resend; a buyer can't unreceive)", async () => {
    const db = fakeDb((op) => (op.kind === "select" ? { data: null, error: { message: "timeout" } } : undefined));
    await notify(db.supabase, {
      organizationId: ORG, audience: "client", kind: "invoice_issued", payload: { invoice_id: "inv-13" },
    });
    expect(db.ops.filter((o) => o.kind === "insert")).toHaveLength(0);
  });

  it("an automatic delivery never sends an invoice WhatsApp already delivered", async () => {
    const w = world(
      [invoiceRow("inv-13", "AD/2026-27/00013", { sent: { whatsapp_at: "2026-10-01T19:00:02Z", message_id: "wamid.0" } })],
      "APPROVED",
    );
    const r = await deliverInvoice(w.supabase, "inv-13", { fallbackToQueue: true });
    expect(r).toEqual({ ok: true, message_id: "wamid.0" });
    expect(h.sends).toHaveLength(0);
    expect(w.notices()).toHaveLength(0);
  });

  it("the index migration: idempotent, short lock timeout, queued rows only", () => {
    const sql = readFileSync("supabase/aidwar-migrations/20261060_invoice_notice_once.sql", "utf8");
    expect(sql).toMatch(/NOT applied/);
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
    expect(sql).toMatch(/RESET lock_timeout;/);
    expect(sql).toMatch(/create unique index if not exists billing_notifications_invoice_queued_uidx/);
    expect(sql).toMatch(/where kind = 'invoice_issued'\s+and status = 'queued'/);
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) a super admin's resend: explicit, confirmed, logged", () => {
  it("without confirmation nothing is sent and nothing is logged", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")], "APPROVED");
    const r = await resendInvoice(w.supabase, { invoiceId: "inv-13", actorId: "admin-1", confirmed: false });
    expect(r.ok).toBe(false);
    expect(h.sends).toHaveLength(0);
    expect(w.rows("activity_log")).toHaveLength(0);
  });

  it("confirmed: sends once straight away (even if sent before), queues nothing, logs the actor", async () => {
    const w = world(
      [invoiceRow("inv-13", "AD/2026-27/00013", { sent: { whatsapp_at: "2026-10-01T19:00:02Z" } })],
      "APPROVED",
    );
    const r = await resendInvoice(w.supabase, { invoiceId: "inv-13", actorId: "admin-1", confirmed: true });
    expect(r).toEqual({ ok: true, message_id: "wamid.1" });
    expect(h.sends).toHaveLength(1);
    expect(w.notices()).toHaveLength(0);
    expect(w.rows("activity_log")).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        user_id: "admin-1",
        action: "invoice_resent",
        details: expect.objectContaining({ invoice: "AD/2026-27/00013", ok: true, message_id: "wamid.1" }),
      }),
    ]);
  });

  it("a failed resend is logged too, and queues nothing", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013")]);
    const r = await resendInvoice(w.supabase, { invoiceId: "inv-13", actorId: "admin-1", confirmed: true });
    expect(r).toEqual({ ok: false, error: "template_missing" });
    expect(w.notices()).toHaveLength(0);
    expect(w.rows("activity_log")[0]).toMatchObject({ action: "invoice_resent", details: { ok: false, error: "template_missing" } });
  });

  it("a void invoice is never resent", async () => {
    const w = world([invoiceRow("inv-13", "AD/2026-27/00013", { status: "void" })], "APPROVED");
    const r = await resendInvoice(w.supabase, { invoiceId: "inv-13", actorId: "admin-1", confirmed: true });
    expect(r.ok).toBe(false);
    expect(h.sends).toHaveLength(0);
  });

  it("route + screen: resend only with confirmed:true after window.confirm; regenerate and backfill are logged", () => {
    const route = readFileSync("src/routes/api/admin/billing.ts", "utf8");
    expect(route).toMatch(/resendInvoice\(supabase, \{[\s\S]*?confirmed: payload\["confirmed"\] === true/);
    expect(route).not.toMatch(/deliverInvoice/);
    expect(route).toMatch(/logPlatformAction\("invoice_pdf_regenerated"/);
    expect(route).toMatch(/logPlatformAction\("invoices_backfill_run"/);
    const tab = readFileSync("src/components/admin/invoices-tab.tsx", "utf8");
    const i = tab.indexOf('action: "resend_invoice"');
    expect(i).toBeGreaterThan(0);
    expect(tab.slice(Math.max(0, i - 700), i)).toMatch(/window\.confirm\(/);
    expect(tab.slice(i, i + 80)).toMatch(/confirmed: true/);
  });
});

// ------------------------------------------------------------------ (5)
describe("(5) the WhatsApp drain reads WhatsApp rows only", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const notice = (id: string, extra: Row = {}): Row => ({
    id,
    organization_id: ORG,
    audience: "client",
    kind: "invoice_issued",
    channel: "whatsapp",
    recipient: "+919800000001",
    status: "queued",
    payload: { invoice_id: "inv-13", invoice_number: "AD/2026-27/00013", amount: 2950 },
    sent_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...extra,
  });
  const drainWorld = (rows: Row[], invoice: Row) => {
    const db = memoryDb({
      billing_notifications: rows,
      invoices: [invoice],
      whatsapp_accounts: [
        { id: "acc", organization_id: "platform-org", waba_id: "w", phone_number_id: "pn", display_phone_number: "91", status: "active", is_default: true },
      ],
      whatsapp_credentials: [{ organization_id: "platform-org", waba_id: "w", access_token: "tok" }],
      organizations: [{ id: ORG, name: "Zoori" }],
      message_templates: [{ organization_id: "platform-org", name: "client_invoice_issued", language: "en", status: "APPROVED" }],
    });
    return db;
  };

  it("an email row never takes a place in the batch: the query asks for channel whatsapp", async () => {
    const db = fakeDb((op) => (op.kind === "select" ? { data: [], error: null } : undefined));
    await drainBillingNotifications(db.supabase);
    const read = db.ops.find((o) => o.table === "billing_notifications" && o.kind === "select")!;
    expect(db.has(read, "eq", "channel", "whatsapp")).toBe(true);
  });

  it("an email row handed back anyway is left untouched (not sent, not written)", async () => {
    const email = notice("n-email", { channel: "email", recipient: "accounts@example.com" });
    const db = fakeDb((op) => (op.table === "billing_notifications" && op.kind === "select" ? { data: [email], error: null } : undefined));
    const fetchSpy = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchSpy);
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.ops.filter((o) => o.table === "billing_notifications" && o.kind === "update")).toHaveLength(0);
  });

  it("with 50 email rows ahead of it, a WhatsApp invoice notice is still read and sent", async () => {
    const emails = Array.from({ length: 50 }, (_, i) =>
      notice(`e-${i}`, { channel: "email", created_at: new Date(Date.now() - 3600_000 + i).toISOString() }),
    );
    const db = drainWorld([...emails, notice("n-wa")], invoiceRow("inv-13", "AD/2026-27/00013"));
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json({ messages: [{ id: "wamid" }] });
    });
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(db.rows("billing_notifications").filter((n) => n["channel"] === "email").every((n) => n["status"] === "queued")).toBe(true);
  });

  it("an invoice already on the buyer's WhatsApp (an admin resend went first) → skipped, never a second copy", async () => {
    const db = drainWorld(
      [notice("n-wa")],
      invoiceRow("inv-13", "AD/2026-27/00013", { sent: { whatsapp_at: "2026-10-07T11:00:00Z" } }),
    );
    const fetchSpy = vi.fn(async () => json({ messages: [{ id: "wamid" }] }));
    vi.stubGlobal("fetch", fetchSpy);
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rows("billing_notifications")[0]).toMatchObject({ status: "skipped", error: "already_delivered" });
  });

  it("source: the stale comment about email rows is gone", () => {
    const src = readFileSync("src/lib/billing-notify.server.ts", "utf8");
    expect(src).not.toMatch(/the email sender isn't built yet/);
  });
});
