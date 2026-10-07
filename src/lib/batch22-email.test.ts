import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 22 — platform email through Resend's HTTP API. The Resend call is
 * always stubbed here (global fetch); no key or address in this file is real.
 */

vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => null,
  sendCampaignTemplate: async () => ({ messageId: null, error: "not_used" }),
}));
vi.mock("@/lib/billing-notify.server", () => ({ resolvePlatformOrg: async () => "platform-org" }));

import { OUTSIDE_CALL_TIMEOUT_MS } from "./outside-call.server";
import {
  DEFAULT_EMAIL_FROM,
  EMAIL_ATTACHMENT_MAX_BYTES,
  RESEND_API_URL,
  emailHtml,
  sendEmail,
} from "./email.server";
import { EMAIL_NOTICE_MAX_AGE_MS, drainEmailNotices } from "./email-notices.server";

const ENV_KEYS = ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"];
const savedEnv: Record<string, string | undefined> = {};
const savedTimeout = OUTSIDE_CALL_TIMEOUT_MS.email;
const TEST_KEY = "test-key-not-real";

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  (OUTSIDE_CALL_TIMEOUT_MS as Record<string, number>)["email"] = savedTimeout;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Call = { url: string; init: RequestInit };
const urlOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError")),
    );
  });

/** Stubs fetch: Resend answers with `resend`, any other URL with `file`. */
function stubFetch(
  resend: (init: RequestInit) => Response | Promise<Response>,
  file?: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = urlOf(input);
      calls.push({ url, init });
      if (url === RESEND_API_URL) return resend(init);
      if (file) return file(url, init);
      throw new TypeError("fetch failed");
    }),
  );
  const sends = () =>
    calls
      .filter((c) => c.url === RESEND_API_URL)
      .map((c) => ({
        headers: c.init.headers as Record<string, string>,
        body: JSON.parse(String(c.init.body)) as Record<string, unknown>,
      }));
  return { calls, sends };
}

describe("sendEmail", () => {
  it("missing key: exactly the old stub — logs, no call, email_not_configured", async () => {
    const f = stubFetch(() => json({ id: "x" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await sendEmail({ to: "owner@example.com", subject: "Hi", body: "Hello" });
    expect(r).toEqual({ ok: false, error: "email_not_configured" });
    expect(f.calls).toHaveLength(0);
    expect(info).toHaveBeenCalledWith("[email:stub] would send", {
      to: "owner@example.com",
      subject: "Hi",
      attachment: null,
    });
  });

  it("success: one POST to Resend with the key, default from, text + escaped HTML; returns Resend's id", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const f = stubFetch(() => json({ id: "email_123" }));
    const r = await sendEmail({
      to: "owner@example.com",
      subject: "Line one\r\nBcc: x@y.z",
      body: 'Hello <script>alert(1)</script> & "you"\n\nSee https://aidwar.in/app/billing.',
    });
    expect(r).toEqual({ ok: true, id: "email_123" });
    const [send] = f.sends();
    expect(send!.headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(send!.body["from"]).toBe(DEFAULT_EMAIL_FROM);
    expect(send!.body["to"]).toEqual(["owner@example.com"]);
    expect(send!.body["subject"]).toBe("Line one Bcc: x@y.z"); // one line, no header tricks
    expect(send!.body["reply_to"]).toBeUndefined();
    expect(send!.body["attachments"]).toBeUndefined();
    expect(String(send!.body["text"])).toContain("Hello <script>alert(1)</script>"); // plain text stays as written
    const html = String(send!.body["html"]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;you&quot;");
    expect(html).toContain('<a href="https://aidwar.in/app/billing"');
    expect(html).not.toMatch(/<img|<script|https?:\/\/(?!aidwar\.in\/app\/billing)/i); // no pixels, no other links
  });

  it("EMAIL_FROM and EMAIL_REPLY_TO are used when set", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    process.env["EMAIL_FROM"] = "Team <team@example.com>";
    process.env["EMAIL_REPLY_TO"] = "help@example.com";
    const f = stubFetch(() => json({ id: "e" }));
    await sendEmail({ to: "a@example.com", subject: "s", body: "b", idempotencyKey: "notice-1" });
    const [send] = f.sends();
    expect(send!.body["from"]).toBe("Team <team@example.com>");
    expect(send!.body["reply_to"]).toBe("help@example.com");
    expect(send!.headers["idempotency-key"]).toBe("notice-1");
  });

  it("API error: not ok, with Resend's own error text", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    stubFetch(() =>
      json(
        {
          statusCode: 403,
          name: "validation_error",
          message: "The mail.aidwar.in domain is not verified.",
        },
        403,
      ),
    );
    const r = await sendEmail({ to: "a@example.com", subject: "s", body: "b" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Resend 403 validation_error: The mail.aidwar.in domain is not verified.");
  });

  it("timeout: a failure (email_timeout), never left hanging", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    (OUTSIDE_CALL_TIMEOUT_MS as Record<string, number>)["email"] = 30;
    stubFetch((init) => hang(init));
    const r = await sendEmail({ to: "a@example.com", subject: "s", body: "b" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^email_timeout: /);
  });

  it("unreachable: a failure, not a throw", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    const r = await sendEmail({ to: "a@example.com", subject: "s", body: "b" });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/^email_unreachable: /);
  });

  it("a bad address never reaches Resend", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const f = stubFetch(() => json({ id: "e" }));
    expect(await sendEmail({ to: "not an address", subject: "s", body: "b" })).toEqual({
      ok: false,
      error: "invalid_recipient",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("attachment: fetched server-side and attached as base64", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const pdf = new TextEncoder().encode("%PDF-1.4 test");
    const f = stubFetch(
      () => json({ id: "e" }),
      () => new Response(pdf, { status: 200 }),
    );
    const r = await sendEmail({
      to: "a@example.com",
      subject: "Invoice",
      body: "Attached.",
      attachmentUrl: "https://files.example.com/inv.pdf?token=t",
      attachmentName: "INV/2026/0001.pdf",
    });
    expect(r).toEqual({ ok: true, id: "e", attachment: "attached" });
    const [send] = f.sends();
    expect(send!.body["attachments"]).toEqual([
      { filename: "INV-2026-0001.pdf", content: btoa("%PDF-1.4 test") },
    ]);
    expect(String(send!.body["text"])).not.toContain("https://files.example.com");
  });

  it("attachment fetch failure: sends without it, with the link in the body", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const link = "https://files.example.com/inv.pdf?token=t";
    for (const file of [
      () => new Response("gone", { status: 404 }),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      const f = stubFetch(() => json({ id: "e" }), file);
      const r = await sendEmail({
        to: "a@example.com",
        subject: "Invoice",
        body: "Your invoice.",
        attachmentUrl: link,
      });
      expect(r).toEqual({ ok: true, id: "e", attachment: "linked" });
      const [send] = f.sends();
      expect(send!.body["attachments"]).toBeUndefined();
      expect(String(send!.body["text"])).toContain(`Download the file here: ${link}`);
      expect(String(send!.body["html"])).toContain("https://files.example.com/inv.pdf?token=t");
    }
  });

  it("attachment over the size cap (or not https) goes as a link", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const big = stubFetch(
      () => json({ id: "e" }),
      () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(EMAIL_ATTACHMENT_MAX_BYTES + 1) },
        }),
    );
    expect(
      (
        await sendEmail({
          to: "a@example.com",
          subject: "s",
          body: "b",
          attachmentUrl: "https://files.example.com/big.pdf",
        })
      ).attachment,
    ).toBe("linked");
    expect(big.sends()[0]!.body["attachments"]).toBeUndefined();

    const plain = stubFetch(
      () => json({ id: "e" }),
      () => new Response("x"),
    );
    expect(
      (
        await sendEmail({
          to: "a@example.com",
          subject: "s",
          body: "b",
          attachmentUrl: "http://files.example.com/a.pdf",
        })
      ).attachment,
    ).toBe("linked");
    expect(plain.calls.map((c) => c.url)).toEqual([RESEND_API_URL]); // the http file was never fetched
  });

  it("one shared layout with no industry wording", () => {
    const html = emailHtml("Subject", "Body");
    expect(html).toContain("AiDwar");
    expect(html).toContain("This is an automatic notice from AiDwar.");
    const src = readFileSync(new URL("./email.server.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\b(salon|clinic|restaurant|boutique|jewell?er|real estate|textile)/i);
    expect(src).not.toMatch(/re_[A-Za-z0-9]{10,}/); // no key in code
  });
});

// ------------------------------------------------------------ email notices

const NOW = Date.parse("2026-10-07T10:00:00Z");

function noticeWorld(rows: Record<string, unknown>[], opts: { claim?: boolean } = {}) {
  const db = fakeDb((op) => {
    if (op.table === "billing_notifications" && op.kind === "select")
      return { data: rows, error: null };
    if (op.table === "billing_notifications" && op.kind === "update" && op.select)
      return { data: opts.claim === false ? [] : [{ id: "n" }], error: null };
    if (op.table === "organizations") return { data: { name: "Sharma Textiles" }, error: null };
    if (op.table === "invoices")
      return {
        data: { invoice_number: "AID/2026/0042", total: 1180, pdf_path: "org/inv-42.pdf" },
        error: null,
      };
    return undefined;
  });
  const signed: Array<[string, number]> = [];
  (db.supabase as unknown as Record<string, unknown>)["storage"] = {
    from: () => ({
      createSignedUrl: async (path: string, seconds: number) => (
        signed.push([path, seconds]),
        { data: { signedUrl: `https://files.example.com/${path}?token=t` }, error: null }
      ),
    }),
  };
  const marks = () =>
    db.ops
      .filter((o) => o.table === "billing_notifications" && o.kind === "update" && !o.select)
      .map((o) => o.payload as Record<string, unknown>);
  return { ...db, signed, marks };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  organization_id: "org-1",
  audience: "client",
  kind: "invoice_issued",
  channel: "email",
  recipient: "accounts@example.com",
  payload: { invoice_id: "inv-42", invoice_number: "AID/2026/0042", amount: 1180 },
  status: "queued",
  sent_at: null,
  created_at: new Date(NOW - 3600_000).toISOString(),
  ...over,
});

describe("drainEmailNotices (billing notices with channel email)", () => {
  it("missing key: does nothing at all — rows stay queued as before", async () => {
    const w = noticeWorld([row()]);
    const send = vi.fn();
    expect(await drainEmailNotices(w.supabase, 20, { send, now: () => NOW })).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      expired: 0,
    });
    expect(w.ops).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a notice older than 48 h is never sent: marked skipped, expired", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const w = noticeWorld([
      row({ created_at: new Date(NOW - EMAIL_NOTICE_MAX_AGE_MS - 60_000).toISOString() }),
    ]);
    const send = vi.fn();
    const counts = await drainEmailNotices(w.supabase, 20, { send, now: () => NOW });
    expect(counts.expired).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(w.marks()).toEqual([
      expect.objectContaining({ status: "skipped", error: "expired_48h" }),
    ]);
  });

  it("a fresh invoice notice: claimed, sent with the PDF, idempotent, outcome recorded", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const w = noticeWorld([row()]);
    const send = vi.fn(async () => ({ ok: true, id: "email_9", attachment: "attached" as const }));
    const counts = await drainEmailNotices(w.supabase, 20, { send, now: () => NOW });
    expect(counts).toEqual({ sent: 1, failed: 0, skipped: 0, expired: 0 });
    expect(w.signed).toEqual([["org/inv-42.pdf", 7 * 86_400]]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "accounts@example.com",
        subject: "Your AiDwar invoice AID/2026/0042 for Sharma Textiles",
        attachmentUrl: "https://files.example.com/org/inv-42.pdf?token=t",
        attachmentName: "AID-2026-0042.pdf",
        idempotencyKey: "billing-notice-n1",
      }),
    );
    expect(w.marks()).toEqual([
      expect.objectContaining({
        status: "sent",
        error: null,
        payload: expect.objectContaining({ email_id: "email_9", attachment: "attached" }),
      }),
    ]);
  });

  it("Resend refuses: marked failed with its error text and one more attempt", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const w = noticeWorld([row()]);
    const send = vi.fn(async () => ({
      ok: false,
      error: "Resend 422 validation_error: Invalid `to` field.",
    }));
    const counts = await drainEmailNotices(w.supabase, 20, { send, now: () => NOW });
    expect(counts.failed).toBe(1);
    expect(w.marks()).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Resend 422 validation_error: Invalid `to` field.",
        payload: expect.objectContaining({ attempts: 1 }),
      }),
    ]);
  });

  it("another drain holds the claim: not sent twice", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const w = noticeWorld([row()], { claim: false });
    const send = vi.fn();
    expect((await drainEmailNotices(w.supabase, 20, { send, now: () => NOW })).skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("retries stop after three failed attempts", async () => {
    process.env["RESEND_API_KEY"] = TEST_KEY;
    const w = noticeWorld([row({ status: "failed", payload: { attempts: 3 } })]);
    const send = vi.fn();
    await drainEmailNotices(w.supabase, 20, { send, now: () => NOW });
    expect(send).not.toHaveBeenCalled();
    expect(w.marks()).toEqual([]);
  });
});

// ------------------------------------------------------------- callers

describe("every caller records the real outcome", () => {
  it("hand-off alert email fallback: the failure reason is on the outcome", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const world = fakeDb((op) => {
      if (op.table === "organization_ai_settings")
        return {
          data: {
            handoff_alert_phones: [],
            handoff_alert_email: "team@example.com",
            handoff_alert_hours: null,
          },
          error: null,
        };
      if (op.table === "whatsapp_accounts") return { data: [], error: null };
      if (op.table === "organizations") return { data: { name: "Zoori" }, error: null };
      if (op.table === "organization_members") return { data: [], error: null };
      if (op.table === "conversations" && op.kind === "select")
        return { data: { contacts: { name: "Asha", phone: "+919800000001" } }, error: null };
      return undefined;
    });
    const args = { organizationId: "org-1", conversationId: "c1", reason: "asked_for_person" };
    const failed = await sendHandoffAlert(world.supabase, args, {
      sendEmail: async () => ({ ok: false, error: "Resend 403: domain not verified" }),
    });
    expect(failed).toMatchObject({
      email: null,
      email_error: "Resend 403: domain not verified",
      skipped: "not_delivered",
    });

    // The default sender without a key: today's email_not_configured, recorded.
    const unset = await sendHandoffAlert(world.supabase, args);
    expect(unset).toMatchObject({ email: null, email_error: "email_not_configured" });

    const ok = await sendHandoffAlert(world.supabase, args, {
      sendEmail: async () => ({ ok: true }),
    });
    expect(ok.email).toBe("team@example.com");
    expect(ok.email_error).toBeUndefined();
  });

  it("each sendEmail caller uses the result (no fire-and-forget email)", () => {
    const callers = [
      "./handoff-alerts.server.ts",
      "./send-health.server.ts",
      "./flow-engine.server.ts",
      "./email-notices.server.ts",
      "../routes/api/admin/super-admins.ts",
    ];
    for (const f of callers) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      const bare = src.split("\n").filter((l) => /^\s*await sendEmail\(/.test(l));
      expect({ f, bare }).toEqual({ f, bare: [] });
    }
  });
});
